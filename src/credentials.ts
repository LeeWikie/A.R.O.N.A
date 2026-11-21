import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError } from './domain.js';
import { ProviderCredentialStore } from './providers/credential-store.js';

export class Credentials {
  private readonly file: string;
  private readonly retainedSecrets = new Set<string>();
  captureSecret(value: string | undefined) { if (value) this.retainedSecrets.add(value); }
  private remember(value: string | undefined) { this.captureSecret(value); return value; }
  readonly providerStore: ProviderCredentialStore;
  constructor(directory: string, identityKey?: string) { this.file = path.join(directory, 'credentials.json'); this.providerStore = new ProviderCredentialStore(directory, identityKey); }
  private read(): Record<string, string> {
    if (!fs.existsSync(this.file)) return {};
    const stat = fs.lstatSync(this.file); if (stat.isSymbolicLink() || stat.nlink > 1) throw new AppError('credential_store_redirected');
    const data: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.values(data).some(x => typeof x !== 'string')) throw new AppError('invalid_credential_store');
    for (const value of Object.values(data)) this.remember(value as string);
    return data as Record<string, string>;
  }
  get(name: string) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new AppError('invalid_credential');
    const data = this.read(); return this.remember(Object.hasOwn(data, name) ? data[name] : Object.hasOwn(process.env, name) ? process.env[name] : undefined);
  }
  secretValues(minLength=4){this.read();return [...this.retainedSecrets,...this.providerStore.secretValues(minLength)].filter(value=>value.length>=minLength);}
  list() { return Object.keys(this.read()).map(name => ({ name, configured: true })); }
  async migrateProviderKey(providerId: string, name: string) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new AppError('invalid_credential');
    const data = this.read();
    if (!Object.hasOwn(data, name) || !data[name]) throw new AppError('credential_not_found', 404);
    const result = await this.providerStore.modify(providerId, async current => current ?? { type: 'api_key', key: data[name] });
    return { providerId, configured: Boolean(result) };
  }
  set(name: string, value: string) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !value || value.length > 64_000 || /[\r\n]/.test(value)) throw new AppError('invalid_credential');
    const data = this.read(); this.remember(value); Object.defineProperty(data, name, { value, writable: true, enumerable: true, configurable: true }); const temporary = `${this.file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, this.file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return { name, configured: true };
  }
  remove(name: string) {
    if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))throw new AppError('invalid_credential');
    const data = this.read(); delete data[name]; const temporary = `${this.file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, this.file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return { name, configured: Boolean(Object.hasOwn(process.env,name)&&process.env[name]), source:Object.hasOwn(process.env,name)&&process.env[name]?'environment':null };
  }
}
export function tokenMatches(actual: string | undefined, expected: string) {
  if (!actual) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected); return a.length === b.length && timingSafeEqual(a, b);
}
