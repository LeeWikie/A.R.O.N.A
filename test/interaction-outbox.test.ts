import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {InteractionAnswerOutbox,interactionAnswerAcknowledged,interactionAnswerCheckpoint} from '../src/interaction-outbox.js';
import {validateInteractionAnswer,type InteractionRecord} from '../src/interactions.js';
import {removeTemp} from './helpers.js';

const question:InteractionRecord={id:'interaction-one',contextId:'main',runId:'run-one',toolCallId:'question-one',toolName:'ask_user',kind:'question',payload:{question:'Synthetic question'},status:'pending',createdAt:'2020-01-01T00:00:00Z'};
test('multi-select preserves all hundred advertised choices plus one additional answer',()=>{
  const options=Array.from({length:100},(_,index)=>({label:`Choice ${index}`})),interaction:InteractionRecord={...question,payload:{question:'Select choices',selectionMode:'multi_select',options}},answers=[...options.map(row=>row.label),'An additional answer'];
  assert.deepEqual(validateInteractionAnswer(interaction,answers),answers);assert.equal(validateInteractionAnswer(interaction,[...answers,'Too many']),undefined);assert.equal(validateInteractionAnswer(interaction,[answers[0]!,answers[0]!]),undefined);
});
test('receipt pages preserve every unknown or blocked answer and exclude terminal history only when requested',()=>{
  const db=new DatabaseSync(':memory:');try{const outbox=new InteractionAnswerOutbox(db);for(let index=0;index<7;index++){const row=outbox.save({...question,id:`interaction-${index}`,contextId:index===3?'other':'main',toolCallId:`question-${index}`},`private-${index}`,'proof');if(index===0)outbox.delivered(row.id,1);if(index===1)outbox.cancel(row.id);if(index===2)outbox.update(row.id,{status:'unknown'});if(index===4)outbox.update(row.id,{status:'blocked'});}
    const ids:string[]=[];let after=0;for(;;){const page=outbox.page({contextId:'main',active:true,after,limit:2});ids.push(...page.answers.map(row=>row.interactionId));assert.doesNotMatch(JSON.stringify(page),/private-|answerHash|recoveryHash/);assert.ok(page.nextCursor>after);after=page.nextCursor;if(!page.hasMore)break;}
    assert.deepEqual(ids,['interaction-2','interaction-4','interaction-5','interaction-6']);assert.equal(new Set(ids).size,ids.length);assert.equal(outbox.page().answers.length,7);assert.throws(()=>outbox.page({limit:0}),/invalid_query/);assert.throws(()=>outbox.page({after:-1}),/invalid_query/);
  }finally{db.close();}
});
test('a native sibling checkpoint acknowledges only the original persisted successful tool result',()=>{
  const address={contextId:'main',runId:'run-one',toolCallId:'question-one',toolName:'ask_user',nativeMessageId:'assistant-one'};
  const snapshot={runId:'run-one',parentWorkflow:{workflowId:'agentic-loop',runId:'run-one',stepId:'executionWorkflow'},requestContext:{mastra__threadId:'main',mastra__resourceId:'local','shittimchest-native-input-run':{runId:'run-one',contextId:'main'}},context:{input:{messageId:'assistant-one'},'llm-execution':{status:'success',output:{messageId:'assistant-one'}},toolCallStep:{payload:[{toolCallId:'question-one',toolName:'ask_user'},{toolCallId:'question-two',toolName:'ask_user'}],suspendPayload:{__workflow_meta:{foreachOutput:[{status:'success',output:{toolCallId:'question-one',toolName:'ask_user',result:{content:'User answered: A',isError:false}}},{status:'suspended',suspendPayload:{toolCallId:'question-two',toolName:'ask_user',__agentId:'arona'}}]}}}}};
  assert.deepEqual(interactionAnswerCheckpoint(snapshot,address),{messageId:'assistant-one',status:'completed',result:{content:'User answered: A',isError:false}});
  assert.equal(interactionAnswerCheckpoint(snapshot,{...address,nativeMessageId:'another-turn'}),undefined);
  assert.equal(interactionAnswerCheckpoint(snapshot,{...address,runId:'another-run'}),undefined);
  assert.equal(interactionAnswerCheckpoint(snapshot,{...address,contextId:'another-thread'}),undefined);
  const missing=structuredClone(snapshot);missing.context.toolCallStep.suspendPayload.__workflow_meta.foreachOutput.shift();assert.equal(interactionAnswerCheckpoint(missing,address),undefined,'a disappeared gate is never an acknowledgement');
  const duplicate=structuredClone(snapshot);duplicate.context.toolCallStep.payload.push({toolCallId:'question-one',toolName:'ask_user'});assert.equal(interactionAnswerCheckpoint(duplicate,address),undefined);
});
test('answers survive a real database reopen, remain private and reconcile delivery separately from saving',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-answer-outbox-'));let db=new DatabaseSync(path.join(directory,'records.sqlite'));
  try{
    let outbox=new InteractionAnswerOutbox(db);const saved=outbox.save(question,'SYNTHETIC_PRIVATE_ANSWER','source-seal');
    assert.equal(saved.status,'pending');assert.equal(saved.attempts,0);assert.doesNotMatch(JSON.stringify(outbox.public(saved)),/PRIVATE_ANSWER|answerHash|recoveryHash/);
    assert.equal(outbox.save(question,'SYNTHETIC_PRIVATE_ANSWER','source-seal').id,saved.id);assert.throws(()=>outbox.save(question,'another answer','source-seal'),/interaction_already_answered/);
    assert.equal(outbox.claim(saved.id)?.attempts,1);db.close();db=new DatabaseSync(path.join(directory,'records.sqlite'));outbox=new InteractionAnswerOutbox(db);outbox.recover();
    const unknown=outbox.get(saved.id)!;assert.equal(unknown.status,'unknown');assert.equal(unknown.answer,'SYNTHETIC_PRIVATE_ANSWER');
    assert.equal(interactionAnswerAcknowledged(unknown,question,{content:'User answered: wrong',isError:false}),false);
    assert.equal(interactionAnswerAcknowledged(unknown,question,{content:'User answered: SYNTHETIC_PRIVATE_ANSWER',isError:true}),false);
    assert.equal(interactionAnswerAcknowledged(unknown,question,{content:'User answered: SYNTHETIC_PRIVATE_ANSWER',isError:false}),true);
    assert.equal(outbox.delivered(saved.id,17).status,'delivered');assert.equal(outbox.get(saved.id)?.acknowledgementSeq,17);assert.equal(outbox.claim(saved.id),undefined);assert.equal(outbox.cancel(saved.id)?.status,'delivered');
  }finally{db.close();await removeTemp(directory);}
});
test('pending cancellation prevents dispatch while in-flight cancellation retains its unknown outcome',()=>{
  const db=new DatabaseSync(':memory:');try{const outbox=new InteractionAnswerOutbox(db),pending=outbox.save(question,'first','seal');assert.equal(outbox.cancel(pending.id)?.status,'cancelled');assert.equal(outbox.claim(pending.id),undefined);
    const other={...question,id:'interaction-two',toolCallId:'question-two'},saved=outbox.save(other,['one','two'],'seal');outbox.claim(saved.id);assert.equal(outbox.cancel(saved.id)?.status,'unknown');assert.equal(outbox.claim(saved.id),undefined);
    assert.equal(interactionAnswerAcknowledged(outbox.get(saved.id)!,other,{content:'User answered: one, two',isError:false}),true);assert.equal(outbox.delivered(saved.id,18).status,'delivered');assert.ok(outbox.get(saved.id)?.cancelRequestedAt);
  }finally{db.close();}
});
test('a storage rejection never becomes a saved receipt or changes the native gate identity',()=>{
  const db=new DatabaseSync(':memory:');try{const outbox=new InteractionAnswerOutbox(db);db.exec("CREATE TRIGGER reject_answer BEFORE INSERT ON interaction_answer_outbox BEGIN SELECT RAISE(ABORT,'synthetic storage failure');END;");assert.throws(()=>outbox.save(question,'not persisted','seal'),/synthetic storage failure/);assert.equal(outbox.get(question.id),undefined);assert.equal(question.status,'pending');
    db.exec('DROP TRIGGER reject_answer');const saved=outbox.save(question,'persisted','seal');assert.throws(()=>outbox.save({...question,runId:'successor'},'persisted','seal'),/interaction_already_answered/);assert.equal(outbox.get(saved.id)?.runId,'run-one');
  }finally{db.close();}
});
