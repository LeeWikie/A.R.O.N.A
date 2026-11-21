import {isBase64String} from '../../src/base64.js';

export function hasNativeImage(input:unknown,expected:Uint8Array):boolean{
 const seen=new Set<object>(),same=(value:unknown)=>value instanceof Uint8Array?Buffer.from(value).equals(expected):typeof value==='string'&&isBase64String(value.startsWith('data:image/')?value.slice(value.indexOf(',')+1):value)&&Buffer.from(value.startsWith('data:image/')?value.slice(value.indexOf(',')+1):value,'base64').equals(expected);
 const walk=(value:unknown):boolean=>{
  if(!value||typeof value!=='object'||value instanceof Uint8Array||seen.has(value))return false;seen.add(value);const part=value as Record<string,unknown>,type=part.type,mime=part.mediaType??part.mimeType;
  if(type==='image'&&(mime===undefined||typeof mime==='string'&&mime.startsWith('image/'))&&same(part.image??part.data)||(type==='media'||type==='file')&&typeof mime==='string'&&mime.startsWith('image/')&&same(part.data))return true;
  return Object.values(value).some(walk);
 };return walk(input);
}
