import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import type {ModelConfig} from '../src/config.js';
import {createModel} from '../src/model.js';
import {Models} from '../src/models.js';
import {RuntimeStore} from '../src/runtime-store.js';

for(const protocol of ['responses','chat-completions','messages'] as const)for(const legacy of ['api-key','bearer'] as const)for(const selected of [undefined,'api-key','bearer'] as const)test(`${protocol} legacy ${legacy}, explicit request auth ${selected??'unset'} sends exactly the effective credential header`,async()=>{
 const original=globalThis.fetch,key='synthetic-auth-only-key';let headers:Headers|undefined;
 globalThis.fetch=async(input,init)=>{
  const request=new Request(input,init);assert.equal(new URL(request.url).hostname,'request-auth.invalid');headers=request.headers;
  if(protocol==='responses')return Response.json({id:'resp_auth',model:'synthetic-model',status:'completed',output:[{type:'message',id:'msg_auth',role:'assistant',content:[{type:'output_text',text:'answer',annotations:[]}]}],usage:{input_tokens:1,output_tokens:1,total_tokens:2}});
  if(protocol==='chat-completions')return Response.json({id:'chat_auth',object:'chat.completion',created:1,model:'synthetic-model',choices:[{index:0,message:{role:'assistant',content:'answer'},finish_reason:'stop',logprobs:null}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});
  return Response.json({id:'msg_auth',type:'message',role:'assistant',model:'synthetic-model',content:[{type:'text',text:'answer'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:1,output_tokens:1}});
 };
 try{
  const model=createModel({protocol,baseURL:'https://request-auth.invalid/v1',modelId:'synthetic-model',apiKey:key,authHeader:legacy,...(selected?{requestAuth:selected}:{})} as ModelConfig);
  const response=await model.doGenerate({prompt:[{role:'user',content:[{type:'text',text:'Synthetic request.'}]}]});assert.equal(response.content.find(part=>part.type==='text')?.text,'answer');assert.ok(headers);
  const effective=selected??(protocol==='messages'?legacy:'bearer'),keyHeader=protocol==='messages'?'x-api-key':'api-key';
  assert.ok(headers.get('authorization')===(effective==='bearer'?'Bearer '+key:null),'effective Authorization header must match the selected scheme');
  assert.ok(headers.get(keyHeader)===(effective==='api-key'?key:null),'effective API-key header must match the selected scheme');
 }finally{globalThis.fetch=original;}
});

test('explicit request authentication survives saved and startup profiles while old profiles stay unchanged',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  const runtime=new RuntimeStore(db),models=new Models(runtime);
  const old={id:'old',name:'Old profile',protocol:'responses',baseURL:'https://request-auth.invalid/v1',modelId:'synthetic-model',apiKeyEnv:'SYNTHETIC_KEY',authHeader:'api-key'};
  models.save(old);const before=runtime.setting('models',[]);models.configurationProfiles();assert.deepEqual(runtime.setting('models',[]),before);
  assert.equal('requestAuth' in models.configurationProfiles()[0]!,false);
  const added={...old,id:'new',requestAuth:'api-key'};models.save(added);assert.equal((models.profile('new') as {requestAuth?:string}).requestAuth,'api-key');
  assert.throws(()=>models.save({...added,requestAuth:'unsupported'}),/invalid_model_profile/);
  const startup=new Models(runtime,{protocol:'messages',baseURL:old.baseURL,modelId:old.modelId,apiKey:'synthetic-only-key',authHeader:'api-key',requestAuth:'bearer'} as ModelConfig);
  assert.equal((startup.configurationProfiles().find(profile=>profile.id==='default') as {requestAuth?:string}).requestAuth,'bearer');
 }finally{db.close();}
});
