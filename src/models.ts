import { z } from 'zod';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { getSupportedThinkingLevels, type Models as PiModels } from '@earendil-works/pi-ai';
import { createModel } from './model.js';
import { createPiLanguageModel,type PiRequestObserver } from './providers/bridge.js';
import type { ModelConfig } from './config.js';
import { AppError } from './domain.js';
import type { RuntimeStore } from './runtime-store.js';
import type { AgentExecutionOptions } from '@mastra/core/agent';
type ProviderOptions = NonNullable<AgentExecutionOptions['providerOptions']>;
import type { RequestContext } from '@mastra/core/request-context';

export const thinkingLevels = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = typeof thinkingLevels[number];
const protocolProfileSchema = z.object({
  id: z.string().regex(/^[\w.-]{1,80}$/), name: z.string().min(1).max(160),
  protocol: z.enum(['chat-completions', 'responses', 'messages']),
  baseURL: z.url().refine(s => { const u = new URL(s); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; }),
  modelId: z.string().min(1).max(200), apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  authHeader: z.enum(['api-key', 'bearer']).default('api-key'),
  defaultThinkingLevel:z.enum(thinkingLevels).optional(),
  thinking: z.record(z.string(), z.record(z.string(), z.json())).default({}),
}).strict().superRefine((profile, ctx) => {
  const openai = z.object({ reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) }).strict();
  const anthropic = z.object({
    thinking: z.discriminatedUnion('type', [z.object({ type: z.literal('adaptive') }).strict(), z.object({ type: z.literal('disabled') }).strict(), z.object({ type: z.literal('between_tools') }).strict(), z.object({ type: z.literal('enabled'), budgetTokens: z.number().int().min(1024) }).strict()]).optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  }).strict().refine(x => x.thinking !== undefined || x.effort !== undefined);
  if(profile.defaultThinkingLevel!==undefined&&!profile.thinking[profile.defaultThinkingLevel])ctx.addIssue({code:'custom',path:['defaultThinkingLevel'],message:'Missing default thinking mapping'});
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
  constructor(private readonly store: RuntimeStore, seed?: ModelConfig, private readonly credential: (name:string)=>string|undefined = name=>process.env[name], readonly providers?: PiModels) { this.seed = seed && { ...seed }; }
  configurationProfiles():ModelProfile[] {
    const rows=this.store.setting<ModelProfile[]>('models',[]);
    if(this.seed&&!rows.some(row=>row.id==='default')){
      const level=this.seed.reasoningEffort===undefined?undefined:this.seed.reasoningEffort==='none'?'off':this.seed.reasoningEffort;
      rows.unshift({id:'default',name:'Default',protocol:this.seed.protocol,baseURL:this.seed.baseURL,modelId:this.seed.modelId,authHeader:this.seed.authHeader,apiKeyEnv:'SHITTIMCHEST_STARTUP_MODEL_KEY',thinking:level?{[level]:{reasoningEffort:level==='off'?'none':level}}:{},...(level?{defaultThinkingLevel:level}:{})});
    }
    return rows;
  }
  list() {
    return this.configurationProfiles().map(row=>{if('providerId' in row)return row;const {apiKeyEnv:_,...visible}=row;return visible;});
  }
  profile(id: string): ModelProfile | undefined { return this.store.setting<ModelProfile[]>('models', []).find(x => x.id === id); }
  save(body: unknown) {
    const result = profileSchema.safeParse(body); if (!result.success) throw new AppError('invalid_model_profile');
    if ('providerId' in result.data) {
      const model = this.providers?.getModel(result.data.providerId, result.data.modelId);
      if (!model) throw new AppError('model_not_found', 404);
      if (result.data.defaultThinkingLevel !== undefined && !getSupportedThinkingLevels(model).includes(result.data.defaultThinkingLevel)) throw new AppError('thinking_level_not_supported');
    }
    const rows = this.store.setting<ModelProfile[]>('models', []); this.store.setSetting('models', [...rows.filter(x => x.id !== result.data.id), result.data]);
    return this.list().find(x => x.id === result.data.id)!;
  }
  resolve(id: string,observer?:PiRequestObserver): LanguageModelV4 {
    if (id === 'default' && this.seed && !this.profile(id)) return createModel(this.seed);
    const p = this.profile(id); if (!p) throw new AppError('model_profile_not_found', 404);
    if ('providerId' in p) {
      if (!this.providers) throw new AppError('model_provider_unavailable');
      const model = this.providers.getModel(p.providerId, p.modelId); if (!model) throw new AppError('model_not_found', 404);
      return createPiLanguageModel(this.providers, model,observer);
    }
    const apiKey = this.credential(p.apiKeyEnv)??(p.apiKeyEnv==='SHITTIMCHEST_STARTUP_MODEL_KEY'?this.seed?.apiKey:undefined); if (!apiKey) throw new AppError('model_credentials_unavailable');
    return createModel({ ...p, apiKey });
  }
  validateThinking(id: string, level?: ThinkingLevel) {
    if (level === undefined) return;
    if (!thinkingLevels.includes(level)) throw new AppError('thinking_level_not_supported');
    const p = this.profile(id);
    if (p && 'providerId' in p) {
      const model = this.providers?.getModel(p.providerId, p.modelId);
      if (!model || !getSupportedThinkingLevels(model).includes(level)) throw new AppError('thinking_level_not_supported');
    } else if (p) { if (!p.thinking[level]) throw new AppError('thinking_level_not_supported'); }
    else if (id !== 'default' || !this.seed || this.seed.protocol === 'messages') throw new AppError('thinking_level_not_supported');
  }
  options(id: string, level?: ThinkingLevel) {
    const p = this.profile(id); if (!p && id !== 'default') throw new AppError('model_profile_not_found', 404);
    if (p && 'providerId' in p) {
      const effectiveLevel = level ?? p.defaultThinkingLevel;
      if (effectiveLevel !== undefined) this.validateThinking(id, effectiveLevel);
      return effectiveLevel && effectiveLevel !== 'off' ? { providerOptions: { pi: { reasoning: effectiveLevel } } } : {};
    }
    level ??= p?.defaultThinkingLevel;
    const protocol = p?.protocol ?? this.seed?.protocol;
    let options: Record<string, z.infer<ReturnType<typeof z.json>>> = {};
    if (protocol === 'responses') options = { store: false, include: ['reasoning.encrypted_content'] };
    if (level !== undefined) {
      this.validateThinking(id, level);
      options = { ...options, ...(p ? p.thinking[level] : { reasoningEffort: level === 'off' ? 'none' : level }) };
    } else if (!p && this.seed?.reasoningEffort !== undefined) options.reasoningEffort = this.seed.reasoningEffort;
    const providerOptions: ProviderOptions = { [protocol === 'messages' ? 'anthropic' : 'openai']: options };
    return Object.keys(options).length ? { providerOptions } : {};
  }
}
