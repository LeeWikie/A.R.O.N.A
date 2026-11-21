import type {Core} from './core.js';
import {redactSensitiveUrlLikeString} from './web/net-policy/redact-sensitive-url.js';
import {safeTerminalText} from './terminal-format.js';

export function redactPublicArgs(core:Core,value:unknown,key='',secrets?:readonly string[]):unknown {
  if(!secrets){try{secrets=core.redactionValues();}catch{return '[unavailable]';}}
  if(/(?:password|secret|token|api[-_]?key|authorization|refresh|cookie|^key$)/i.test(key))return '[hidden]';
  if(typeof value==='string'){
    let text=safeTerminalText(value);for(const secret of secrets)if(secret.length>=4)text=text.split(secret).join('[hidden]');
    return redactSensitiveUrlLikeString(text).replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+/gi,'$1[hidden]').replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,'[hidden]');
  }
  if(Array.isArray(value))return value.map(item=>redactPublicArgs(core,item,key,secrets));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,redactPublicArgs(core,item,name,secrets)]));
  return value;
}
