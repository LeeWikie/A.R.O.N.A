import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {AppError} from './domain.js';
import type {PortableSessionArtifact,UnavailableSessionArtifact} from './session-artifacts.js';
import {isPrivateMcpRepresentation,mcpResultReferenceSchema} from './tools/mcp-results.js';
import {mcpBinaryResources,mcpFactsMatch,parseMcpWitness,verifyMcpDerivedPayload} from './tools/mcp-model.js';

const invalid=()=>new AppError('invalid_session_mcp_artifact',409);
const bytes=(row:PortableSessionArtifact)=>Buffer.concat(row.parts.map(part=>Buffer.from(part.data,'base64')));
const origin=(row:Pick<PortableSessionArtifact,'origin'>)=>{const{ref,stream,...source}=row.origin;return source;};

/** Safe retained output is reproduced from its private protocol witness. */
export async function verifyMcpSessionArtifacts(artifacts:readonly PortableSessionArtifact[],signal?:AbortSignal,unavailable:readonly UnavailableSessionArtifact[]=[]){
 if(artifacts.some(row=>row.kind!=='mcp-result'&&(row.original?.mcp!==undefined||/^mcp-result\.[0-9a-f-]{36}$/.test(row.origin.ref))))throw invalid();
 const records=artifacts.filter(row=>row.kind==='mcp-result').map(row=>({row,reference:mcpResultReferenceSchema.parse(row.original?.mcp)}));
 const missing=unavailable.filter(row=>row.kind==='mcp-result').map(row=>{const reference=mcpResultReferenceSchema.parse(row.original?.mcp);if(reference.id!==row.origin.ref||reference.sha256!==row.expectedSha256||reference.name!==row.name||reference.mediaType!==row.mediaType)throw invalid();return{row,reference};});
 const related=(row:PortableSessionArtifact,id:string)=>records.find(candidate=>candidate.reference.id===id&&isDeepStrictEqual(origin(candidate.row),origin(row))&&row.entryIds.every(entry=>candidate.row.entryIds.includes(entry)));
 for(const{row,reference}of records){
  signal?.throwIfAborted();if(reference.id!==row.origin.ref||reference.bytes!==row.bytes||reference.sha256!==row.sha256||reference.name!==row.name||reference.mediaType!==row.mediaType||!row.complete)throw invalid();
  if(isPrivateMcpRepresentation(reference.representation)){
   if(reference.originalResultId||reference.imageLane!==undefined||reference.resourceLane!==undefined||reference.audioLane!==undefined||reference.resourceReferences!==undefined||reference.mediaType!=='application/json')throw invalid();
   try{const witness=parseMcpWitness(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes(row))));if(reference.representation!==(witness.version===1?'mcp-call-tool-result':'mcp-protocol-result')||!mcpFactsMatch(reference,witness))throw invalid();}catch{throw invalid();}continue;
  }
  const parent=reference.originalResultId&&related(row,reference.originalResultId);if(!parent||!isPrivateMcpRepresentation(parent.reference.representation)||!isDeepStrictEqual(parent.reference.source,reference.source))throw invalid();
  let witness:unknown;try{witness=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes(parent.row)));const parsed=parseMcpWitness(witness);if(!mcpFactsMatch(reference,parsed))throw invalid();}catch{throw invalid();}
  const resourcePaths=[];for(const mapping of reference.resourceReferences??[]){
   const resource=related(row,mapping.id)??missing.find(candidate=>candidate.reference.id===mapping.id&&isDeepStrictEqual(origin(candidate.row),origin(row))&&row.entryIds.every(entry=>candidate.row.entryIds.includes(entry)));
   if(!resource||resource.reference.representation!=='mcp-model-resource'||resource.reference.resourceLane!==mapping.lane||resource.reference.originalResultId!==parent.reference.id||!isDeepStrictEqual(resource.reference.source,reference.source))throw invalid();
   if('availability'in resource.row){const original=mcpBinaryResources(witness).find(value=>value.lane===mapping.lane);if(!original||original.bytes!==resource.reference.bytes||original.sha256!==resource.reference.sha256)throw invalid();const data=Buffer.from(original.data,'base64');if(createHash('sha256').update(data).digest('hex')!==resource.reference.sha256)throw invalid();await verifyMcpDerivedPayload(data,{...resource.reference,representation:resource.reference.representation},witness,{serverId:reference.source.serverId});}
   resourcePaths.push({lane:mapping.lane,path:mapping.id});
  }
  await verifyMcpDerivedPayload(bytes(row),{...reference,representation:reference.representation},witness,{serverId:reference.source.serverId,resourcePaths});
  signal?.throwIfAborted();
 }
}
