/*! Response normalization adapted from Hermes 0.23.1 plugins/web/keyless_mcp.py,
 * plugins/web/_common.py and plugins/web/firecrawl/provider.py.
 * Copyright (c) 2025 Nous Research. MIT license in LICENSE.hermes.
 */
export interface WebSearchHit {url:string;title:string;description:string;position:number;providerData?:Record<string,unknown>}
export interface WebProviderPage {url:string;sourceURL:string;title:string;content:string;status:number|null;error?:string;coverage:'full'|'excerpt'}
export interface ProviderAttempt {url:string;status:number|null;error?:string;bytes?:number;wireBytes?:number;sha256?:string;truncated?:boolean}
export interface ProviderReceipt {kind:'provider-api-response';url:string;status:number;bytes:number;wireBytes:number;sha256:string;truncated:boolean;retryCount?:number;attempts?:ProviderAttempt[]}
export class WebProviderError extends Error {constructor(message:string,readonly httpStatus?:number,readonly receipt?:ProviderReceipt,readonly retry?:{allowed?:boolean;afterMs?:number},readonly attempts?:ProviderAttempt[]){super(message);this.name='WebProviderError';}}
export const webObject=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
export const webList=(value:unknown):Record<string,unknown>[]=>Array.isArray(value)?value.flatMap(item=>{const row=webObject(item);return row?[row]:[];}):[];
export const webString=(value:unknown)=>typeof value==='string'?value:'';
export const webTextList=(value:unknown)=>Array.isArray(value)?value.filter((item):item is string=>typeof item==='string'):[];
const lines=(text:string)=>text.split(/\r\n|[\r\n\v\f\x1c-\x1e\x85\u2028\u2029]/u);

export function parseMCPBody(body:string):string{
  const stripped=body.trim(),candidates=[...(stripped.startsWith('{')?[stripped]:[]),...body.split(/\r\n|\r|\n/u).filter(line=>line.startsWith('data: ')).map(line=>line.slice(6))];let envelopeSeen=false;
  for(const candidate of candidates){if(!candidate.trim().startsWith('{'))continue;let input:unknown;try{input=JSON.parse(candidate);}catch{continue;}const row=webObject(input);if(!row)continue;const error=webObject(row.error);if(row.error)throw new WebProviderError(webString(error?.message)||JSON.stringify(row.error));const result=webObject(row.result),texts=webList(result?.content).map(part=>webString(part.text));if(result?.isError)throw new WebProviderError(texts.filter(Boolean).join(' ')||'MCP tool call failed');const text=texts.find(Boolean);if(text)return text;envelopeSeen=true;}
  throw new WebProviderError(envelopeSeen?'MCP response contained no text content':'Unrecognized MCP response shape');
}
export function parseExaSearch(text:string,limit:number):WebSearchHit[]{
  const results:WebSearchHit[]=[],labels=['Title:','URL:','Highlights:','Published:','Author:'];for(const block of text.split('\n---\n')){let title='',url='',inHighlights=false;const highlights:string[]=[];for(const line of lines(block).map(line=>line.trim())){if(line.startsWith('Title:'))title=line.slice(6).trim();else if(line.startsWith('URL:'))url=line.slice(4).trim();else if(inHighlights&&line&&!labels.some(label=>line.startsWith(label)))highlights.push(line);if(labels.some(label=>line.startsWith(label)))inHighlights=line.startsWith('Highlights:');}if(url)results.push({url,title,description:highlights.join(' '),position:results.length+1});if(limit&&results.length>=limit)break;}return results;
}
export function originStatus(value:unknown){if(typeof value==='boolean'||value===null||value===undefined||value==='')return null;const status=Number(value);return Number.isInteger(status)&&status>=100&&status<=599?status:null;}
export function originHTTPError(status:unknown,reason?:unknown){const code=originStatus(status);return code!==null&&code>=400?`HTTP ${code} from origin${typeof reason==='string'&&reason.trim()?': '+reason.trim():''}`:undefined;}
export const isOriginError=(message:unknown)=>typeof message==='string'&&/^HTTP \d{3} from origin(?::|$)/u.test(message);
export function exaCrawlStatus(value:unknown){const match=/\bCRAWL_(?:HTTP_(\d{3})|(NOT_FOUND))\s*$/u.exec(String(value??''));return match?match[1]?Number(match[1]):404:null;}
export function keenableOriginError(status:unknown,body:string){let input:unknown;try{input=JSON.parse(body);}catch{return;}const message=webString(webObject(input)?.message).trim();return /^the (?:target server|page does not exist)\b/iu.test(message)?originHTTPError(status,message):undefined;}
export function providerFailure(url:string,error:string,body='',status:number|null=null):WebProviderPage{return {url,sourceURL:url,title:'',content:body,status,error,coverage:'full'};}
export function vendorFailure(url:string,status:unknown,reason:unknown,body:unknown):WebProviderPage{const code=originStatus(status),origin=originHTTPError(code);return providerFailure(url,origin||webString(body)||webString(reason)||'extraction failed',origin?webString(body):'',code);}
export function firecrawlSearchRows(input:unknown){const root=webObject(input),data=webObject(root?.data);if(Array.isArray(root?.data))return webList(root.data);for(const value of [data?.web,data?.results,root?.web,root?.results]){const rows=webList(value);if(rows.length)return rows;}return [];}
export function firecrawlPage(url:string,input:unknown):WebProviderPage{
  const root=webObject(input)??{},data=webObject(root.data)??root,metadata=webObject(data.metadata),finalURL=webString(metadata?.sourceURL)||webString(metadata?.source_url)||url,status=originStatus(metadata?.statusCode??metadata?.status_code),error=originHTTPError(status,metadata?.error),content=webString(data.markdown)||webString(data.html);
  return {url:finalURL,sourceURL:url,title:webString(metadata?.title),content,status,...(error?{error}:{}),coverage:'full'};
}
const rateMarkers=['rate limit','rate-limit','ratelimit','too many requests','429','quota exceeded','slow down'];
export const isRateLimit=(message:string)=>rateMarkers.some(marker=>message.toLowerCase().includes(marker));
export const searchCanFailover=(message:string)=>isRateLimit(message)||/^\s*(?:keyless\s+\w+\s+search\s+failed:\s*)?(?:http(?:\s+status)?|status(?:\s+code)?|client\s+error|error\s+code)\s*[:=']*\s*(?:40[123]|5\d\d)\b/iu.test(message);
export const extractCanFailover=(pages:readonly WebProviderPage[])=>pages.length>0&&pages.every(page=>Boolean(page.error)&&!isOriginError(page.error)&&isRateLimit(page.error!));
export function queryForURLs(urls:readonly string[]){const words:string[]=[];for(const value of urls){const url=new URL(value);for(const token of url.pathname.replace(/[-_/]/gu,' ').split(/\s+/u)){const word=token.toLowerCase();if(word&&!words.includes(word)&&!/^\p{Nd}+$/u.test(word))words.push(word);}if(!url.pathname.replaceAll('/',''))words.push(url.host);}return words.join(' ').slice(0,500)||urls.join(' ').slice(0,500);}
