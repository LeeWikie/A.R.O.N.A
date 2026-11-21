import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {createReadTool} from '@earendil-works/pi-coding-agent';
import {z} from 'zod';
import {acceptedSourceIds} from '../accepted-sources.js';
import {AppError,contextIdSchema} from '../domain.js';
import {webProviderNames} from './provider-config.js';

export const MAX_WEB_RESULT_CHARACTERS=2_000_000;
const sha=z.string().regex(/^[0-9a-f]{64}$/);
export const webResultBindingSchema=z.object({contextId:contextIdSchema,runId:z.uuid(),toolCallId:z.string().min(1).max(512),nativeMessageId:z.string().min(1).max(512).optional(),taskId:z.uuid().nullable(),attempt:z.number().int().positive(),workspaceId:z.string().min(1),sourceSignalIds:acceptedSourceIds,proof:sha}).strict();
export type WebResultBinding=z.infer<typeof webResultBindingSchema>;
export const webDocumentExtractionSchema=z.object({format:z.enum(['pdf','docx','xlsx']),complete:z.boolean(),warnings:z.array(z.string().max(4096)).max(100)}).strict();
const providerRequestSchema=z.object({url:z.url(),status:z.number().int().nullable(),error:z.string().optional(),bytes:z.number().int().nonnegative().optional(),wireBytes:z.number().int().nonnegative().optional(),sha256:sha.optional(),truncated:z.boolean().optional()}).strict();
export const providerReceiptSchema=z.object({kind:z.literal('provider-api-response'),url:z.url(),status:z.number().int(),bytes:z.number().int().nonnegative(),wireBytes:z.number().int().nonnegative(),sha256:sha,truncated:z.boolean(),retryCount:z.number().int().min(0).max(2).optional(),attempts:z.array(providerRequestSchema).max(3).optional()}).strict();
export const providerProvenanceSchema=z.object({name:z.enum(webProviderNames),mode:z.enum(['keyed','keyless']),coverage:z.enum(['full','excerpt']),requestedURL:z.url(),error:z.string().optional(),rescuedFrom:z.enum(webProviderNames).optional(),backendError:z.string().optional(),servedBy:z.enum(webProviderNames).optional(),apiResponse:providerReceiptSchema,attempts:z.array(z.object({provider:z.enum(webProviderNames),mode:z.enum(['keyed','keyless']),outcome:z.enum(['succeeded','failed']),error:z.string().optional(),receipt:providerReceiptSchema.optional(),requests:z.array(providerRequestSchema).max(3).optional()}).strict()).max(8)}).strict();
export const webReceivedSchema=z.object({bytes:z.number().int().nonnegative(),wireBytes:z.number().int().nonnegative(),sha256:sha,truncated:z.boolean(),representation:z.literal('provider-api-response').optional()}).strict();
export interface WebResultDocument {url:string;status:number|null;contentType:string;extractor:string;title?:string;content:string;extraction?:z.infer<typeof webDocumentExtractionSchema>;provider?:z.infer<typeof providerProvenanceSchema>;received:z.infer<typeof webReceivedSchema>}
const referenceSchema=z.object({id:z.uuid(),url:z.url(),status:z.number().int().nullable(),contentType:z.string(),extractor:z.string(),title:z.string().optional(),representation:z.literal('extracted-web-text'),bytes:z.number().int().nonnegative(),sha256:sha,characters:z.number().int().nonnegative(),originalCharacters:z.number().int().nonnegative(),totalLines:z.number().int().positive(),isTruncated:z.boolean(),truncationReasons:z.array(z.enum(['network-byte-limit','text-retention-limit','document-extraction-limit','provider-excerpt'])),extraction:webDocumentExtractionSchema.optional(),provider:providerProvenanceSchema.optional(),received:webReceivedSchema,createdAt:z.string()}).strict().refine(value=>value.status!==null||Boolean(value.provider),'An unknown origin status requires provider provenance');
export type WebResultReference=z.infer<typeof referenceSchema>;
export const webResultPageSchema=z.object({offset:z.number().int().min(1).optional(),limit:z.number().int().min(1).max(2000).optional(),encoding:z.enum(['text','base64']).default('text'),byteOffset:z.number().int().nonnegative().optional(),maxBytes:z.number().int().min(1).max(32768).optional()}).strict().refine(value=>value.encoding==='base64'?value.offset===undefined&&value.limit===undefined:value.byteOffset===undefined&&value.maxBytes===undefined,'Use line options for text and byte options for base64.');
export type WebResultPageOptions=z.input<typeof webResultPageSchema>;
const recordSchema=z.object({version:z.literal(1),reference:referenceSchema,binding:webResultBindingSchema}).strict();

/** A retained page has no authority of its own; the host validates its sealed source before reading. */
export class WebResultStore {
  constructor(private readonly db:DatabaseSync,private readonly secret:string){db.exec('CREATE TABLE IF NOT EXISTS web_result_records(id TEXT PRIMARY KEY,body TEXT NOT NULL,content BLOB NOT NULL,mac TEXT NOT NULL)');}
  private mac(value:string){return createHmac('sha256',this.secret).update('web-result-v1\0').update(value).digest('hex');}
  private record(id:string){
    if(!z.uuid().safeParse(id).success)throw new AppError('web_result_not_found',404);const row=this.db.prepare('SELECT body,mac FROM web_result_records WHERE id=?').get(id);if(!row||typeof row.body!=='string'||typeof row.mac!=='string')throw new AppError('web_result_not_found',404);
    const actual=Buffer.from(this.mac(row.body),'hex'),expected=Buffer.from(row.mac,'hex');if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new AppError('web_result_changed',409);
    let parsed:unknown;try{parsed=JSON.parse(row.body);}catch{throw new AppError('web_result_changed',409);}const result=recordSchema.safeParse(parsed);if(!result.success||result.data.reference.id!==id)throw new AppError('web_result_changed',409);return result.data;
  }
  describe(id:string){const {reference,binding}=this.record(id);return {reference,binding};}
  private checkedBytes(reference:WebResultReference){
    const size=this.db.prepare('SELECT length(content) n FROM web_result_records WHERE id=?').get(reference.id);if(!size||Number(size.n)!==reference.bytes||reference.bytes>4*MAX_WEB_RESULT_CHARACTERS)throw new AppError('web_result_changed',409);
    const row=this.db.prepare('SELECT content FROM web_result_records WHERE id=?').get(reference.id);if(!row||!(row.content instanceof Uint8Array))throw new AppError('web_result_changed',409);const bytes=Buffer.from(row.content);
    if(bytes.length!==reference.bytes||createHash('sha256').update(bytes).digest('hex')!==reference.sha256)throw new AppError('web_result_changed',409);return bytes;
  }
  /** Host-authorized data export excludes every live execution binding and MAC. */
  exportRetained(id:string,signal?:AbortSignal){signal?.throwIfAborted();const {reference}=this.record(id),bytes=this.checkedBytes(reference);signal?.throwIfAborted();return {reference,bytes};}
  save(document:WebResultDocument,binding:WebResultBinding,signal?:AbortSignal):WebResultReference{
    signal?.throwIfAborted();const authority=webResultBindingSchema.parse(binding),url=new URL(document.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new AppError('invalid_web_result');let characters=0,storedEnd=0;
    for(const character of document.content){characters++;if(characters<=MAX_WEB_RESULT_CHARACTERS)storedEnd+=character.length;}
    const content=document.content.slice(0,storedEnd),bytes=Buffer.from(content,'utf8'),truncationReasons:WebResultReference['truncationReasons']=[];if(document.received.truncated)truncationReasons.push('network-byte-limit');if(characters>MAX_WEB_RESULT_CHARACTERS)truncationReasons.push('text-retention-limit');if(document.extraction&&!document.extraction.complete)truncationReasons.push('document-extraction-limit');if(document.provider?.coverage==='excerpt')truncationReasons.push('provider-excerpt');
    const reference=referenceSchema.parse({id:randomUUID(),url:url.href,status:document.status,contentType:document.contentType,extractor:document.extractor,...(document.title===undefined?{}:{title:document.title}),...(document.extraction?{extraction:document.extraction}:{}),...(document.provider?{provider:document.provider}:{}),representation:'extracted-web-text',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),characters:Math.min(characters,MAX_WEB_RESULT_CHARACTERS),originalCharacters:characters,totalLines:content.split('\n').length,isTruncated:truncationReasons.length>0,truncationReasons,received:document.received,createdAt:new Date().toISOString()});
    const body=JSON.stringify({version:1,reference,binding:authority});signal?.throwIfAborted();this.db.prepare('INSERT INTO web_result_records VALUES(?,?,?,?)').run(reference.id,body,bytes,this.mac(body));return reference;
  }
  async read(id:string,options:WebResultPageOptions={},signal?:AbortSignal){
    signal?.throwIfAborted();const {reference}=this.record(id),page=webResultPageSchema.parse(options),bytes=this.checkedBytes(reference),source={...reference},authority='external-web-data' as const;
    if(page.encoding==='base64'){const start=page.byteOffset??0;if(start>bytes.length)throw new AppError('web_result_offset');const end=Math.min(bytes.length,start+(page.maxBytes??16384));return {source,authority,representation:'base64' as const,complete:!reference.isTruncated&&start===0&&end===bytes.length,byteOffset:start,byteLength:end-start,nextByteOffset:end<bytes.length?end:null,content:bytes.subarray(start,end).toString('base64')};}
    const offset=page.offset??1,limit=page.limit??200,reader=createReadTool('/web-results',{operations:{access:async()=>{},detectImageMimeType:async()=>undefined,readFile:async()=>bytes,createReadStream:async function*(_absolute,{signal}){for(let position=0;position<bytes.length;position+=65536){signal?.throwIfAborted();yield bytes.subarray(position,position+65536);}}}}),result=await reader.execute('read-web-result',{path:id,offset,limit},signal),truncation=result.details?.truncation,requiresByteRead=Boolean(truncation?.firstLineExceedsLimit),count=requiresByteRead?0:truncation?.truncated?truncation.outputLines:Math.max(0,Math.min(limit,reference.totalLines-offset+1)),next=offset+count;
    signal?.throwIfAborted();return {source,authority,representation:'utf8-source-text' as const,complete:!reference.isTruncated&&offset===1&&next>reference.totalLines,offset,nextOffset:next<=reference.totalLines?next:null,requiresByteRead,content:requiresByteRead?'The selected line exceeds the text page size. Use encoding=base64 with byteOffset and maxBytes to read its original extracted-text bytes.':result.content.flatMap(part=>part.type==='text'?[part.text]:[]).join('\n')};
  }
}
