import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {SessionEntry} from '@earendil-works/pi-coding-agent';
import type {SessionArchive} from './protocol.js';
import {AppError} from './domain.js';
import {isBase64String} from './base64.js';

type ArchiveAsset=NonNullable<SessionArchive['continuation']>['assets'][number];
export interface PortableSessionAsset extends ArchiveAsset {entryIds:string[]}
export const SESSION_USER_ASSETS_CAPABILITY='session-user-assets';
const dependencySchema=z.object({version:z.literal(1),requires:z.array(z.enum([SESSION_USER_ASSETS_CAPABILITY,'session-provenance'])).min(1)}).strict();
export function sessionDataRequirements(header:unknown):string[]{if(!header||typeof header!=='object'||Array.isArray(header))throw invalid();if(!('shittimchestData'in header))return[];const parsed=dependencySchema.safeParse(header.shittimchestData);if(!parsed.success||new Set(parsed.data.requires).size!==parsed.data.requires.length)throw new AppError('session_data_feature_unsupported',409);return parsed.data.requires;}
export function sessionAssetHeader<T extends object>(header:T,hasAssets:boolean,hasProvenance=false){const{shittimchestData,...rest}=header as T&{shittimchestData?:unknown};const requires=[...(hasAssets?[SESSION_USER_ASSETS_CAPABILITY]:[]),...(hasProvenance?['session-provenance']:[])];return{...rest,...(requires.length?{shittimchestData:{version:1 as const,requires}}:{})};}
const partBytes=256*1024,manifestType='org.shittimchest.session-asset.v1',partType='org.shittimchest.session-asset-part.v1';
const metadata=z.object({id:z.string().uuid(),name:z.string().min(1).max(240),mediaType:z.string().max(200),sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().nonnegative().max(16*1024*1024),purpose:z.literal('client-shell-output').optional(),originalAssetIds:z.array(z.string().uuid()).optional(),entryIds:z.array(z.string().min(1)).min(1),partCount:z.number().int().positive()}).strict();
type StoredAsset=z.infer<typeof metadata>&{parts:Map<number,string>};
const invalid=()=>new AppError('invalid_session_asset',409);
const digest=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
export function* sessionAssetPiEntries(assets:readonly PortableSessionAsset[],parentId:string|null):Generator<SessionEntry>{
 let parent=parentId;for(const asset of assets){if(!isBase64String(asset.data))throw invalid();const data=Buffer.from(asset.data,'base64');if(digest(data)!==asset.sha256||data.toString('base64')!==asset.data)throw invalid();const{data:encoded,...body}=asset,count=Math.max(1,Math.ceil(data.length/partBytes)),id=randomUUID(),manifest=metadata.parse({...body,bytes:data.length,partCount:count});yield{type:'custom',id,parentId:parent,timestamp:new Date().toISOString(),customType:manifestType,data:manifest};parent=id;for(let index=0;index<count;index++){const id=randomUUID();yield{type:'custom',id,parentId:parent,timestamp:new Date().toISOString(),customType:partType,data:{id:asset.id,index,data:data.subarray(index*partBytes,(index+1)*partBytes).toString('base64')}};parent=id;}}
}
export function extractSessionAssetPiEntries(entries:readonly SessionEntry[]){
 const assets=new Map<string,StoredAsset>(),removed=new Set<string>(),users=new Set(entries.filter(entry=>entry.type==='message'&&entry.message.role==='user').map(entry=>entry.id));
 for(const entry of entries){if(entry.type!=='custom')continue;if(entry.customType.startsWith('org.shittimchest.session-asset')&&![manifestType,partType].includes(entry.customType))throw new AppError('session_data_feature_unsupported',409);if(![manifestType,partType].includes(entry.customType))continue;removed.add(entry.id);
  if(entry.customType===manifestType){const parsed=metadata.safeParse(entry.data);if(!parsed.success||assets.has(parsed.data.id)||new Set(parsed.data.entryIds).size!==parsed.data.entryIds.length||parsed.data.entryIds.some(id=>!users.has(id))||parsed.data.partCount!==Math.max(1,Math.ceil(parsed.data.bytes/partBytes)))throw invalid();assets.set(parsed.data.id,{...parsed.data,parts:new Map()});}
  else{const parsed=z.object({id:z.string().uuid(),index:z.number().int().nonnegative(),data:z.string().max(Math.ceil(partBytes/3)*4)}).strict().safeParse(entry.data);if(!parsed.success)throw invalid();const row=parsed.data,asset=assets.get(row.id);if(!asset||row.index>=asset.partCount||asset.parts.has(row.index)||!isBase64String(row.data))throw invalid();const bytes=Buffer.from(row.data,'base64');if(bytes.toString('base64')!==row.data||bytes.length!==Math.max(0,Math.min(partBytes,asset.bytes-row.index*partBytes)))throw invalid();asset.parts.set(row.index,row.data);}
 }
 const kept=entries.filter(entry=>!removed.has(entry.id));if(kept.some(entry=>entry.parentId!==null&&removed.has(entry.parentId)))throw invalid();
 return{entries:kept,assets:[...assets.values()].map(({bytes,partCount,parts,...asset}):PortableSessionAsset=>{if(parts.size!==partCount)throw invalid();const data=Buffer.concat(Array.from({length:partCount},(_,index)=>Buffer.from(parts.get(index)!,'base64')));if(data.length!==bytes||digest(data)!==asset.sha256)throw invalid();return{...asset,data:data.toString('base64')};})};
}

export function verifyPortableShellAssetSecrets(assets:readonly ArchiveAsset[],secrets:readonly string[]){
 const needles=secrets.filter(secret=>secret.length>=4).map(secret=>Buffer.from(secret)),tailLength=Math.max(0,...needles.map(secret=>secret.length-1));
 const scan=(parts:Iterable<Uint8Array>)=>{let tail=Buffer.alloc(0);for(const part of parts){const data=Buffer.concat([tail,part]);if(needles.some(secret=>data.includes(secret)))throw new AppError('session_backup_contains_secret',409);tail=tailLength?Buffer.from(data.subarray(Math.max(0,data.length-tailLength))):Buffer.alloc(0);}};
 for(const asset of assets){if(asset.purpose!=='client-shell-output')continue;const bytes=Buffer.from(asset.data,'base64');scan([bytes]);let lines:unknown[];try{lines=bytes.toString('utf8').trimEnd().split('\n').map(line=>JSON.parse(line) as unknown);}catch{continue;}const header=lines[0];if(!header||typeof header!=='object'||Array.isArray(header)||!('format'in header)||header.format!=='client-shell-output')continue;
  if(!('version'in header)||header.version!==1||lines.length!==3)throw invalid();const streams=new Set<string>();
  for(const input of lines.slice(1)){const stream=z.object({stream:z.enum(['stdout','stderr']),bytes:z.number().int().nonnegative(),sha256:z.string().regex(/^[a-f0-9]{64}$/),complete:z.boolean(),parts:z.array(z.object({id:z.string().uuid(),stream:z.enum(['stdout','stderr']),index:z.number().int().nonnegative(),bytes:z.number().int().positive(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict())}).strict().safeParse(input);if(!stream.success||streams.has(stream.data.stream))throw invalid();streams.add(stream.data.stream);const source=stream.data,hash=createHash('sha256');let total=0;
   function* ordered(){for(const [index,part]of source.parts.entries()){if(part.index!==index||part.stream!==source.stream)throw invalid();const candidates=assets.filter(asset=>asset.purpose==='client-shell-output'&&(asset.id===part.id||asset.originalAssetIds?.includes(part.id))&&asset.sha256===part.sha256);if(candidates.length!==1)throw invalid();const data=Buffer.from(candidates[0]!.data,'base64');if(data.length!==part.bytes||digest(data)!==part.sha256)throw invalid();total+=data.length;hash.update(data);yield data;}}
   scan(ordered());if(total!==source.bytes||hash.digest('hex')!==source.sha256)throw invalid();
  }
 }
}
