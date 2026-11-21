/*! Provider selection adapted from Hermes 0.23.1 agent/web_search_registry.py and plugins/web/keyless_mcp.py.
 * Copyright (c) 2025 Nous Research. MIT license in LICENSE.hermes.
 */
import {createHash,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {captureWebProxyEnvironment} from './net-policy/proxy-env.js';
import {urlContainsCredential} from './url-credentials.js';

export const webProviderNames=['tavily','perplexity','exa','parallel','keenable','firecrawl','searxng','brave'] as const;
export type WebProviderName=typeof webProviderNames[number];
export const keylessProviders=['exa','parallel','firecrawl','keenable'] as const;
export type KeylessProvider=typeof keylessProviders[number];
const providerName=z.enum(webProviderNames),environmentName=z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128);
const publicEndpoint=z.url().max(2048).refine(value=>{try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash&&!urlContainsCredential(value);}catch{return false;}},'Expected an HTTP(S) endpoint without credentials, query or fragment');
export const automaticWebConfigurationSchema=z.object({type:z.literal('auto'),backend:providerName.optional(),searchBackend:z.enum(['auto','none',...webProviderNames]).optional(),extractBackend:z.enum(['auto','none','direct',...webProviderNames]).optional(),keylessFallback:z.boolean().default(true),keylessRescue:z.boolean().default(true),cacheEnabled:z.boolean().default(true),cacheTtlMinutes:z.number().min(1).max(1440).default(20),providerTiers:z.partialRecord(providerName,z.enum(['auto','free','paid'])).default({}),providers:z.partialRecord(providerName,z.object({apiKeyEnv:environmentName.optional(),baseURL:publicEndpoint.optional()}).strict()).default({})}).strict();
export type AutomaticWebConfiguration=z.infer<typeof automaticWebConfigurationSchema>;
export function webConfigurationContainsCredential(configuration:unknown,knownValues:readonly string[]=[]){if(!configuration||typeof configuration!=='object'||Array.isArray(configuration))return false;const row=configuration as Record<string,unknown>,endpoints:unknown[]=[row.baseURL];if(row.providers&&typeof row.providers==='object'&&!Array.isArray(row.providers))for(const provider of Object.values(row.providers)){if(provider&&typeof provider==='object'&&!Array.isArray(provider)&&'baseURL'in provider)endpoints.push(provider.baseURL);}return endpoints.some(endpoint=>typeof endpoint==='string'&&urlContainsCredential(endpoint,knownValues));}
export interface ResolvedProvider {name:WebProviderName;mode:'keyed'|'keyless';key:string;endpoint:string;explicit:boolean;selfHosted:boolean;configurationError?:'web_provider_endpoint_invalid'|'web_provider_endpoint_missing'}
export type ProviderRoute={kind:'provider';provider:ResolvedProvider}|{kind:'direct'}|{kind:'disabled';reason:string};
export interface WebProviderCatalogEntry {id:WebProviderName;search:boolean;extract:boolean;credentialConfigured:boolean;configured:boolean;keyless:boolean;tier:'auto'|'free'|'paid';endpoint:string;availability:'available'|'keyless'|'unavailable'|'invalid configuration';errorCode?:'web_provider_configuration_invalid'|'web_provider_credentials_unavailable'}
export interface WebProviderRuntime {configuration:AutomaticWebConfiguration;search:ProviderRoute;extract:ProviderRoute;credentials:Readonly<Record<WebProviderName,string>>;endpoints:Readonly<Record<WebProviderName,string>>;credentialNames:string[];identity:string;networkIdentity:string;proxyEnvironment:Readonly<Record<string,string|undefined>>;catalog:WebProviderCatalogEntry[]}
const keyNames:Record<WebProviderName,string>={tavily:'TAVILY_API_KEY',perplexity:'PERPLEXITY_API_KEY',exa:'EXA_API_KEY',parallel:'PARALLEL_API_KEY',keenable:'KEENABLE_API_KEY',firecrawl:'FIRECRAWL_API_KEY',searxng:'',brave:'BRAVE_SEARCH_API_KEY'};
const defaults:Record<WebProviderName,string>={tavily:'https://api.tavily.com',perplexity:'https://api.perplexity.ai',exa:'https://api.exa.ai',parallel:'https://api.parallel.ai',keenable:'https://api.keenable.ai',firecrawl:'https://api.firecrawl.dev',searxng:'',brave:'https://api.search.brave.com'};
const endpointEnvironment:Partial<Record<WebProviderName,string>>={tavily:'TAVILY_BASE_URL',perplexity:'PERPLEXITY_BASE_URL',firecrawl:'FIRECRAWL_API_URL',searxng:'SEARXNG_URL'};
const canExtract=(name:WebProviderName)=>name!=='brave'&&name!=='searxng';
export const isKeylessProvider=(name:WebProviderName):name is KeylessProvider=>keylessProviders.some(value=>value===name);
export class WebProviderRing {
  private cursor:number;
  constructor(seed=randomBytes(4).readUInt32BE()){this.cursor=seed%keylessProviders.length;}
  order(runtime:WebProviderRuntime,pinned?:WebProviderName){const start=pinned?isKeylessProvider(pinned)?keylessProviders.indexOf(pinned):0:this.cursor;if(!pinned)this.cursor=(this.cursor+1)%keylessProviders.length;return [...keylessProviders.slice(start),...keylessProviders.slice(0,start)].filter(name=>runtime.configuration.providerTiers[name]!=='paid');}
  peek(){return [...keylessProviders.slice(this.cursor),...keylessProviders.slice(0,this.cursor)];}
}

/** Re-selects only the anonymous cursor from already frozen facts; no credential or configuration reads. */
export function webRuntimeForCall(runtime:WebProviderRuntime,ring:WebProviderRing):WebProviderRuntime{
  const current=(route:ProviderRoute):ProviderRoute=>{if(route.kind!=='provider'||route.provider.mode!=='keyless'||!isKeylessProvider(route.provider.name)||route.provider.explicit||runtime.configuration.providerTiers[route.provider.name]==='free'||runtime.credentials[route.provider.name])return route;const name=ring.peek().find(name=>runtime.configuration.providerTiers[name]!=='paid');return name?{kind:'provider',provider:{name,mode:'keyless',key:'',endpoint:runtime.endpoints[name],explicit:false,selfHosted:false}}:route;};
  return {...runtime,search:current(runtime.search),extract:current(runtime.extract)};
}

export function webProviderNetworkOptions(runtime:WebProviderRuntime,name:WebProviderName,mode:'keyed'|'keyless',apiURL:string){
  const origin=new URL(apiURL).origin,selected=[runtime.search,runtime.extract].find(route=>route.kind==='provider'&&route.provider.name===name&&route.provider.mode===mode);
  const selfHosted=selected?.kind==='provider'&&selected.provider.selfHosted&&new URL(selected.provider.endpoint).origin===origin;
  return {trustedProviderOrigin:origin,...(selfHosted?{selfHostedOrigin:origin}:{}),proxyEnvironment:runtime.proxyEnvironment};
}

/** A directory is descriptive even while dispatch is disabled. Invalid rows expose no unsafe endpoint. */
export function webProviderCatalog(input:Pick<z.input<typeof automaticWebConfigurationSchema>,'providers'|'providerTiers'>,readCredential:(name:string)=>string|undefined,environment:Readonly<Record<string,string|undefined>>=process.env):WebProviderCatalogEntry[]{
  const credentials=new Map<WebProviderName,string>(),unavailable=new Set<WebProviderName>();for(const name of webProviderNames){const variable=input.providers?.[name]?.apiKeyEnv??keyNames[name];if(!variable||!environmentName.safeParse(variable).success)continue;try{credentials.set(name,(readCredential(variable)??'').trim());}catch{unavailable.add(name);}}const knownValues=[...credentials.values()].filter(Boolean);
  return webProviderNames.map(name=>{
    const tier=z.enum(['auto','free','paid']).safeParse(input.providerTiers?.[name]??'auto'),hint=z.object({apiKeyEnv:environmentName.optional(),baseURL:publicEndpoint.optional()}).strict().safeParse(input.providers?.[name]??{}),base={id:name,search:true,extract:canExtract(name),credentialConfigured:false,configured:false,keyless:isKeylessProvider(name)||name==='tavily',tier:tier.success?tier.data:'auto' as const,endpoint:''};
    if(!tier.success||!hint.success)return {...base,availability:'invalid configuration',errorCode:'web_provider_configuration_invalid'};
    const endpointVariable=endpointEnvironment[name],raw=hint.data.baseURL??(endpointVariable?environment[endpointVariable]?.trim():undefined)??defaults[name],endpoint=raw?publicEndpoint.safeParse(raw):undefined;
    if(endpoint&&(!endpoint.success||urlContainsCredential(raw,knownValues)))return {...base,availability:'invalid configuration',errorCode:'web_provider_configuration_invalid'};
    const credentialConfigured=Boolean(credentials.get(name));if(unavailable.has(name))return {...base,endpoint:endpoint?.success?endpoint.data:'',availability:'invalid configuration',errorCode:'web_provider_credentials_unavailable'};
    const selfHosted=Boolean(hint.data.baseURL||(endpointVariable&&environment[endpointVariable])),configured=credentialConfigured||name==='searxng'&&Boolean(raw)||selfHosted;
    return {...base,endpoint:endpoint?.success?endpoint.data:'',credentialConfigured,configured,availability:configured?'available':base.keyless&&base.tier!=='paid'?'keyless':'unavailable'};
  });
}

/** Resolves configuration and credential presence without contacting or silently replacing a selected provider. */
export function resolveWebRuntime(input:z.input<typeof automaticWebConfigurationSchema>,readCredential:(name:string)=>string|undefined,environment:Readonly<Record<string,string|undefined>>=process.env,ring=new WebProviderRing()):WebProviderRuntime{
  const configuration=automaticWebConfigurationSchema.parse(input),credentialNames:string[]=[],credentials={} as Record<WebProviderName,string>,endpoints={} as Record<WebProviderName,string>,endpointErrors:Partial<Record<WebProviderName,'web_provider_endpoint_invalid'|'web_provider_endpoint_missing'>>={},endpointFingerprints:Partial<Record<WebProviderName,string>>={};
  for(const name of webProviderNames){const variable=configuration.providers[name]?.apiKeyEnv??keyNames[name];if(variable)credentialNames.push(variable);credentials[name]=variable?(readCredential(variable)??'').trim():'';}
  for(const name of webProviderNames){const endpointVariable=endpointEnvironment[name],environmentEndpoint=endpointVariable?environment[endpointVariable]?.trim():undefined,raw=configuration.providers[name]?.baseURL??environmentEndpoint??defaults[name];if(!raw){endpoints[name]='';endpointErrors[name]='web_provider_endpoint_missing';}else if(!publicEndpoint.safeParse(raw).success||urlContainsCredential(raw,Object.values(credentials).filter(Boolean))){endpoints[name]='';endpointErrors[name]='web_provider_endpoint_invalid';endpointFingerprints[name]=createHash('sha256').update(raw).digest('hex');}else endpoints[name]=raw;}
  const selfHosted=(name:WebProviderName)=>name==='searxng'||Boolean(configuration.providers[name]?.baseURL||(endpointEnvironment[name]&&environment[endpointEnvironment[name]!]));
  const selected=(name:WebProviderName,explicit:boolean):ResolvedProvider=>{const tier=configuration.providerTiers[name]??'auto',custom=selfHosted(name),eligible=isKeylessProvider(name)||name==='tavily';return {name,mode:eligible&&!custom&&(tier==='free'||!credentials[name]&&configuration.keylessFallback&&tier!=='paid')?'keyless':'keyed',key:credentials[name],endpoint:endpoints[name],explicit,selfHosted:custom,...(endpointErrors[name]?{configurationError:endpointErrors[name]}:{})};};
  const available=(name:WebProviderName)=>!endpointErrors[name]&&(name==='searxng'?Boolean(endpoints[name]):Boolean(credentials[name])||selfHosted(name));
  const resolve=(capability:'search'|'extract'):ProviderRoute=>{
    const perCapability=capability==='search'?configuration.searchBackend:configuration.extractBackend,name=perCapability==='auto'?undefined:perCapability??configuration.backend;
    if(name==='none')return {kind:'disabled',reason:`Web ${capability} is disabled.`};if(name==='direct')return {kind:'direct'};if(name)return {kind:'provider',provider:selected(name,true)};
    const eligible=webProviderNames.filter(name=>(capability==='search'||canExtract(name))&&available(name));if(eligible.length)return {kind:'provider',provider:selected(eligible[0]!,false)};
    if(configuration.keylessFallback){const name=ring.peek().find(name=>configuration.providerTiers[name]!=='paid');if(name)return {kind:'provider',provider:selected(name,false)};}
    return {kind:'disabled',reason:`No web ${capability} provider is configured.`};
  };
  const search=resolve('search'),extract=resolve('extract'),catalog=webProviderCatalog(configuration,variable=>{const name=webProviderNames.find(name=>(configuration.providers[name]?.apiKeyEnv??keyNames[name])===variable);return name?credentials[name]:undefined;},environment);
  const proxyEnvironment=captureWebProxyEnvironment(environment),networkIdentity=createHash('sha256').update(JSON.stringify([proxyEnvironment,endpointFingerprints])).digest('hex');
  return {configuration,search,extract,credentials,endpoints,credentialNames:[...new Set(credentialNames)].sort(),networkIdentity,proxyEnvironment,identity:createHash('sha256').update(JSON.stringify([configuration,credentials,endpoints,networkIdentity])).digest('hex'),catalog};
}
