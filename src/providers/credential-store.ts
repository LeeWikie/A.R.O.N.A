import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';
import { AppError } from '../domain.js';

const MAX_BYTES = 4 * 1024 * 1024;
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
  constructor(directory: string) { this.file = path.join(directory, 'provider-credentials.json'); }

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
      result[id] = value;
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

  secretValues():string[] {
    return Object.values(this.data()).flatMap(value=>value.type==='oauth'?[value.access,value.refresh,...(typeof value.accountId==='string'?[value.accountId]:[])]:[...(value.key?[value.key]:[]),...Object.values(value.env??{})]).filter(value=>value.length>=4);
  }
  async read(id: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    validProvider(id); options?.signal?.throwIfAborted();
    const data = this.data(); return Object.hasOwn(data, id) ? data[id] : undefined;
  }
  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return Object.entries(this.data()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }
  async modify(id: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    validProvider(id);
    return this.locked(async (data, check) => {
      const current = Object.hasOwn(data, id) ? data[id] : undefined;
      const next = await fn(current === undefined ? undefined : structuredClone(current));
      check();
      if (next === undefined) return current;
      if (!validCredential(next)) throw new AppError('invalid_credential');
      data[id] = next; this.write(data); check();
      return structuredClone(next);
    }, options);
  }
  async delete(id: string, options?: AuthOperationOptions): Promise<void> {
    validProvider(id);
    await this.locked(async (data, check) => { check(); if (Object.hasOwn(data, id)) { delete data[id]; this.write(data); check(); } }, options);
  }
}
