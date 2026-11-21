import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore, OAuthCredential } from '@earendil-works/pi-ai';
import { AppError } from '../domain.js';

const MAX_BYTES = 4 * 1024 * 1024;
const IDENTITY = '__shittimchest_authorization';
export interface OAuthAuthorizationIdentity { type: 'oauth'; chainId: string; principalDigest: string }
type BoundIdentity = OAuthAuthorizationIdentity & { version: 1; mac: string };
type Mutation = { providerId: string; current?: Credential; refresh?: { before: OAuthCredential; after: OAuthCredential } };
function nativeCredential(value: Credential): Credential {
  const result = structuredClone(value) as unknown as Record<string, unknown>;
  delete result[IDENTITY];
  return result as unknown as Credential;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function principal(credential: OAuthCredential): unknown {
  let claims: Record<string, unknown> = {};
  try {
    const encoded = credential.access.split('.')[1];
    if (encoded && encoded.length <= 64000) {
      const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) claims = parsed as Record<string, unknown>;
    }
  } catch { }
  const auth = claims['https://api.openai.com/auth'];
  const account = auth && typeof auth === 'object' && !Array.isArray(auth) ? auth as Record<string, unknown> : {};
  const scopes = (value: unknown) => typeof value === 'string' ? value.split(/\s+/).filter(Boolean).sort() : Array.isArray(value) && value.every(item => typeof item === 'string') ? [...value].sort() : undefined;
  return {
    accountId: credential.accountId, account_id: credential.account_id,
    clientId: credential.clientId, credentialScopes: scopes(credential.scopes ?? credential.scope),
    issuer: claims.iss, subject: claims.sub, audience: scopes(claims.aud), scopes: scopes(claims.scope ?? claims.scp),
    chatgptAccount: account.chatgpt_account_id, chatgptUser: account.chatgpt_user_id, organization: account.organization_id,
  };
}
function validProvider(id: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)) throw new AppError('invalid_auth_provider');
}
function validCredential(value: unknown): value is Credential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  if (c.type === 'oauth') return typeof c.access === 'string' && typeof c.refresh === 'string' && typeof c.expires === 'number' && Number.isFinite(c.expires);
  return c.type === 'api_key' && (c.key === undefined || typeof c.key === 'string') &&
    (c.env === undefined || (!!c.env && typeof c.env === 'object' && !Array.isArray(c.env) && Object.values(c.env).every(x => typeof x === 'string')));
}

/** App-owned Pi credentials. The lock spans refresh callbacks and the final atomic replacement. */
export class ProviderCredentialStore implements CredentialStore {
  private readonly file: string;
  private readonly identityFile: string;
  private identityKey?: string;
  private readonly mutations = new AsyncLocalStorage<Mutation>();
  private readonly retainedSecrets = new Set<string>();
  private remember(value: Credential) {
    const values = value.type === 'oauth' ? [value.access, value.refresh, ...(typeof value.accountId === 'string' ? [value.accountId] : [])] : [...(value.key ? [value.key] : []), ...Object.values(value.env ?? {})];
    for (const secret of values) if (secret) this.retainedSecrets.add(secret);
  }
  constructor(directory: string, identityKey?: string) {
    if (identityKey !== undefined && identityKey.length < 32) throw new AppError('invalid_provider_identity_key');
    this.file = path.join(directory, 'provider-credentials.json');
    this.identityFile = path.join(directory, 'provider-identity-key');
    this.identityKey = identityKey;
  }

  private signingKey(): string {
    if (this.identityKey) return this.identityKey;
    try { fs.writeFileSync(this.identityFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const link = fs.lstatSync(this.identityFile);
    if (!link.isFile() || link.isSymbolicLink() || link.nlink !== 1) throw new AppError('invalid_provider_identity_key');
    const descriptor = fs.openSync(this.identityFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 64 || stat.dev !== link.dev || stat.ino !== link.ino) throw new AppError('invalid_provider_identity_key');
      const key = fs.readFileSync(descriptor, 'utf8');
      if (!/^[a-f0-9]{64}$/.test(key)) throw new AppError('invalid_provider_identity_key');
      return this.identityKey = key;
    } finally { fs.closeSync(descriptor); }
  }
  private digest(value: unknown): string { return createHmac('sha256', this.signingKey()).update(JSON.stringify(canonical(value))).digest('hex'); }
  private boundIdentity(providerId: string, credential: Credential): BoundIdentity | undefined {
    if (credential.type !== 'oauth') return undefined;
    const raw = credential[IDENTITY];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const value = raw as BoundIdentity;
    if (value.version !== 1 || value.type !== 'oauth' || typeof value.chainId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.chainId) || !/^[a-f0-9]{64}$/.test(value.principalDigest) || !/^[a-f0-9]{64}$/.test(value.mac)) return undefined;
    const expected = this.digest([providerId, nativeCredential(credential), value.chainId, value.principalDigest]);
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(value.mac, 'hex')) ? value : undefined;
  }
  private bind(providerId: string, credential: OAuthCredential, chainId: string = randomUUID()): OAuthCredential {
    const clean = nativeCredential(credential) as OAuthCredential;
    const principalDigest = this.digest(principal(clean));
    const identity: BoundIdentity = { version: 1, type: 'oauth', chainId, principalDigest, mac: this.digest([providerId, clean, chainId, principalDigest]) };
    return { ...clean, [IDENTITY]: identity };
  }
  /** Called only around the provider's original refresh operation under the native store lock. */
  async confirmOAuthRefresh(providerId: string, current: OAuthCredential, refresh: () => Promise<OAuthCredential>): Promise<OAuthCredential> {
    const mutation = this.mutations.getStore();
    const before = structuredClone(current);
    const after = await refresh();
    if (mutation?.providerId === providerId && isDeepStrictEqual(mutation.current, before)) mutation.refresh = { before, after: structuredClone(after) };
    return after;
  }
  async authorizationIdentity(providerId: string, options?: AuthOperationOptions): Promise<OAuthAuthorizationIdentity | undefined> {
    validProvider(providerId);
    return this.locked(async (data, check) => {
      const current = data[providerId];
      if (current?.type !== 'oauth') return undefined;
      let identity = this.boundIdentity(providerId, current);
      if (!identity) {
        data[providerId] = this.bind(providerId, current);
        identity = this.boundIdentity(providerId, data[providerId]!)!;
        check(); this.write(data); check();
      }
      return { type: 'oauth', chainId: identity.chainId, principalDigest: identity.principalDigest };
    }, options);
  }

  private data(): Record<string, Credential> {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(this.file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.create(null) as Record<string, Credential>; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new AppError('credential_store_redirected');
    if (stat.size > MAX_BYTES) throw new AppError('invalid_credential_store');
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { throw new AppError('invalid_credential_store'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AppError('invalid_credential_store');
    const result: Record<string, Credential> = Object.create(null) as Record<string, Credential>;
    for (const [id, value] of Object.entries(parsed)) {
      validProvider(id);
      if (!validCredential(value)) throw new AppError('invalid_credential_store');
      this.remember(value); result[id] = value;
    }
    return result;
  }

  private write(data: Record<string, Credential>) {
    const content = JSON.stringify(data);
    if (Buffer.byteLength(content) > MAX_BYTES) throw new AppError('invalid_credential_store');
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.file);
    } finally { try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  }

  private async locked<T>(operation: (data: Record<string, Credential>, check: () => void) => Promise<T>, options?: AuthOperationOptions): Promise<T> {
    const signal = options?.signal;
    signal?.throwIfAborted();
    const deadline = Date.now() + 30_000;
    let attempts = 0, eperm = 0;
    let compromised: Error | undefined;
    let release: (() => Promise<void>) | undefined;
    while (!release) {
      signal?.throwIfAborted();
      try {
        release = await lockfile.lock(this.file, { realpath: false, stale: 30_000, retries: 0, onCompromised: error => { compromised = error; } });
      } catch (error) {
        signal?.throwIfAborted();
        const code = (error as NodeJS.ErrnoException).code;
        if ((code !== 'ELOCKED' && !(process.platform === 'win32' && code === 'EPERM')) || Date.now() >= deadline || (code === 'EPERM' && ++eperm > 5)) throw error;
        const delay = Math.min(Math.round(Math.min(10 * 2 ** attempts++, 1000) * (1 + Math.random())), Math.max(1, deadline - Date.now()));
        await sleep(delay, undefined, signal ? { signal } : undefined);
      }
    }
    const check = () => { if (compromised) throw compromised; signal?.throwIfAborted(); };
    try { check(); const data = this.data(); return await operation(data, check); }
    finally {
      try { await release(); } catch (error) { if (!compromised) throw error; }
    }
  }

  secretValues(minLength=4):string[] {
    this.data(); return [...this.retainedSecrets].filter(value => value.length >= minLength);
  }
  async read(id: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    validProvider(id); options?.signal?.throwIfAborted();
    const data = this.data(); return Object.hasOwn(data, id) ? nativeCredential(data[id]!) : undefined;
  }
  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return Object.entries(this.data()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }
  async modify(id: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    validProvider(id);
    return this.locked(async (data, check) => {
      const stored = Object.hasOwn(data, id) ? data[id] : undefined;
      const current = stored === undefined ? undefined : nativeCredential(stored);
      const mutation: Mutation = { providerId: id, current };
      return this.mutations.run(mutation, async () => {
        const next = await fn(current === undefined ? undefined : structuredClone(current));
        check();
        if (next === undefined) return current;
        if (!validCredential(next)) throw new AppError('invalid_credential');
        const clean = nativeCredential(next);
        if (clean.type === 'oauth') {
          const previous = stored && this.boundIdentity(id, stored);
          const refresh = mutation.refresh;
          const proved = previous && (isDeepStrictEqual(clean, current) || (refresh && isDeepStrictEqual(refresh.before, current) && isDeepStrictEqual(refresh.after, clean) && this.digest(principal(clean)) === previous.principalDigest));
          data[id] = this.bind(id, clean, proved ? previous.chainId : undefined);
        } else data[id] = clean;
        this.remember(clean); this.write(data); check();
        return structuredClone(clean);
      });
    }, options);
  }
  async delete(id: string, options?: AuthOperationOptions): Promise<void> {
    validProvider(id);
    await this.locked(async (data, check) => { check(); if (Object.hasOwn(data, id)) { delete data[id]; this.write(data); check(); } }, options);
  }
}
