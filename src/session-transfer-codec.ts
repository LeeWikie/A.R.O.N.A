import{AppError}from'./domain.js';
import{parseSessionArchive}from'./context-transfer.js';
import{parsePiSessionEntries}from'./session-graph.js';
import type{SessionArchive}from'./protocol.js';
import type{PortableSessionArtifact}from'./session-artifacts.js';

export type DecodedSessionTransfer={format:'pi';session:ReturnType<typeof parsePiSessionEntries>}|{format:'archive';archive:SessionArchive};
type JsonRecord=Record<string,unknown>;

async function* lines(source:AsyncIterable<Uint8Array>,signal?:AbortSignal){
 const decoder=new TextDecoder('utf-8',{fatal:true});let pending='',first=true;
 try{for await(const bytes of source){signal?.throwIfAborted();pending+=decoder.decode(bytes,{stream:true});let end:number;while((end=pending.indexOf('\n'))>=0){let line=pending.slice(0,end);pending=pending.slice(end+1);if(first){line=line.replace(/^\uFEFF/,'');first=false;}if(line.trim())yield line;}}pending+=decoder.decode();if(first)pending=pending.replace(/^\uFEFF/,'');if(pending.trim())yield pending;}
 catch(error){if(error instanceof AppError||signal?.aborted)throw error;throw new AppError('invalid_session_encoding',400);}
}
function record(text:string):JsonRecord{let value:unknown;try{value=JSON.parse(text);}catch{throw new AppError('invalid_session_archive');}if(!value||typeof value!=='object'||Array.isArray(value))throw new AppError('invalid_session_archive');return value as JsonRecord;}
export async function readSessionTransferHeader(source:AsyncIterable<Uint8Array>,signal?:AbortSignal){for await(const text of lines(source,signal)){const header=record(text);if(header.type!=='session')throw new AppError('invalid_session_archive');return header;}throw new AppError('invalid_session_archive');}

/** Section records keep large continuations out of a single JSON header. */
export async function decodeSessionStream(source:AsyncIterable<Uint8Array>,signal?:AbortSignal):Promise<DecodedSessionTransfer>{
 let header:JsonRecord|undefined,format:'pi'|'archive'|undefined;const pi:unknown[]=[],messages:unknown[]=[],native:unknown[]=[],assets:unknown[]=[],graphEntries:unknown[]=[],graphSources:unknown[]=[],unavailableArtifacts:unknown[]=[];const artifacts=new Map<string,PortableSessionArtifact>();const mapping:Record<string,string>=Object.create(null);let continuation:JsonRecord|undefined;
 for await(const text of lines(source,signal)){signal?.throwIfAborted();const row=record(text);
  if(!header){header=row;if(row.type!=='session')throw new AppError('invalid_session_archive');if(row.format===undefined){format='pi';pi.push(row);}else if(row.format==='shittimchest-session'&&(row.version===1||row.version===2))format='archive';else throw new AppError('invalid_session_archive');continue;}
  if(format==='pi'){pi.push(row);continue;}
  if(row.type==='message'){if(Object.keys(row).some(key=>!['type','message'].includes(key))||!row.message)throw new AppError('invalid_session_archive');messages.push(row.message);continue;}
  if(header.version!==2)throw new AppError('invalid_session_archive');
  if(row.type==='continuation'){if(continuation||messages.length||native.length||assets.length||graphEntries.length||graphSources.length)throw new AppError('invalid_session_archive');const{type,...body}=row;continuation=body;continue;}
  if(!continuation)throw new AppError('invalid_session_archive');
  if(row.type==='public-native-map'){if(Object.keys(row).length!==3||typeof row.publicId!=='string'||typeof row.nativeId!=='string'||Object.hasOwn(mapping,row.publicId))throw new AppError('invalid_session_archive');mapping[row.publicId]=row.nativeId;}
  else if(row.type==='native-message'&&Object.keys(row).length===2)native.push(row.message);
  else if(row.type==='asset'&&Object.keys(row).length===2)assets.push(row.asset);
  else if(row.type==='graph-entry'&&Object.keys(row).length===2)graphEntries.push(row.record);
  else if(row.type==='graph-source'&&Object.keys(row).length===2)graphSources.push(row.source);
  else if(row.type==='history-artifact-unavailable'&&Object.keys(row).length===2)unavailableArtifacts.push(row.artifact);
  else if(row.type==='history-artifact'&&Object.keys(row).length===2){const artifact=row.artifact as PortableSessionArtifact;if(!artifact||typeof artifact.id!=='string'||!Array.isArray(artifact.parts)||artifacts.has(artifact.id)||artifact.parts.some(part=>'data'in part))throw new AppError('invalid_session_archive');artifacts.set(artifact.id,artifact);}
  else if(row.type==='history-artifact-part'&&Object.keys(row).length===4){const artifact=artifacts.get(String(row.id)),index=row.index;if(!artifact||typeof index!=='number'||!Number.isSafeInteger(index)||index<0||index>=artifact.parts.length||typeof row.data!=='string'||'data'in artifact.parts[index]!)throw new AppError('invalid_session_archive');artifact.parts[index]!.data=row.data;}
  else throw new AppError('invalid_session_archive');
 }
 if(!header||!format)throw new AppError('invalid_session_archive');
 if(format==='pi')return{format,session:parsePiSessionEntries(pi,true)};
 const{type,version,...body}=header;
 if(version===1)return{format,archive:parseSessionArchive({...body,version:1,messages},{large:true})};
 if(Object.keys(header).some(key=>!['type','format','version','context'].includes(key)))throw new AppError('invalid_session_archive');
 let restored:unknown;
 if(continuation){if(Object.keys(continuation).some(key=>!['checkpoint','automaticCheckpoint','graphHeader','graphLeafId'].includes(key)))throw new AppError('invalid_session_archive');const{graphHeader,graphLeafId,...meta}=continuation;const graph=graphHeader===undefined?undefined:{header:graphHeader,leafId:graphLeafId,entries:graphEntries,sources:graphSources};if(!graph&&(graphEntries.length||graphSources.length))throw new AppError('invalid_session_archive');restored={...meta,messages:native,publicMessageMap:mapping,assets,...(graph?{graph}:{}),...(artifacts.size?{artifacts:[...artifacts.values()]}:{}),...(unavailableArtifacts.length?{unavailableArtifacts}:{})};}
 return{format,archive:parseSessionArchive({...body,version:1,messages,...(restored?{continuation:restored}:{})},{large:true})};
}

export async function* encodeArchiveStream(archive:SessionArchive):AsyncGenerator<Uint8Array>{
 const{messages,continuation,...header}=archive;const line=(value:unknown)=>Buffer.from(JSON.stringify(value)+'\n');yield line({type:'session',...header,...(continuation?{version:2}:{})});
 if(continuation){const{messages:native,assets,publicMessageMap,graph,artifacts,unavailableArtifacts,...meta}=continuation;yield line({type:'continuation',...meta,...(graph?{graphHeader:graph.header,graphLeafId:graph.leafId}:{})});for(const[publicId,nativeId]of Object.entries(publicMessageMap))yield line({type:'public-native-map',publicId,nativeId});for(const message of messages)yield line({type:'message',message});for(const message of native)yield line({type:'native-message',message});for(const row of graph?.entries??[])yield line({type:'graph-entry',record:row});for(const source of graph?.sources??[])yield line({type:'graph-source',source});for(const asset of assets)yield line({type:'asset',asset});for(const artifact of artifacts??[]){yield line({type:'history-artifact',artifact:{...artifact,parts:artifact.parts.map(({data,...part})=>part)}});for(const[index,part]of artifact.parts.entries())yield line({type:'history-artifact-part',id:artifact.id,index,data:part.data});}for(const artifact of unavailableArtifacts??[])yield line({type:'history-artifact-unavailable',artifact});}
 else for(const message of messages)yield line({type:'message',message});
}

export async function* encodePiStream(header:unknown,entries:Iterable<unknown>):AsyncGenerator<Uint8Array>{yield Buffer.from(JSON.stringify(header)+'\n');for(const entry of entries)yield Buffer.from(JSON.stringify(entry)+'\n');}
