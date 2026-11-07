import {MAX_ASSET_BYTES,type AssetInfo} from './assets.js';
import {EventSourceParserStream} from 'eventsource-parser/stream';
import type {PublicEvent,TuiSnapshot,ConversationPage,ProtocolHandshake} from './protocol.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type { OutputRecord, SignalRecord } from './domain.js';
import { AppError } from './domain.js';

export class Client {
  private readonly explicitToken:string|undefined;
  private readonly tokenFile:string|undefined;
  get token(){
    if(this.explicitToken)return this.explicitToken;
    if(!this.tokenFile||!fs.existsSync(this.tokenFile))return undefined;
    const stat=fs.lstatSync(this.tokenFile);if(stat.isSymbolicLink()||stat.nlink>1)throw new AppError('control_token_redirected');
    return fs.readFileSync(this.tokenFile,'utf8').trim()||undefined;
  }
  constructor(readonly baseURL: string, token?: string, readonly version: 1 | 2 = 2, dataDir?:string) {
    const url = new URL(baseURL); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new AppError('invalid_core_url');
    this.explicitToken = token ?? process.env.SHITTIMCHEST_CONTROL_TOKEN ?? process.env.ARONA_CONTROL_TOKEN;
    if (!this.token && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)) {
      const file = path.join(dataDir || process.env.SHITTIMCHEST_DATA_DIR || process.env.ARONA_DATA_DIR || path.join(os.homedir(),'.arona'),'control-token');
      this.tokenFile=file;
    }
  }

  async request<T>(route: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      const target = new URL(route, this.baseURL); if (target.origin !== new URL(this.baseURL).origin) throw new AppError('cross_origin_request_refused');
      const headers = new Headers(init?.headers); if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
      response = await fetch(target, { ...init, headers, redirect:'error', signal: init?.signal ? AbortSignal.any([init.signal,AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
    } catch(error) { throw error instanceof AppError ? error : new AppError('connection_failed', 502); }
    let body: unknown; try { body = await response.json(); } catch { throw new AppError('invalid_core_response',502); }
    if (!response.ok) {
      const code = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
      throw new AppError(typeof code === 'string' ? code : 'request_failed', response.status);
    }
    return body as T;
  }

  submit(content: string, type: 'user-message' | 'external-event', contextId = 'main', id: string = randomUUID(),signal?:AbortSignal) {
    return this.request<SignalRecord>('/signals', {
      method: 'POST', signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(this.version === 2 ? {version:2}:{}), id, contextId, source: type === 'user-message' ? 'terminal' : 'manual-event', type, content }),
    });
  }

  outputs(after: number, kind: OutputRecord['kind'], contextId: string,signal?:AbortSignal) {
    const params = new URLSearchParams({ after: String(after), kind, contextId });
    return this.request<{ outputs: OutputRecord[]; nextCursor: number }>(`/outputs?${params}`,{signal});
  }
  async uploadAsset(filePath:string,signal?:AbortSignal,expectedStorageId?:string):Promise<AssetInfo>{
    signal?.throwIfAborted();
    expectedStorageId??=(await this.handshake(signal)).storageId;
    const handle=await fs.promises.open(filePath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    let bytes:Buffer;
    try{const stat=await handle.stat();const visible=await fs.promises.lstat(filePath);if(!stat.isFile()||stat.nlink!==1||visible.isSymbolicLink()||visible.ino!==stat.ino||visible.dev!==stat.dev)throw new AppError('attachment_redirected',403);if(stat.size>MAX_ASSET_BYTES)throw new AppError('asset_too_large',413);bytes=await handle.readFile({signal});const after=await handle.stat();if(stat.size!==after.size||stat.mtimeMs!==after.mtimeMs||stat.ctimeMs!==after.ctimeMs)throw new AppError('attachment_changed',409);}finally{await handle.close();}
    return this.request<AssetInfo>(`/assets?name=${encodeURIComponent(path.basename(filePath))}`,{method:'POST',signal,headers:{'content-type':'application/octet-stream','X-ShittimChest-Storage-Id':expectedStorageId},body:new Uint8Array(bytes)});
  }
  assetInfo(id:string,signal?:AbortSignal){return this.request<AssetInfo>(`/assets/${encodeURIComponent(id)}/metadata`,{signal});}
  assetBytes(id:string,signal?:AbortSignal){return this.binaryBytes(`/assets/${encodeURIComponent(id)}`,MAX_ASSET_BYTES,signal);}
  async deliveryBytes(taskId:string,index:number,revision:number,sha256:string,signal?:AbortSignal){
    const bytes=await this.binaryBytes(`/tasks/${encodeURIComponent(taskId)}/deliveries/${index}?revision=${revision}`,64*1024*1024,signal);
    if(createHash('sha256').update(bytes).digest('hex')!==sha256)throw new AppError('delivery_changed',409);return bytes;
  }
  private async binaryBytes(route:string,maxBytes:number,signal?:AbortSignal){
    const headers=new Headers();if(this.token)headers.set('Authorization',`Bearer ${this.token}`);
    const response=await fetch(new URL(route,this.baseURL),{headers,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
    if(!response.ok){let code='download_failed';try{const body=await response.json() as {error?:string};if(body.error)code=body.error;}catch{}throw new AppError(code,response.status);}
    const reader=response.body?.getReader();if(!reader)throw new AppError('empty_asset',502);const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>maxBytes)throw new AppError('download_too_large',413);chunks.push(next.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    return Buffer.concat(chunks);
  }
  handshake(signal?:AbortSignal){return this.request<ProtocolHandshake>('/protocol',{signal});}
  snapshot(contextId='main',signal?:AbortSignal){return this.request<TuiSnapshot>(`/snapshot?contextId=${encodeURIComponent(contextId)}`,{signal});}
  conversation(contextId='main',after?:string,signal?:AbortSignal){return this.request<ConversationPage>(`/conversation?contextId=${encodeURIComponent(contextId)}${after?`&after=${encodeURIComponent(after)}`:''}`,{signal});}
  async *events(options:{after?:number;contextId?:string;signal:AbortSignal}):AsyncGenerator<{type:'event';event:PublicEvent}|{type:'checkpoint';cursor:number;storageId:string;instanceId:string}>{
    const parameters=new URLSearchParams({after:String(options.after??0)});if(options.contextId)parameters.set('contextId',options.contextId);
    const headers=new Headers({Accept:'text/event-stream'});if(this.token)headers.set('Authorization',`Bearer ${this.token}`);
    const response=await fetch(new URL(`/event-stream?${parameters}`,this.baseURL),{headers,redirect:'error',signal:options.signal});
    if(!response.ok){let code='event_stream_failed';try{const body=await response.json() as {error?:string};if(body.error)code=body.error;}catch{}throw new AppError(code,response.status);}
    if(!response.body||!response.headers.get('content-type')?.includes('text/event-stream'))throw new AppError('invalid_event_stream',502);
    const reader=response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream()).getReader();
    try{for(;;){const next=await reader.read();if(next.done)break;const frame=next.value;
      if(frame.event==='event'){const event=JSON.parse(frame.data) as PublicEvent;if(!Number.isSafeInteger(event.seq)||event.seq<1||typeof event.kind!=='string'||typeof event.contextId!=='string')throw new AppError('invalid_event_stream',502);yield {type:'event',event};}
      else if(frame.event==='checkpoint'){const value=JSON.parse(frame.data) as {cursor:number;storageId:string;instanceId:string};if(!Number.isSafeInteger(value.cursor)||value.cursor<0||typeof value.storageId!=='string'||typeof value.instanceId!=='string')throw new AppError('invalid_event_stream',502);yield {type:'checkpoint',...value};}
    }}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  }

}

export class OutputCursor {
  private readonly file: string;
  constructor(directory: string, baseURL: string, contextId: string, kind: OutputRecord['kind']) {
    fs.mkdirSync(directory, { recursive: true });
    const key = createHash('sha256').update(JSON.stringify([baseURL, contextId, kind])).digest('hex');
    this.file = path.join(directory, `cursor-${key}.json`);
  }

  read(): number {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
      throw new AppError('invalid_output_cursor');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw new AppError('invalid_output_cursor');
    }
  }

  save(value: number) {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
}

export async function watchOutputs(options: {
  client: Client; cursor: OutputCursor; kind: OutputRecord['kind']; contextId: string;
  signal: AbortSignal; onOutput: (output: OutputRecord) => void;
  onError?: () => void;
}) {
  while (!options.signal.aborted) {
    try {
      const page = await options.client.outputs(options.cursor.read(), options.kind, options.contextId,options.signal);
      for (const output of page.outputs) {
        if (options.signal.aborted) break;
        options.onOutput(output);
        options.cursor.save(output.seq);
      }
    } catch { if (!options.signal.aborted) options.onError?.(); }
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); options.signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, 500);
      options.signal.addEventListener('abort', done, { once: true });
      if (options.signal.aborted) done();
    });
  }
}
