import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { cleanupSessionResources, getSupportedThinkingLevels, type Models as PiModels,type Model,type Api,type ModelImageResizeOptions } from '@earendil-works/pi-ai';
import {adjustMaxTokensForThinking} from '@earendil-works/pi-ai/api/simple-options';
import { createModel } from './model.js';
import { createPiLanguageModel,type PiRequestObserver } from './providers/bridge.js';
import type { ModelConfig } from './config.js';
import { AppError } from './domain.js';
import type { RuntimeStore } from './runtime-store.js';
import type { AgentExecutionOptions } from '@mastra/core/agent';
type ProviderOptions = NonNullable<AgentExecutionOptions['providerOptions']>;
import type { RequestContext } from '@mastra/core/request-context';

export const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = typeof thinkingLevels[number];
export type ThinkingCapabilitySource='provider-metadata'|'profile'|'startup-config'|'unknown';
export interface ModelState {
  contextId:string;profileId:string;name:string;modelId:string|null;providerId:string|null;
  thinkingLevel:ThinkingLevel|null;requestedThinkingLevel:ThinkingLevel|null;defaultThinkingLevel:ThinkingLevel|null;
  thinkingLevels:ThinkingLevel[];nextThinkingLevel:ThinkingLevel|null;supportsThinking:boolean|null;thinkingCapabilitySource:ThinkingCapabilitySource;
  source:'session'|'profile'|'model-default'|'provider-default';unavailable:string|null;configuredProfiles:number;
}
/** Match Pi's ordered capability clamp: the next supported level, then the nearest lower level. */
export function clampThinkingChoice(requested:ThinkingLevel,available:readonly ThinkingLevel[]):ThinkingLevel|null {
  if(available.includes(requested))return requested;
  const start=thinkingLevels.indexOf(requested);
  return thinkingLevels.slice(start).find(level=>available.includes(level))??[...thinkingLevels.slice(0,start)].reverse().find(level=>available.includes(level))??available[0]??null;
}
const protocolProfileSchema = z.object({
  id: z.string().regex(/^[\w.-]{1,80}$/), name: z.string().min(1).max(160),
  protocol: z.enum(['chat-completions', 'responses', 'messages']),
  baseURL: z.url().refine(s => { const u = new URL(s); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; }),
  modelId: z.string().min(1).max(200), apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  authHeader: z.enum(['api-key', 'bearer']).default('api-key'),
  requestAuth: z.enum(['api-key', 'bearer']).optional(),
  contextWindow: z.number().int().positive().safe().optional(),
  maxTokens: z.number().int().positive().safe().optional(),
  defaultThinkingLevel:z.enum(thinkingLevels).optional(),
  thinkingMode:z.enum(['auto','manual']).optional(),
  thinking: z.record(z.string(), z.record(z.string(), z.json())).default({}),
}).strict().superRefine((profile, ctx) => {
  const openai = z.object({ reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) }).strict();
  const anthropic = z.object({
    thinking: z.discriminatedUnion('type', [z.object({ type: z.literal('adaptive') }).strict(), z.object({ type: z.literal('disabled') }).strict(), z.object({ type: z.literal('between_tools') }).strict(), z.object({ type: z.literal('enabled'), budgetTokens: z.number().int().min(1024) }).strict()]).optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  }).strict().refine(x => x.thinking !== undefined || x.effort !== undefined);
  for (const [level, options] of Object.entries(profile.thinking)) {
    if (!thinkingLevels.includes(level as ThinkingLevel) || !(profile.protocol === 'messages' ? anthropic : openai).safeParse(options).success) ctx.addIssue({ code: 'custom', path: ['thinking', level], message: 'Invalid thinking options' });
  }
});
const providerProfileSchema = z.object({
  id: z.string().regex(/^[\w.-]{1,80}$/), name: z.string().min(1).max(160),
  providerId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/), modelId: z.string().min(1).max(200),
  defaultThinkingLevel: z.enum(thinkingLevels).optional(),
}).strict();
export const profileSchema = z.union([protocolProfileSchema, providerProfileSchema]);
export type ModelProfile = z.infer<typeof profileSchema>;
export interface ControllerIdentity { threadId?: string; session?: { id?: string; modelId?: string; thinkingLevel?: ThinkingLevel } }
export function controllerIdentity(context?: RequestContext): ControllerIdentity {
  return (context?.get('controller') as ControllerIdentity | undefined) ?? {};
}
export class Models {
  private readonly seed?: ModelConfig;
  private readonly sessionScope: string;
  private readonly sessionResources = new Map<string, { contextId: string; providerId: string }>();
  private closed = false;
  constructor(private readonly store: RuntimeStore, seed?: ModelConfig, private readonly credential: (name:string)=>string|undefined = name=>process.env[name], readonly providers?: PiModels) {
    this.seed = seed && { ...seed };
    this.sessionScope = this.store.setting<string>('protocol-storage-id', '') || randomUUID();
  }
  private providerSessionId(contextId: string, providerId: string): string {
    const sessionId = 'sc-' + createHash('sha256').update(JSON.stringify([this.sessionScope, providerId, contextId])).digest('hex');
    this.sessionResources.set(sessionId, { contextId, providerId });
    return sessionId;
  }
  private releaseResources(matches: (resource: { contextId: string; providerId: string }) => boolean): void {
    const errors: unknown[] = [];
    for (const [sessionId, resource] of this.sessionResources) {
      if (!matches(resource)) continue;
      try { cleanupSessionResources(sessionId); }
      catch (error) { errors.push(error); }
      finally { this.sessionResources.delete(sessionId); }
    }
    if (errors.length) throw new AggregateError(errors, 'provider_session_cleanup_failed');
  }
  disposeSession(contextId: string): void { this.releaseResources(resource => resource.contextId === contextId); }
  disposeProvider(providerId: string): void { this.releaseResources(resource => resource.providerId === providerId); }
  close(): void { this.closed = true; this.releaseResources(() => true); }
  configurationProfiles():ModelProfile[] {
    const rows=this.store.setting<ModelProfile[]>('models',[]);
    if(this.seed&&!rows.some(row=>row.id==='default')){
      const level=this.seed.reasoningEffort===undefined?undefined:this.seed.reasoningEffort==='none'?'off':this.seed.reasoningEffort;
      const profile:ModelProfile={id:'default',name:'Default',protocol:this.seed.protocol,baseURL:this.seed.baseURL,modelId:this.seed.modelId,authHeader:this.seed.authHeader,...(this.seed.requestAuth?{requestAuth:this.seed.requestAuth}:{}),apiKeyEnv:'SHITTIMCHEST_STARTUP_MODEL_KEY',thinking:{},...(level?{defaultThinkingLevel:level}:{}),...(this.seed.contextWindow?{contextWindow:this.seed.contextWindow}:{}),...(this.seed.maxTokens?{maxTokens:this.seed.maxTokens}:{})};
      // A configured default is a preference, not the model's complete support set.
      if(level&&!this.catalogModel(profile))profile.thinking={[level]:{reasoningEffort:level==='off'?'none':level}};
      rows.unshift(profile);
    }
    return rows;
  }
  list() {
    return this.configurationProfiles().map(row=>{if('providerId' in row)return row;const {apiKeyEnv:_,...visible}=row;return visible;});
  }
  profile(id: string): ModelProfile | undefined { return this.store.setting<ModelProfile[]>('models', []).find(x => x.id === id); }
  private catalogModel(profile:ModelProfile):Model<Api>|undefined {
    if(!this.providers)return undefined;
    if('providerId' in profile)return this.providers.getModel(profile.providerId,profile.modelId);
    const api=profile.protocol==='responses'?'openai-responses':profile.protocol==='messages'?'anthropic-messages':'openai-completions';
    const canonical=this.providers.getModel(profile.protocol==='messages'?'anthropic':'openai',profile.modelId);
    if(canonical?.api===api)return canonical;
    const matches=this.providers.getModels().filter(model=>model.id===profile.modelId&&model.api===api);
    if(!matches.length)return undefined;
    const signatures=new Set(matches.map(model=>JSON.stringify([model.reasoning,getSupportedThinkingLevels(model),model.thinkingLevelMap,model.compat&&'forceAdaptiveThinking' in model.compat?model.compat.forceAdaptiveThinking:undefined])));
    return signatures.size===1?matches[0]:undefined;
  }
  private capability(profile:ModelProfile|undefined):{levels:ThinkingLevel[];source:ThinkingCapabilitySource;model?:Model<Api>} {
    if(!profile)return {levels:[],source:'unknown'};
    const explicit='thinking' in profile?thinkingLevels.filter(level=>Object.hasOwn(profile.thinking,level)):[];
    const model=this.catalogModel(profile);
    if('thinkingMode' in profile&&profile.thinkingMode==='manual')return {levels:explicit,source:'profile'};
    if(model){const native=getSupportedThinkingLevels(model);return {levels:thinkingLevels.filter(level=>native.includes(level)||explicit.includes(level)),source:'provider-metadata',model};}
    if(explicit.length)return {levels:explicit,source:profile.id==='default'&&!this.profile('default')?'startup-config':'profile'};
    return {levels:[],source:'unknown'};
  }
  thinking(id:string,requested?:ThinkingLevel) {
    const profile=this.configurationProfiles().find(item=>item.id===id),capability=this.capability(profile);
    const defaultRequest=profile?.defaultThinkingLevel??(capability.levels.length?'medium':undefined);
    const defaultThinkingLevel=defaultRequest?clampThinkingChoice(defaultRequest,capability.levels):null;
    const requestedThinkingLevel=requested??profile?.defaultThinkingLevel??null;
    const thinkingLevel=requested!==undefined?clampThinkingChoice(requested,capability.levels):defaultThinkingLevel;
    const supportsThinking=capability.levels.length?capability.levels.some(level=>level!=='off'):null;
    const nextThinkingLevel=supportsThinking&&capability.levels.length>1?capability.levels[(capability.levels.indexOf(thinkingLevel??'off')+1)%capability.levels.length]!:null;
    return {thinkingLevel,requestedThinkingLevel,defaultThinkingLevel,thinkingLevels:capability.levels,nextThinkingLevel,supportsThinking,thinkingCapabilitySource:capability.source,
      source:requested!==undefined?'session' as const:profile?.defaultThinkingLevel!==undefined?'profile' as const:defaultThinkingLevel!==null?'model-default' as const:'provider-default' as const};
  }
  limits(id: string): { contextWindow: number | null; maxTokens: number | null; source: 'profile' | 'provider-metadata' | 'unknown' } {
    const profile = this.configurationProfiles().find(item => item.id === id);
    if (profile && 'providerId' in profile) {
      const model = this.providers?.getModel(profile.providerId, profile.modelId);
      return { contextWindow: model?.contextWindow ?? null, maxTokens: model?.maxTokens ?? null, source: model ? 'provider-metadata' : 'unknown' };
    }
    return { contextWindow: profile?.contextWindow ?? null, maxTokens: profile?.maxTokens ?? null,
      source: profile?.contextWindow !== undefined || profile?.maxTokens !== undefined ? 'profile' : 'unknown' };
  }
  imageReadOptions(id: string): { resizeOptions?: ModelImageResizeOptions; supportsImages?: boolean } {
    const profile = this.configurationProfiles().find(row => row.id === id);
    if (!profile || !this.providers) return {};
    let model: Model<Api> | undefined;
    if ('providerId' in profile) model = this.providers.getModel(profile.providerId, profile.modelId);
    else {
      const api = profile.protocol === 'responses' ? 'openai-responses' : profile.protocol === 'messages' ? 'anthropic-messages' : 'openai-completions';
      const address = (value: string) => { try { return new URL(value).href.replace(/\/+$/, ''); } catch { return undefined; } };
      const target = address(profile.baseURL);
      const candidates = this.providers.getModels().filter(row => row.id === profile.modelId && row.api === api && address(row.baseUrl) === target);
      if (candidates.length && new Set(candidates.map(row => JSON.stringify([row.input, row.inputLimits?.images?.resize]))).size === 1) model = candidates[0];
    }
    if (!model) return {};
    const resize = model.inputLimits?.images?.resize;
    return { ...(Array.isArray(model.input) ? { supportsImages: model.input.includes('image') } : {}), ...(resize ? { resizeOptions: structuredClone(resize) } : {}) };
  }
  save(body: unknown) {
    const result = profileSchema.safeParse(body); if (!result.success) throw new AppError('invalid_model_profile');
    if ('providerId' in result.data) {
      const model = this.providers?.getModel(result.data.providerId, result.data.modelId);
      if (!model) throw new AppError('model_not_found', 404);
    }
    if(result.data.defaultThinkingLevel!==undefined&&!this.capability(result.data).levels.length)throw new AppError('invalid_model_profile');
    const rows = this.store.setting<ModelProfile[]>('models', []); this.store.setSetting('models', [...rows.filter(x => x.id !== result.data.id), result.data]);
    return this.list().find(x => x.id === result.data.id)!;
  }
  resolve(id: string,observer?:PiRequestObserver): LanguageModelV4 {
    if (this.closed) throw new AppError('model_runtime_closed', 409);
    if (id === 'default' && this.seed && !this.profile(id)) return createModel(this.seed);
    const p = this.profile(id); if (!p) throw new AppError('model_profile_not_found', 404);
    if ('providerId' in p) {
      if (!this.providers) throw new AppError('model_provider_unavailable');
      const model = this.providers.getModel(p.providerId, p.modelId); if (!model) throw new AppError('model_not_found', 404);
      const providers = this.providers;
      const guarded: Pick<PiModels, 'streamSimple'> = { streamSimple: (target, context, options) => {
        if (this.closed) throw new AppError('model_runtime_closed', 409);
        return providers.streamSimple(target, context, options);
      } };
      return createPiLanguageModel(guarded, model,observer);
    }
    const apiKey = this.credential(p.apiKeyEnv)??(p.apiKeyEnv==='SHITTIMCHEST_STARTUP_MODEL_KEY'?this.seed?.apiKey:undefined); if (!apiKey) throw new AppError('model_credentials_unavailable');
    return createModel({ ...p, apiKey });
  }
  validateThinking(id: string, level?: ThinkingLevel) {
    if (level === undefined) return;
    if (!thinkingLevels.includes(level)) throw new AppError('thinking_level_not_supported');
    if(!this.thinking(id).thinkingLevels.includes(level))throw new AppError('thinking_level_not_supported');
  }
  options(id: string, level?: ThinkingLevel, sessionId?: string):{providerOptions?:ProviderOptions;maxOutputTokens?:number} {
    if (this.closed) throw new AppError('model_runtime_closed', 409);
    const p = this.configurationProfiles().find(profile=>profile.id===id); if (!p && id !== 'default') throw new AppError('model_profile_not_found', 404);
    if(level!==undefined&&!thinkingLevels.includes(level))throw new AppError('thinking_level_not_supported');
    const effective=this.thinking(id,level).thinkingLevel;
    if(level!==undefined&&effective===null)throw new AppError('thinking_level_not_supported');
    if (p && 'providerId' in p) {
      const effectiveLevel = effective;
      const pi: Record<string, string> = {
        ...(sessionId ? { sessionId: this.providerSessionId(sessionId, p.providerId) } : {}),
        ...(effectiveLevel && effectiveLevel !== 'off' ? { reasoning: effectiveLevel } : {}),
      };
      return Object.keys(pi).length ? { providerOptions: { pi } } : {};
    }
    const protocol = p?.protocol ?? this.seed?.protocol;
    let options: Record<string, z.infer<ReturnType<typeof z.json>>> = {};
    if (protocol === 'responses') options = { store: false, include: ['reasoning.encrypted_content'] };
    let maxOutputTokens:number|undefined;
    if(effective!==null&&p&&'thinking' in p){
      const mapped=p.thinking[effective];
      if(mapped)options={...options,...mapped};
      else {
        const model=this.catalogModel(p);
        if(model?.reasoning){
          if(protocol==='messages'){
            if(effective==='off')options.thinking={type:'disabled'};
            else if(model.compat&&'forceAdaptiveThinking' in model.compat&&model.compat.forceAdaptiveThinking===true){options.thinking={type:'adaptive'};options.effort=model.thinkingLevelMap?.[effective]??(effective==='minimal'?'low':effective);}
            else {const budget=adjustMaxTokensForThinking(undefined,p.maxTokens??model.maxTokens,effective);options.thinking={type:'enabled',budgetTokens:budget.thinkingBudget};maxOutputTokens=budget.maxTokens;}
          }else options.reasoningEffort=model.thinkingLevelMap?.[effective]??(effective==='off'?'none':effective);
        }
      }
    }
    const providerOptions: ProviderOptions = { [protocol === 'messages' ? 'anthropic' : 'openai']: options };
    return {...(Object.keys(options).length ? { providerOptions } : {}),...(maxOutputTokens?{maxOutputTokens}:{})};
  }
}
