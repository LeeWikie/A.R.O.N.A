import {createHmac,timingSafeEqual} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import type {WebResultDocument} from './results.js';
import {MAX_WEB_RESULT_CHARACTERS,webDocumentExtractionSchema,providerProvenanceSchema,webReceivedSchema} from './results.js';

const keySchema=z.string().regex(/^[0-9a-f]{64}$/),documentSchema=z.object({url:z.url().refine(value=>{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password;}),status:z.number().int().min(200).max(299).nullable(),contentType:z.string().max(1024),extractor:z.string().max(256),title:z.string().max(256).optional(),content:z.string().min(1),extraction:webDocumentExtractionSchema.refine(value=>value.complete).optional(),provider:providerProvenanceSchema.refine(value=>value.coverage==='full'&&!value.error&&!value.rescuedFrom).optional(),received:webReceivedSchema.refine(value=>!value.truncated&&value.bytes<=10000000&&value.wireBytes<=10000000)}).strict().refine(value=>value.status!==null||Boolean(value.provider));
const recordSchema=z.object({version:z.literal(1),key:keySchema,fetchedAt:z.number().int().nonnegative(),document:documentSchema}).strict();

/** Reusable extraction facts, separate from every source-bound retained result. */
export class WebExtractionCache{
  constructor(private readonly db:DatabaseSync,private readonly secret:string){db.exec('CREATE TABLE IF NOT EXISTS web_extraction_cache(key TEXT PRIMARY KEY,body TEXT NOT NULL,mac TEXT NOT NULL,fetched_at INTEGER NOT NULL)');}
  private mac(body:string){return createHmac('sha256',this.secret).update('web-extraction-cache-v1\0').update(body).digest('hex');}
  get(key:string,ttlMs:number,signal?:AbortSignal):WebResultDocument|undefined{
    signal?.throwIfAborted();keySchema.parse(key);if(ttlMs<=0)return;const row=this.db.prepare('SELECT length(body) n,mac FROM web_extraction_cache WHERE key=?').get(key);if(!row)return;
    const miss=()=>{this.db.prepare('DELETE FROM web_extraction_cache WHERE key=?').run(key);return undefined;};if(Number(row.n)>16*1024*1024||typeof row.mac!=='string')return miss();
    const body=this.db.prepare('SELECT body FROM web_extraction_cache WHERE key=?').get(key)?.body;if(typeof body!=='string')return miss();const expected=Buffer.from(row.mac,'hex'),actual=Buffer.from(this.mac(body),'hex');if(expected.length!==actual.length||!timingSafeEqual(expected,actual))return miss();let value:unknown;try{value=JSON.parse(body);}catch{return miss();}const parsed=recordSchema.safeParse(value);if(!parsed.success||parsed.data.key!==key||Date.now()-parsed.data.fetchedAt>=Math.min(ttlMs,86400000)||parsed.data.fetchedAt>Date.now()+1000)return miss();signal?.throwIfAborted();return parsed.data.document;
  }
  put(key:string,document:WebResultDocument,signal?:AbortSignal){
    signal?.throwIfAborted();keySchema.parse(key);const parsed=documentSchema.safeParse(document);if(!parsed.success)return;let characters=0;for(const _character of document.content)if(++characters>MAX_WEB_RESULT_CHARACTERS)return;
    const fetchedAt=Date.now(),body=JSON.stringify({version:1,key,fetchedAt,document:parsed.data});if(Buffer.byteLength(body)>16*1024*1024)return;signal?.throwIfAborted();
    this.db.exec('SAVEPOINT web_extraction_cache_write');try{
      this.db.prepare('INSERT INTO web_extraction_cache VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,mac=excluded.mac,fetched_at=excluded.fetched_at').run(key,body,this.mac(body),fetchedAt);
      const rows=this.db.prepare('SELECT key,length(CAST(body AS BLOB)) n FROM web_extraction_cache ORDER BY fetched_at DESC,rowid DESC').all();let bytes=0;for(let index=0;index<rows.length;index++){bytes+=Number(rows[index]!.n);if(index>=500||bytes>64*1024*1024)this.db.prepare('DELETE FROM web_extraction_cache WHERE key=?').run(String(rows[index]!.key));}
      this.db.exec('RELEASE web_extraction_cache_write');
    }catch(error){this.db.exec('ROLLBACK TO web_extraction_cache_write');this.db.exec('RELEASE web_extraction_cache_write');throw error;}
  }
}
