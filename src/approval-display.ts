import type {Core} from './core.js';
import {redactPublicArgs} from './public-args.js';
import {safeTerminalText} from './terminal-format.js';

const terminalControls=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const directionControls=/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Permission reviews describe control characters without recovering hidden terminal payloads. */
export function publicArgumentDisplay(core:Core,args:unknown,providedSecrets?:readonly string[]):{args:unknown;argsText:string;changed:boolean}{
 let secrets:readonly string[];try{secrets=providedSecrets??core.redactionValues();}catch{return{args:'[unavailable]',argsText:'"[unavailable]"',changed:false};}
 let changed=false;
 const string=(value:string,key='')=>{
  const normalized=safeTerminalText(value),safe=redactPublicArgs(core,value,key,secrets);
  if(value!==normalized)changed=true;
  if(terminalControls.test(value)){changed=true;return '[含终端控制内容，未显示]';}
  return safe===normalized?value:safe;
 };
 const visit=(value:unknown,key=''):unknown=>{
  if(redactPublicArgs(core,null,key,secrets)==='[hidden]')return '[hidden]';
  if(typeof value==='string')return string(value,key);
  if(Array.isArray(value))return value.map(item=>visit(item,key));
  if(value&&typeof value==='object'){
   const names=new Set<string>(),entries:Array<[string,unknown]>=[];for(const[name,child]of Object.entries(value)){let displayName=String(string(name));if(displayName!==name){changed=true;let suffix=1;const base=displayName;while(names.has(displayName))displayName=`${base} #${++suffix}`;}else if(names.has(displayName)){let suffix=1;while(names.has(`${displayName} #${suffix}`))suffix++;displayName+=` #${suffix}`;changed=true;}names.add(displayName);entries.push([displayName,visit(child,name)]);}return Object.fromEntries(entries);
  }
  return value;
 };
 const escaped=(text:string)=>text.replace(directionControls,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));
 const display=visit(args),argsText=escaped(JSON.stringify(display,null,2)??'null');
 const legacy=(value:unknown):unknown=>{
  if(typeof value==='string')return value!==safeTerminalText(value)?{显示值:escaped(JSON.stringify(value)),表示:'JSON 字符串'}:value;
  if(Array.isArray(value))return value.map(legacy);
  if(value&&typeof value==='object'){const names=new Set<string>(),entries:Array<[string,unknown]>=[];let index=0;for(const[name,child]of Object.entries(value)){let label=name===safeTerminalText(name)?name:`字段 ${++index}（JSON 名称 ${escaped(JSON.stringify(name))}）`;const base=label;let suffix=1;while(names.has(label))label=`${base} #${++suffix}`;names.add(label);entries.push([label,legacy(child)]);}return Object.fromEntries(entries);}
  return value;
 };
 return{args:changed?legacy(display):redactPublicArgs(core,args,'',secrets),argsText,changed};
}

export const approvalDisplay=publicArgumentDisplay;
