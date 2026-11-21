import fs from 'node:fs';
import path from 'node:path';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';

const directory=process.argv[2];if(!directory||!process.send)throw Error('fixture_requires_ipc');
const credential=(account='synthetic-account',scope='read',revision=1)=>({type:'oauth' as const,access:`aaa.${Buffer.from(JSON.stringify({iss:'https://synthetic.invalid',sub:account,aud:'synthetic',scope,'https://api.openai.com/auth':{chatgpt_account_id:account}})).toString('base64url')}.signature${revision}`,refresh:`synthetic-refresh-${revision}`,expires:Date.now()+Number(process.env.SYNTHETIC_AUTH_VALIDITY_MS??3600000),accountId:account});
let core:Core,calls=0,refreshes=0,next=credential(),failure=process.env.SYNTHETIC_AUTH_FAILURE;
globalThis.fetch=async(input,init)=>{const request=new Request(input,init);if(request.url!=='https://auth.openai.com/oauth/token')throw Error('unexpected_external_request');const body=new URLSearchParams(await request.text());if(body.get('grant_type')!=='refresh_token')throw Error('unexpected_grant_type');refreshes++;if(failure)return Response.json({error:failure==='400'?'invalid_grant':'temporarily_unavailable'},{status:Number(failure)});return Response.json({access_token:next.access,refresh_token:next.refresh,expires_in:10800,scope:JSON.parse(Buffer.from(next.access.split('.')[1]!,'base64url').toString()).scope});};
const model=new MastraLanguageModelV2Mock({doStream:async request=>{calls++;const answered=request.prompt.some(message=>message.role==='tool');return {stream:new ReadableStream({start(controller){controller.enqueue({type:'stream-start',warnings:[]});if(!answered)controller.enqueue({type:'tool-call',toolCallId:'synthetic-auth-question',toolName:'ask_user',input:JSON.stringify({question:'Synthetic authentication choice'})});else{controller.enqueue({type:'text-start',id:'t'});controller.enqueue({type:'text-delta',id:'t',delta:'Synthetic authentication answer'});controller.enqueue({type:'text-end',id:'t'});}controller.enqueue({type:'finish',finishReason:answered?'stop':'tool-calls',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});controller.close();}})};}});
core=await Core.open({dataDir:directory,model,memoryEnabled:false});
if(!core.models.profile('default')){await core.credentials.providerStore.modify('openai-codex',async()=>credential());core.models.save({id:'default',name:'Synthetic authorization profile',providerId:'openai-codex',modelId:'gpt-6-luna',defaultThinkingLevel:'max'});await core.switchModel('main','default','max');}
process.send({type:'ready'});
process.on('message',message=>{if(!message||typeof message!=='object'||!('type'in message))return;void(async()=>{
  if(message.type==='submit')await core.submitMessage({content:'Ask the synthetic choice.'});
  if(message.type==='refresh'){
    const variant='variant'in message?message.variant:'same';next=credential(variant==='account'?'synthetic-other':'synthetic-account',variant==='scope'?'read write':'read',2);
    await core.providerRegistry.getAuth('openai-codex',{minOAuthValidityMs:7200000});
  }
  if(message.type==='answer'){const interaction=core.interactions().find(row=>row.status==='pending')!;await core.answerInteraction(interaction.id,interaction.runId,'Synthetic answer');}
  if(message.type==='save-answer'){const interaction=core.interactions().find(row=>row.status==='pending')!;await core.saveInteractionAnswer(interaction.id,interaction.runId,'Synthetic answer');}
  if(message.type==='network-online'){failure=undefined;next=credential('synthetic-account','read',2);}
  if(message.type==='close'){await core.close();process.send?.({type:'closed'});process.disconnect?.();return;}
  const interactions=core.interactions();process.send?.({type:'state',calls,refreshes,interactions,answers:core.interactionAnswers(),identity:await core.credentials.providerStore.authorizationIdentity('openai-codex'),runs:interactions.map(row=>core.store.getRun(row.runId)),sealed:interactions.every(row=>Boolean(core.runtime.setting(`run-recovery:${row.runId}`,null))),events:core.runtime.events(undefined,0,1000).filter(row=>row.kind==='run_recovery_unavailable')});
})().catch(error=>process.send?.({type:'fixture-error',error:String(error)}));});
