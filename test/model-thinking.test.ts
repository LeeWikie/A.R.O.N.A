import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { clampThinkingLevel, createModels, fauxProvider, getSupportedThinkingLevels, InMemoryCredentialStore, type Model, type Api } from '@earendil-works/pi-ai';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { Models, clampThinkingChoice, thinkingLevels } from '../src/models.js';
import { RuntimeStore } from '../src/runtime-store.js';
import { readConfig } from '../src/config.js';
import { createProviderCatalog } from '../src/providers/catalog.js';
import { authenticatedApp, finished, removeTemp } from './helpers.js';

const catalog=()=>createProviderCatalog({credentials:new InMemoryCredentialStore(),authContext:{env:async()=>undefined,fileExists:async()=>false}});
const syntheticSeed={protocol:'responses' as const,baseURL:'http://example.invalid/v1',modelId:'gpt-6-luna',apiKey:'synthetic-only-key',authHeader:'bearer' as const,reasoningEffort:'max' as const};

test('sparse model capabilities use the same complete ordered clamp as Pi',{timeout:10000},()=>{
  const model:Model<Api>={id:'synthetic',name:'Synthetic',provider:'synthetic',api:'openai-responses',baseUrl:'http://example.invalid',reasoning:true,input:['text'],contextWindow:10000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  for(let mask=1;mask<1<<thinkingLevels.length;mask++){
    const available=thinkingLevels.filter((_level,index)=>mask&(1<<index));
    model.thinkingLevelMap=Object.fromEntries(thinkingLevels.map(level=>[level,available.includes(level)?level:null]));
    assert.deepEqual(getSupportedThinkingLevels(model),available);
    for(const requested of thinkingLevels)assert.equal(clampThinkingChoice(requested,available),clampThinkingLevel(model,requested));
  }
});

test('startup defaults are preferences and exact catalog metadata supplies the full supported set',()=>{
  const db=new DatabaseSync(':memory:');try{
    const registry=catalog(),models=new Models(new RuntimeStore(db),syntheticSeed,()=>undefined,registry);
    const native=registry.getModel('openai','gpt-6-luna')!;
    const state=models.thinking('default');assert.deepEqual(state.thinkingLevels,getSupportedThinkingLevels(native));
    assert.equal(state.thinkingCapabilitySource,'provider-metadata');assert.equal(state.thinkingLevel,'max');assert.equal(state.defaultThinkingLevel,'max');
    assert.deepEqual(models.options('default').providerOptions?.openai,{store:false,include:['reasoning.encrypted_content'],reasoningEffort:'max'});
    const profile=models.configurationProfiles()[0]!;assert.ok('thinking' in profile);assert.deepEqual(profile.thinking,{});
    models.save({...profile,name:'Edited'});assert.equal(models.thinking('default').thinkingLevel,'max');
    assert.ok(!JSON.stringify(models.configurationProfiles()).includes(syntheticSeed.apiKey));
    const unknownDb=new DatabaseSync(':memory:');try{
      const unknown=new Models(new RuntimeStore(unknownDb),{...syntheticSeed,modelId:'unknown-gpt-6-luna-variant'},()=>undefined,registry);
      assert.deepEqual(unknown.thinking('default').thinkingLevels,['max']);assert.equal(unknown.thinking('default').thinkingCapabilitySource,'startup-config');
      assert.throws(()=>unknown.validateThinking('default','high'),/thinking_level_not_supported/);
    }finally{unknownDb.close();}
  }finally{db.close();}
});

test('known reasoning defaults to medium while unknown protocols do not manufacture model capabilities',()=>{
  const db=new DatabaseSync(':memory:');try{
    const registry=catalog(),models=new Models(new RuntimeStore(db),undefined,()=>undefined,registry);
    const common={protocol:'responses' as const,baseURL:'http://example.invalid/v1',apiKeyEnv:'SYNTHETIC_KEY',authHeader:'bearer' as const};
    models.save({...common,id:'known',name:'Known',modelId:'gpt-6-luna'});
    assert.equal(models.thinking('known').thinkingLevel,'medium');assert.equal(models.thinking('known').source,'model-default');
    models.save({...common,id:'unknown',name:'Unknown',modelId:'unknown-gpt-6-luna-variant'});
    assert.equal(models.thinking('unknown').supportsThinking,null);assert.deepEqual(models.thinking('unknown').thinkingLevels,[]);
    assert.equal(models.thinking('unknown').thinkingLevel,null);assert.equal(models.thinking('unknown').nextThinkingLevel,null);
    assert.throws(()=>models.validateThinking('unknown','max'),/thinking_level_not_supported/);
    models.save({...common,id:'legacy-max-only',name:'Legacy',modelId:'gpt-6-luna',thinking:{max:{reasoningEffort:'max'}},defaultThinkingLevel:'max'});
    assert.deepEqual(models.thinking('legacy-max-only').thinkingLevels,models.thinking('known').thinkingLevels,'a saved wire override does not restrict the native support set');
    assert.equal(models.thinking('legacy-max-only').thinkingLevel,'max');assert.equal(models.options('legacy-max-only').providerOptions?.openai?.reasoningEffort,'max');
    models.save({...common,id:'wire-override',name:'Wire override',modelId:'gpt-6-luna',thinking:{high:{reasoningEffort:'medium'}}});
    assert.equal(models.options('wire-override','high').providerOptions?.openai?.reasoningEffort,'medium');assert.equal(models.options('wire-override','max').providerOptions?.openai?.reasoningEffort,'max');
    models.save({...common,id:'override',name:'Override',modelId:'gpt-6-luna',thinkingMode:'manual',thinking:{low:{reasoningEffort:'low'},high:{reasoningEffort:'high'}},defaultThinkingLevel:'max'});
    assert.deepEqual(models.thinking('override').thinkingLevels,['low','high']);assert.equal(models.thinking('override').thinkingCapabilitySource,'profile');
    assert.equal(models.thinking('override').requestedThinkingLevel,'max');assert.equal(models.thinking('override').thinkingLevel,'high');
    assert.equal(models.thinking('override','off').thinkingLevel,'low');assert.equal(models.thinking('override','high').nextThinkingLevel,'low');
    assert.equal(models.options('override').providerOptions?.openai?.reasoningEffort,'high');
  }finally{db.close();}
});

test('minimal is accepted in startup configuration and passed through an explicit protocol mapping',()=>{
  const model=readConfig({SHITTIMCHEST_MODEL_PROTOCOL:'responses',SHITTIMCHEST_MODEL_BASE_URL:'http://example.invalid/v1',SHITTIMCHEST_MODEL_ID:'synthetic',SHITTIMCHEST_MODEL_API_KEY:'synthetic-only',SHITTIMCHEST_MODEL_REASONING_EFFORT:'minimal'}).model;
  assert.equal(model?.reasoningEffort,'minimal');const db=new DatabaseSync(':memory:');try{
    const models=new Models(new RuntimeStore(db),model);assert.deepEqual(models.thinking('default').thinkingLevels,['minimal']);
    assert.equal(models.options('default').providerOptions?.openai?.reasoningEffort,'minimal');
  }finally{db.close();}
});

async function coreFixture(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-thinking-'));const calls:unknown[]=[];
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{calls.push(request.providerOptions);return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'text-start',id:'t'});c.enqueue({type:'text-delta',id:'t',delta:'complete'});c.enqueue({type:'text-end',id:'t'});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}});
  let core=await Core.open({dataDir:directory,model,memoryEnabled:false,modelConfig:syntheticSeed});
  const register=()=>{const fake=fauxProvider({provider:'synthetic-thinking',models:[{id:'plain',reasoning:false},{id:'bounded',reasoning:true}]});core.providerRegistry.setProvider(fake.provider);return fake;};
  register();for(const id of ['plain','bounded'])core.models.save({id,name:id,providerId:'synthetic-thinking',modelId:id});
  return {get core(){return core;},calls,async reopen(){await core.close();core=await Core.open({dataDir:directory,model,memoryEnabled:false,modelConfig:syntheticSeed});register();},async close(){await core.close();await removeTemp(directory);}};
}

test('native model switching clamps temporarily, restores the requested preference and honors a target model default',{timeout:30000},async()=>{
  const f=await coreFixture();try{
    assert.equal((await f.core.modelState('main')).thinkingLevel,'max');
    await f.core.switchModel('main','default','max');
    await f.core.switchModel('main','plain');let state=await f.core.modelState('main');assert.equal(state.thinkingLevel,'off');assert.equal(state.requestedThinkingLevel,'max');assert.equal(state.supportsThinking,false);assert.equal(state.nextThinkingLevel,null);
    await f.core.switchModel('main','bounded');state=await f.core.modelState('main');assert.equal(state.thinkingLevel,'high');assert.equal(state.requestedThinkingLevel,'max');assert.ok(state.thinkingLevels.includes('minimal'));
    f.core.models.save({id:'unknown',name:'Unknown',protocol:'responses',baseURL:'http://example.invalid/v1',modelId:'unknown-controller-fixture',apiKeyEnv:'SHITTIMCHEST_STARTUP_MODEL_KEY'});
    await f.core.switchModel('main','unknown');state=await f.core.modelState('main');assert.equal(state.thinkingLevel,null);assert.equal(state.thinkingCapabilitySource,'unknown');
    await f.core.switchModel('main','bounded');state=await f.core.modelState('main');assert.equal(state.thinkingLevel,'high');assert.equal(state.requestedThinkingLevel,'max');
    const copy=await f.core.cloneContext('main',{id:'chat.preference-copy'});assert.equal((await f.core.modelState(copy.id)).requestedThinkingLevel,'max');
    const backup=await f.core.exportContinuationContext('main');const restored=await f.core.importContext({archive:backup,id:'chat.preference-import'});assert.equal((await f.core.modelState(restored.id)).requestedThinkingLevel,'max');
    await f.reopen();assert.equal((await f.core.modelState('main')).requestedThinkingLevel,'max');assert.equal((await f.core.modelState(copy.id)).requestedThinkingLevel,'max');assert.equal((await f.core.modelState(restored.id)).requestedThinkingLevel,'max');
    await f.core.switchModel('main','default');assert.equal((await f.core.modelState('main')).thinkingLevel,'max');
    f.core.models.save({id:'bounded',name:'Bounded',providerId:'synthetic-thinking',modelId:'bounded',defaultThinkingLevel:'low'});
    await f.core.switchModel('main','bounded');state=await f.core.modelState('main');assert.equal(state.thinkingLevel,'low');assert.equal(state.source,'profile');
    await f.core.switchModel('main','bounded','max');state=await f.core.modelState('main');assert.equal(state.thinkingLevel,'high');assert.equal(state.requestedThinkingLevel,'max');
    await f.core.switchModel('main','bounded',null);state=await f.core.modelState('main');assert.equal(state.thinkingLevel,'low');assert.equal(state.source,'profile');
    assert.equal(f.calls.length,0,'selection, clamping and restoration do not issue any model requests');
  }finally{await f.close();}
});

test('HTTP state and the actual native request use the same effective thinking level, including minimal and reset',{timeout:30000},async()=>{
  const f=await coreFixture();try{
    const app=authenticatedApp(f.core);const protocol=await (await app.request('/protocol')).json() as {capabilities:string[]};assert.ok(protocol.capabilities.includes('model-thinking-state'));
    const seedProfile=f.core.models.configurationProfiles().find(profile=>profile.id==='default')!;
    assert.ok('thinking' in seedProfile);f.core.models.save({...seedProfile,id:'luna',name:'Luna',thinking:{max:{reasoningEffort:'max'}},defaultThinkingLevel:'max'});
    const list=await (await app.request('/models')).json() as {models:Array<{id:string;thinking?:Record<string,unknown>}>;thinking:Record<string,ReturnType<Models['thinking']>>};
    assert.ok(list.thinking.luna!.thinkingLevels.length>1);assert.equal(list.thinking.luna!.thinkingLevel,'max');assert.deepEqual(Object.keys(list.models.find(profile=>profile.id==='luna')!.thinking!),['max']);
    assert.ok('thinking' in seedProfile);f.core.models.save({...seedProfile,modelId:'synthetic-mapped',thinking:{minimal:{reasoningEffort:'minimal'},max:{reasoningEffort:'max'}},defaultThinkingLevel:'max'});
    const response=await app.request('/contexts/main/model',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({profileId:'default',thinkingLevel:'minimal'})});assert.equal(response.status,200);
    let state=await (await app.request('/contexts/main/model')).json() as Awaited<ReturnType<Core['modelState']>>;assert.equal(state.thinkingLevel,'minimal');
    let receipt=await f.core.submitMessage({content:'synthetic request'});assert.equal((await finished(f.core,receipt.runId!))?.status,'succeeded');assert.equal((f.calls.at(-1) as {openai:{reasoningEffort:string}}).openai.reasoningEffort,state.thinkingLevel);
    await f.reopen();assert.equal((await f.core.modelState('main')).thinkingLevel,'minimal');assert.equal((await f.core.modelState('main')).requestedThinkingLevel,'minimal');
    await Promise.all([f.core.switchModel('main','default','minimal'),f.core.switchModel('main','default','max')]);state=await f.core.modelState('main');assert.equal(state.thinkingLevel,'max');assert.equal(state.requestedThinkingLevel,'max');
    await f.core.switchModel('main','default',null);state=await f.core.modelState('main');assert.equal(state.thinkingLevel,'max');assert.equal(state.source,'profile');
    receipt=await f.core.submitMessage({content:'synthetic reset request'});assert.equal((await finished(f.core,receipt.runId!))?.status,'succeeded');assert.equal((f.calls.at(-1) as {openai:{reasoningEffort:string}}).openai.reasoningEffort,'max');
  }finally{await f.close();}
});

test('automatic direct Responses thinking reaches the real SDK request without manual JSON mappings',{timeout:15000},async()=>{
  const db=new DatabaseSync(':memory:'),original=globalThis.fetch;const bodies:Array<Record<string,unknown>>=[];
  try{
    const registry=catalog(),model=registry.getModels('openai').find(model=>model.api==='openai-responses'&&getSupportedThinkingLevels(model).includes('off')&&getSupportedThinkingLevels(model).includes('max'))!;assert.ok(model);
    globalThis.fetch=async(input,init)=>{const request=new Request(input,init);assert.equal(new URL(request.url).hostname,'example.invalid');bodies.push(await request.json() as Record<string,unknown>);return new Response(JSON.stringify({id:'resp_synthetic',object:'response',created_at:1,status:'completed',model:model.id,output:[],usage:{input_tokens:1,output_tokens:0,total_tokens:1}}),{headers:{'content-type':'application/json'}});};
    const models=new Models(new RuntimeStore(db),undefined,()=> 'synthetic-only-key',registry);
    models.save({id:'wire',name:'Wire',protocol:'responses',baseURL:'http://example.invalid/v1',apiKeyEnv:'SYNTHETIC_KEY',modelId:model.id,defaultThinkingLevel:'max'});
    for(const level of ['max','off'] as const){
      const options=models.options('wire',level);await models.resolve('wire').doGenerate({prompt:[{role:'user',content:[{type:'text',text:'Synthetic request'}]}],...options});
      assert.equal((bodies.at(-1)!.reasoning as {effort:string}).effort,model.thinkingLevelMap?.[level]??(level==='off'?'none':level));
    }
  }finally{globalThis.fetch=original;db.close();}
});

test('automatic direct Anthropic thinking uses adaptive effort or a bounded native budget',{timeout:15000},async()=>{
  const db=new DatabaseSync(':memory:'),original=globalThis.fetch;const bodies:Array<Record<string,unknown>>=[];
  try{
    const registry=catalog(),models=new Models(new RuntimeStore(db),undefined,()=> 'synthetic-only-key',registry);
    const candidates=registry.getModels('anthropic').filter(model=>model.api==='anthropic-messages'&&model.reasoning);
    const adaptive=candidates.find(model=>model.compat&&'forceAdaptiveThinking' in model.compat&&model.compat.forceAdaptiveThinking===true)!;
    const budget=candidates.find(model=>!model.compat||!('forceAdaptiveThinking' in model.compat)||model.compat.forceAdaptiveThinking!==true)!;
    assert.ok(adaptive);assert.ok(budget);
    globalThis.fetch=async(input,init)=>{const request=new Request(input,init);assert.equal(new URL(request.url).hostname,'example.invalid');const body=await request.json() as Record<string,unknown>;bodies.push(body);return new Response(JSON.stringify({id:'msg_synthetic',type:'message',role:'assistant',model:body.model,content:[{type:'text',text:'complete'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:1,output_tokens:1}}),{headers:{'content-type':'application/json'}});};
    for(const [index,model] of [adaptive,budget].entries())for(const maximum of [undefined,8000]){
      const id='anthropic-'+index;models.save({id,name:id,protocol:'messages',baseURL:'http://example.invalid/v1',apiKeyEnv:'SYNTHETIC_KEY',modelId:model.id,defaultThinkingLevel:'high',...(maximum?{maxTokens:maximum}:{})});
      const options=models.options(id);await models.resolve(id).doGenerate({prompt:[{role:'user',content:[{type:'text',text:'Synthetic request'}]}],...options});
      const body=bodies.at(-1)!;
      if(model===adaptive){assert.equal((body.thinking as {type:string}).type,'adaptive');assert.equal((body.output_config as {effort:string}).effort,model.thinkingLevelMap?.high??'high');}
      else {const value=body.thinking as {type:string;budget_tokens:number};assert.equal(value.type,'enabled');assert.ok(value.budget_tokens>=1024);assert.ok(value.budget_tokens+1024<=Number(body.max_tokens));assert.ok(Number(body.max_tokens)<=model.maxTokens);}
      if(maximum!==undefined)assert.equal(body.max_tokens,maximum,'a configured model ceiling includes the native thinking budget');
    }
  }finally{globalThis.fetch=original;db.close();}
});
