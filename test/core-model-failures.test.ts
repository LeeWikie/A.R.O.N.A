import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { APICallError } from '@ai-sdk/provider';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { publicEventPage } from '../src/event-stream.js';
import { finished, removeTemp } from './helpers.js';

for(const [status,code] of [[401,'model_authentication_failed'],[403,'model_access_denied'],[404,'model_not_found'],[429,'model_rate_limited'],[503,'model_service_unavailable']] as const)test(`terminal native model errors retain safe ${status} recovery classification`,{timeout:30000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-model-failure-'));const secret='SYNTHETIC_PROVIDER_BODY_SECRET';
 const model=new MastraLanguageModelV2Mock({doStream:async()=>{throw new APICallError({message:secret,url:'http://example.invalid/'+secret,requestBodyValues:{apiKey:secret},statusCode:status,responseBody:secret,isRetryable:false});}});
 const core=await Core.open({dataDir:directory,model,memoryEnabled:false});try{
  const receipt=await core.submitMessage({content:'synthetic request'});const ended=await finished(core,receipt.runId!);assert.equal(ended!.status,'failed');assert.equal(ended!.errorCode,code);
  const page=publicEventPage(core,0,'main',1000);const publicText=JSON.stringify(page);assert.doesNotMatch(publicText,new RegExp(secret));assert.match(publicText,new RegExp(code));
 }finally{await core.close();await removeTemp(directory);}
});
