import { createHash,createHmac,timingSafeEqual, randomUUID } from 'node:crypto';
import { MCPClient, MCPOAuthClientProvider, getCallbackUrlCandidates, type OAuthStorage } from '@mastra/mcp';
import { z } from 'zod';
import { Credentials } from '../credentials.js';
import { AppError } from '../domain.js';

export const mcpOAuthSchema = z.object({
  clientId: z.string().min(1).max(1024).optional(),
  clientMetadataUrl: z.url().optional(),
  clientSecretEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  scopes: z.array(z.string().min(1).max(256).regex(/^[^\s]+$/)).max(32).default([]),
  redirectPort: z.number().int().min(1).max(65525).default(5533),
}).strict().superRefine((value, context) => {
  if (Boolean(value.clientId) === Boolean(value.clientMetadataUrl) || value.clientSecretEnv && !value.clientId) context.addIssue({ code: 'custom', message: 'A single OAuth client identity is required.' });
  if (value.clientMetadataUrl) { const url = new URL(value.clientMetadataUrl); if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.pathname === '/') context.addIssue({ code: 'custom', message: 'Invalid client metadata URL.' }); }
});
export type MCPOAuthConfiguration = z.infer<typeof mcpOAuthSchema>;
export type MCPOAuthJobStatus = 'starting' | 'awaiting-authorization' | 'succeeded' | 'failed' | 'cancelled';
export interface MCPOAuthJob { id: string; serverId: string; status: MCPOAuthJobStatus; authorizationUrl?: string; error?: string; createdAt: string }

const serverStoragePrefix = (serverId: string) => 'MCP_OAUTH_' + createHash('sha256').update(serverId).digest('hex').toUpperCase() + '_';
const identityField='host_authorization_identity';
const tokenFields=(values:Map<string,string>)=>[...values].filter(([name])=>name==='tokens'||name.startsWith('tokens:'));
function principal(values:Map<string,string>){
  const found=new Set<string>();for(const [name,text]of tokenFields(values))try{
    const token=JSON.parse(text),claims:unknown[]=[];
    for(const value of [token.access_token,token.id_token])if(typeof value==='string'&&value.split('.').length===3)try{claims.push(JSON.parse(Buffer.from(value.split('.')[1]!,'base64url').toString('utf8')));}catch{}
    const stable=(value:Record<string,unknown>)=>Object.fromEntries(['iss','sub','aud','account_id','tenant_id','scope','scp'].flatMap(key=>value[key]===undefined?[]:[[key,typeof value[key]==='string'&&['scope','scp'].includes(key)?String(value[key]).split(/\s+/).filter(Boolean).sort():Array.isArray(value[key])?[...value[key] as unknown[]].sort():value[key]]]));
    const attributes=stable(token);if(name.startsWith('tokens:'))attributes.issuer=decodeURIComponent(name.slice(7));if(Object.keys(attributes).length)found.add(JSON.stringify(attributes));
    for(const value of claims)if(value&&typeof value==='object'&&!Array.isArray(value)){const attributes=stable(value as Record<string,unknown>);if(Object.keys(attributes).length)found.add(JSON.stringify(attributes));}
  }catch{}return [...found].sort();
}
class CredentialOAuthStorage implements OAuthStorage {
  private active = true;
  private readonly prefix: string;
  private pending?: Map<string, string>;
  constructor(private readonly credentials: Credentials, serverId: string, namespace: string, private readonly capture: (value: string) => void,private readonly identityKey:string) {
    this.prefix = serverStoragePrefix(serverId) + createHash('sha256').update(namespace).digest('hex').toUpperCase() + '_';
  }
  private get storageKey() { return this.prefix + 'STATE'; }
  private read(): Map<string, string> {
    const value = this.credentials.get(this.storageKey);
    if (!value) return new Map();
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(field => typeof field !== 'string')) throw new AppError('invalid_mcp_oauth_store');
    return new Map(Object.entries(parsed));
  }
  private save(values: Map<string, string>) { this.credentials.set(this.storageKey, JSON.stringify(Object.fromEntries(values))); }
  private digest(value:unknown){return createHmac('sha256',this.identityKey).update(JSON.stringify([this.prefix,value])).digest('hex');}
  private material(values:Map<string,string>){return [...values].filter(([name])=>name!==identityField).sort(([a],[b])=>a.localeCompare(b));}
  private verified(values:Map<string,string>):{chainId:string;principalDigest:string}|undefined{
    try{const row=JSON.parse(values.get(identityField)??'null');if(!row||row.version!==1||typeof row.chainId!=='string'||typeof row.principalDigest!=='string'||typeof row.mac!=='string')return;const expected=this.digest({chainId:row.chainId,principalDigest:row.principalDigest,material:this.material(values)});const mac=Buffer.from(row.mac,'hex'),wanted=Buffer.from(expected,'hex');if(mac.length!==wanted.length||!timingSafeEqual(mac,wanted))return;return {chainId:row.chainId,principalDigest:row.principalDigest};}catch{return;}
  }
  private authorize(previous:Map<string,string>,next:Map<string,string>,rotate=false){
    if(!tokenFields(next).length){next.delete(identityField);return;}
    const identity=this.verified(previous),principalDigest=this.digest(principal(next));const chainId=!rotate&&identity?.principalDigest===principalDigest?identity.chainId:randomUUID();
    next.set(identityField,JSON.stringify({version:1,chainId,principalDigest,mac:this.digest({chainId,principalDigest,material:this.material(next)})}));
  }
  authorizationIdentity(){const values=this.read();if(!tokenFields(values).length)return {type:'unauthorized' as const};const identity=this.verified(values);return identity?{type:'oauth' as const,...identity}:{type:'unproven' as const,materialDigest:this.digest(this.material(values))};}
  rotateIdentity(){const previous=this.pending??this.read(),next=new Map(previous);this.authorize(previous,next,true);if(this.pending)this.pending=next;else this.save(next);}
  private remember(value: string | undefined) {
    if (!value) return;
    this.capture(value);
    try {
      const visit = (data: unknown) => { if (data && typeof data === 'object') for (const [key, field] of Object.entries(data)) { if (typeof field === 'string' && /token|secret|verifier/i.test(key)) this.capture(field); else if (field && typeof field === 'object') visit(field); } };
      visit(JSON.parse(value));
    } catch { /* Opaque verifier values are captured above. */ }
  }
  get(key: string) { if (!this.active) return; const value = (this.pending ?? this.read()).get(key); this.remember(value); return value; }
  set(key: string, value: string) { if (!this.active) throw new AppError('mcp_authentication_superseded', 409); this.remember(value); const previous=this.pending??this.read(),values=new Map(previous);values.set(key,value);this.authorize(previous,values);if(this.pending)this.pending=values;else this.save(values); }
  delete(key: string) { const previous=this.pending??this.read(),values=new Map(previous);values.delete(key);this.authorize(previous,values);if(this.pending)this.pending=values;else this.save(values); }
  clear() { this.pending = undefined; this.credentials.remove(this.storageKey); }
  begin() { if (!this.active) throw new AppError('mcp_authentication_superseded', 409); this.pending = this.read(); }
  commit() { if (!this.active) throw new AppError('mcp_authentication_superseded', 409); if (this.pending) { this.save(this.pending); this.pending = undefined; } }
  rollback() { this.pending = undefined; }
  dispose() { this.active = false; }
}

interface ProviderEntry { scope: string; provider: MCPOAuthClientProvider; storage: CredentialOAuthStorage }
interface PendingJob { public: MCPOAuthJob; client: MCPClient; serverName: string; entry: ProviderEntry; settled: Promise<void>;authorizationStarted:boolean }

export class MCPOAuthJobs {
  private readonly credentials: Credentials;
  private readonly providers = new Map<string, ProviderEntry>();
  private readonly jobs = new Map<string, PendingJob>();
  private readonly active = new Map<string, string>();
  constructor(directory: string, private readonly credential: (name: string) => string | undefined, private readonly capture: (value: string) => void,private readonly identityKey:string) { this.credentials = new Credentials(directory); }
  authorizationIdentity(serverId:string,scope:string){const current=this.providers.get(serverId);return current?.scope===scope?current.storage.authorizationIdentity():new CredentialOAuthStorage(this.credentials,serverId,scope,this.capture,this.identityKey).authorizationIdentity();}
  activeJob(serverId:string){const job=this.jobs.get(this.active.get(serverId)??'');return job&&['starting','awaiting-authorization'].includes(job.public.status)?this.view(job.public):undefined;}

  provider(serverId: string, configuration: MCPOAuthConfiguration, scope: string): MCPOAuthClientProvider {
    const current = this.providers.get(serverId);
    if (current?.scope === scope) return current.provider;
    current?.storage.dispose();
    const storage = new CredentialOAuthStorage(this.credentials, serverId, scope, this.capture,this.identityKey);
    const redirect = `http://127.0.0.1:${configuration.redirectPort}/oauth/mcp/${encodeURIComponent(serverId)}/callback`;
    const secret = configuration.clientSecretEnv ? this.credential(configuration.clientSecretEnv) : undefined;
    if (configuration.clientSecretEnv && !secret) throw new AppError('mcp_credentials_unavailable');
    if (secret) this.capture(secret);
    const provider = new MCPOAuthClientProvider({
      redirectUrl: redirect,
      clientMetadata: { client_name: 'ShittimChest', redirect_uris: getCallbackUrlCandidates(redirect).map(url => url.href), grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: secret ? 'client_secret_post' : 'none', ...(configuration.scopes.length ? { scope: configuration.scopes.join(' ') } : {}) },
      ...(configuration.clientId ? { clientInformation: { client_id: configuration.clientId, ...(secret ? { client_secret: secret } : {}) } } : { clientMetadataUrl: configuration.clientMetadataUrl! }),
      storage,
      onRedirectToAuthorization: url => {
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new AppError('invalid_mcp_authorization_url');
        const job = this.jobs.get(this.active.get(serverId) ?? '');
        if (job?.entry.provider === provider && ['starting', 'awaiting-authorization'].includes(job.public.status)) { job.authorizationStarted=true;job.public.status = 'awaiting-authorization'; job.public.authorizationUrl = url.href; }
      },
    });
    this.providers.set(serverId, { scope, provider, storage });
    return provider;
  }

  start(serverId: string, client: MCPClient, serverName: string, onSuccess: () => Promise<void>): MCPOAuthJob {
    const entry = this.providers.get(serverId); if (!entry) throw new AppError('mcp_oauth_not_configured', 409);
    const existing = this.jobs.get(this.active.get(serverId) ?? '');
    if (existing && ['starting', 'awaiting-authorization'].includes(existing.public.status)) return this.view(existing.public);
    if (this.jobs.size >= 100) { const retired = [...this.jobs].find(([, job]) => ['succeeded', 'failed', 'cancelled'].includes(job.public.status)); if (retired) this.jobs.delete(retired[0]); else throw new AppError('mcp_authentication_busy', 409); }
    const job: PendingJob = { public: { id: randomUUID(), serverId, status: 'starting', createdAt: new Date().toISOString() }, client, serverName, entry, settled: Promise.resolve(),authorizationStarted:false };
    entry.storage.begin();
    this.jobs.set(job.public.id, job); this.active.set(serverId, job.public.id);
    const cancelled = () => job.public.status === 'cancelled';
    job.settled = Promise.resolve().then(async () => {
      try {
        if (cancelled()) return;
        await client.authenticate(serverName, { timeoutMs: 5 * 60_000 });
        if (cancelled() || this.providers.get(serverId) !== entry) return;
        if(job.authorizationStarted)entry.storage.rotateIdentity();
        entry.storage.commit();
        await onSuccess();
        if (!cancelled()) job.public.status = 'succeeded';
      } catch (error) {
        if (!cancelled()) { job.public.status = 'failed'; job.public.error = error instanceof AppError ? error.code : 'mcp_authentication_failed'; }
      } finally { if (job.public.status !== 'succeeded') entry.storage.rollback(); delete job.public.authorizationUrl; if (this.active.get(serverId) === job.public.id) this.active.delete(serverId); }
    });
    return this.view(job.public);
  }
  private view(job: MCPOAuthJob): MCPOAuthJob { return { ...job }; }
  get(id: string): MCPOAuthJob { const job = this.jobs.get(id); if (!job) throw new AppError('mcp_authentication_not_found', 404); return this.view(job.public); }
  async cancel(id: string): Promise<MCPOAuthJob> {
    const job = this.jobs.get(id); if (!job) throw new AppError('mcp_authentication_not_found', 404);
    if (['starting', 'awaiting-authorization'].includes(job.public.status)) {
      job.public.status = 'cancelled'; delete job.public.authorizationUrl;
      job.entry.storage.rollback(); job.entry.storage.dispose();
      if (this.providers.get(job.public.serverId) === job.entry) this.providers.delete(job.public.serverId);
      await job.client.cancelAuthentication(job.serverName);
      await job.entry.provider.invalidateCredentials('verifier');
    }
    return this.view(job.public);
  }
  async detach(serverId: string, clear = false) {
    const id = this.active.get(serverId); if (id) await this.cancel(id);
    const entry = this.providers.get(serverId);
    if (entry) { entry.storage.dispose(); if (clear) entry.storage.clear(); this.providers.delete(serverId); }
    if (clear) for (const value of this.credentials.list()) if (value.name.startsWith(serverStoragePrefix(serverId))) this.credentials.remove(value.name);
  }
  async close() { await Promise.allSettled([...this.providers.keys()].map(id => this.detach(id))); }
}
