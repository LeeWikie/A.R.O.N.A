import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {createApp} from '../src/http.js';
import {MAX_INTERACTION_ANSWER_REQUEST_BYTES,validateInteractionAnswer,type InteractionRecord} from '../src/interactions.js';
import {authenticatedApp,removeTemp} from './helpers.js';

test('answer transport covers the full canonical JSON escape budget while retaining authentication and ordinary request bounds',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-answer-transport-'));let calls=0;
  const model=new MastraLanguageModelV2Mock({doStream:async()=>{calls++;throw Error('no model request is expected');}});
  const core=await Core.open({dataDir:directory,model,memoryEnabled:false});
  try{
    const answer=Array.from({length:101},(_,index)=>'\u0000'.repeat(64000-String(index).length)+index);
    const record:InteractionRecord={id:'synthetic',contextId:'main',runId:'synthetic-run',toolCallId:'synthetic-call',toolName:'ask_user',kind:'question',payload:{question:'Synthetic choices',selectionMode:'multi_select'},status:'pending',createdAt:new Date().toISOString()};
    assert.deepEqual(validateInteractionAnswer(record,answer),answer);const body=JSON.stringify({expectedRunId:'r'.repeat(200),answer});assert.ok(Buffer.byteLength(body)>36*1024*1024);assert.ok(Buffer.byteLength(body)<MAX_INTERACTION_ANSWER_REQUEST_BYTES);
    const app=authenticatedApp(core);
    assert.equal((await createApp(core).request('/interactions/synthetic-missing/answer-outbox',{method:'POST',headers:{'content-type':'application/json'},body})).status,401);
    for(const suffix of ['answer','answer-outbox','answer-receipt']){const response=await app.request(`/interactions/synthetic-missing/${suffix}`,{method:'POST',headers:{'content-type':'application/json'},body});assert.equal(response.status,404,`${suffix} reaches the bounded canonical address check`);assert.deepEqual(await response.json(),{error:'interaction_not_found'});}
    const ordinary=await app.request('/messages',{method:'POST',headers:{'content-type':'application/json'},body});assert.equal(ordinary.status,413);
    const oversized=await app.request('/interactions/synthetic-missing/answer-outbox',{method:'POST',headers:{'content-type':'application/json'},body:' '.repeat(MAX_INTERACTION_ANSWER_REQUEST_BYTES+1)});assert.equal(oversized.status,413);assert.equal(calls,0);assert.equal(core.interactionAnswers().length,0);
  }finally{await core.close();await removeTemp(directory);}
});
