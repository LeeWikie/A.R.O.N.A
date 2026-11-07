import type {Core} from './core.js';
import type {RuntimeEvent} from './runtime-store.js';
import {redactSensitiveUrlLikeString} from './web/net-policy/redact-sensitive-url.js';

export function redactPublicArgs(core:Core,value:unknown,key='',secrets?:readonly string[]):unknown {
  if(!secrets){try{secrets=core.redactionValues();}catch{return '[unavailable]';}}
  if(/(?:password|secret|token|api[-_]?key|authorization|refresh|cookie|^key$)/i.test(key))return '[hidden]';
  if(typeof value==='string'){
    let text=value;for(const secret of secrets)if(secret.length>=4)text=text.split(secret).join('[hidden]');
    return redactSensitiveUrlLikeString(text).replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+/gi,'$1[hidden]').replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,'[hidden]');
  }
  if(Array.isArray(value))return value.map(item=>redactPublicArgs(core,item,key,secrets));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,redactPublicArgs(core,item,name,secrets)]));
  return value;
}
function argsView(core:Core,value:unknown,secrets?:readonly string[]){
  if(!value||typeof value!=='object'||Array.isArray(value))return {};
  const allowed=new Set(['signalIds','id','contextId','parentId','title','path','paths','directory','command','description','query','url','pattern','modelId','profileId','action','revision','scope','name','workspaceId','recursive','maxChars','mode','timeout']);
  const result:Record<string,unknown>={};
  for(const [key,item] of Object.entries(value)){
    if(allowed.has(key)){const text=JSON.stringify(redactPublicArgs(core,item,key,secrets));if(text===undefined)continue;result[key]=text.length>16000?{truncated:true,characters:text.length}:JSON.parse(text);}
    else if(typeof item==='string')result[key]={type:'text',characters:item.length};
    else if(Array.isArray(item))result[key]={type:'array',items:item.length};
    else if(item!==null&&typeof item==='object')result[key]={type:'object'};
  }
  return result;
}
function summary(value:unknown){
  if(typeof value==='string')return {type:'text',characters:value.length,lines:value.split('\n').length};
  if(Array.isArray(value))return {type:'array',items:value.length};
  if(value&&typeof value==='object'){
    const result:Record<string,unknown>={type:'object'};const row=value as Record<string,unknown>;
    for(const key of ['bytes','size','count','exitCode','durationMs','truncated'])if(typeof row[key]==='boolean'||(typeof row[key]==='number'&&Number.isFinite(row[key])))result[key]=row[key];
    if(typeof row.sha256==='string'&&/^[a-f0-9]{64}$/.test(row.sha256))result.sha256=row.sha256;
    return result;
  }
  return {type:value===null?'null':typeof value};
}
export function publicToolEvent(core:Core,event:RuntimeEvent,secrets?:readonly string[],legacy=false){
  const data=event.data as Record<string,unknown>;const toolCallId=String(data.toolCallId??'');
  const previous=event.kind==='tool_start'?undefined:core.store.db.prepare("SELECT data FROM runtime_events WHERE context_id=? AND run_id IS ? AND kind='tool_start' AND json_extract(data,'$.toolCallId')=? AND seq<=? ORDER BY seq DESC LIMIT 1").get(event.contextId,event.runId,toolCallId,event.seq);
  const start=event.kind==='tool_start'?data:previous?JSON.parse(String(previous.data)) as Record<string,unknown>:undefined;
  return {toolCallId,toolName:String(start?.toolName??data.toolName??''),state:event.kind==='tool_start'||event.kind==='tool_update'?'running':data.denied?'denied':data.isError?'failed':'finished',...(!legacy&&start?.args?{args:argsView(core,start.args,secrets)}:{}),...(legacy?{legacy:true}:{}),...(event.kind==='tool_end'?{summary:summary(data.result)}:{}),...(event.kind==='tool_update'?{progress:summary(data.partialResult)}:{})};
}
export function toolActivity(core:Core,contextId:string){
  const entries=new Map<string,Record<string,unknown>>(core.runtime.setting<Record<string,unknown>[]>(`context-tools:${contextId}`,[]).map(item=>[String(item.runId)+':'+item.toolCallId,item]));let secrets:readonly string[]|undefined;try{secrets=core.redactionValues();}catch{}
  const rows=core.store.db.prepare("SELECT seq,kind,context_id,run_id,task_id,data,created_at FROM runtime_events WHERE context_id=? AND kind IN ('tool_start','tool_update','tool_end','public_tool') ORDER BY seq").all(contextId);
  for(const row of rows){const event:RuntimeEvent={seq:Number(row.seq),kind:String(row.kind),contextId:String(row.context_id),runId:row.run_id as string|null,taskId:row.task_id as string|null,data:JSON.parse(String(row.data)),createdAt:String(row.created_at)};if(event.kind!=='public_tool'&&core.store.db.prepare('SELECT 1 FROM runtime_events WHERE event_key=?').get('tool.public:'+event.seq))continue;const data=event.kind==='public_tool'?event.data as ReturnType<typeof publicToolEvent>:publicToolEvent(core,event,secrets,true);const key=String(event.runId)+':'+data.toolCallId;const old=entries.get(key);entries.set(key,{...old,...data,contextId,runId:event.runId,startedAt:old?.startedAt??event.createdAt,updatedAt:event.createdAt});}
  return [...entries.values()];
}
