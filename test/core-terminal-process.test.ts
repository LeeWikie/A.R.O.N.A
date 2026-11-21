import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';import {authenticatedApp,until,removeTemp} from './helpers.js';
import {ToolOutput} from '../src/tui/tool-output.js';import {plainTheme} from '../src/tui/upstream/theme.js';import {stripTerminalSequences} from '@earendil-works/pi-tui';
const quote=(value:string)=>process.platform==='win32'?`"${value.replaceAll('"','\\"')}"`:`'${value.replaceAll("'","'\\''")}'`;
function reply(action?:{name:string;input:unknown},id=0){return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});if(action)c.enqueue({type:'tool-call',toolName:action.name,toolCallId:`terminal-core-${id}`,input:JSON.stringify(action.input)});else{c.enqueue({type:'text-start',id:'text'});c.enqueue({type:'text-delta',id:'text',delta:'Synthetic notification received.'});c.enqueue({type:'text-end',id:'text'});}c.enqueue({type:'finish',finishReason:action?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}

test('real HTTP native execution approves each input operation and returns actual retained results to the same task',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-core-terminal-'));let core!:Core,step=0,error:unknown;const prompts:unknown[]=[];
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{try{if(!request.tools?.some(tool=>tool.name==='task_report'))return reply();prompts.push(request.prompt);const task=core.runtime.tasks().find(task=>task.status==='running'||task.status==='waiting')!;const id=/process\.[0-9a-f-]{36}/.exec(JSON.stringify(request.prompt))?.[0];
    const actions=[{name:'terminal_process',input:{action:'start',command:`${quote(process.execPath)} -e ${quote("let data='';console.log('READY');process.stdin.on('data',d=>data+=d);process.stdin.on('end',()=>console.log('ANSWER:'+data));")}`,description:'Read synthetic task input',interactive:true}},
      {name:'terminal_process',input:{action:'submit',id,data:'violet-17'}},{name:'terminal_process',input:{action:'close',id}},{name:'terminal_process',input:{action:'wait',id,waitMs:5000}},
      {name:'task_report',input:{id:task.id,report:{outcome:'succeeded',summary:'The original process answered violet-17.',checks:[{description:'The actual process output includes the supplied input.',passed:true}],deliveries:[],unresolved:[]}}}];
    if(step===4)assert.match(JSON.stringify(request.prompt),/ANSWER:violet-17/);return reply(actions[step++],step);
  }catch(caught){error=caught;throw caught;}}});
  core=await Core.open({dataDir:directory,model,memoryEnabled:false});try{const app=authenticatedApp(core),response=await app.request('/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Synthetic interactive task',content:'Start, submit, close and read one synthetic process.'})});assert.equal(response.status,202);const task=await response.json() as {id:string};
    const approved=new Set<string>();await until(async()=>{if(error)throw error;for(const approval of core.runtime.approvals().filter(row=>row.status==='pending')){assert.equal(approval.toolName,'terminal_process');assert.ok(!approved.has(approval.id));approved.add(approval.id);const result=await app.request(`/approvals/${encodeURIComponent(approval.id)}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision:'approve'})});assert.equal(result.status,200);}return core.runtime.task(task.id);},row=>['succeeded','failed','blocked','unreported'].includes(row.status),20000);
    assert.equal(core.runtime.task(task.id).status,'succeeded');assert.equal(approved.size,3);assert.equal(step,6);assert.equal(prompts.length,6);assert.match(JSON.stringify(prompts[5]),/The original process answered violet-17/);assert.equal(core.runtime.task(task.id).grants.execute,false);assert.equal(core.runtime.approvals().filter(row=>row.status==='pending').length,0);
    const owner=core.runtime.task(task.id),processId=/process\.[0-9a-f-]{36}/.exec(JSON.stringify(prompts[5]))![0];
    assert.match(JSON.stringify(core.capabilities.readTerminalProcess(owner.contextId,processId)),/ANSWER:violet-17/);
    const snapshotResponse=await app.request(`/snapshot?contextId=${encodeURIComponent(owner.contextId)}&toolResultContent=1`);assert.equal(snapshotResponse.status,200);
    const snapshot=await snapshotResponse.json() as {toolActivity:Array<ConstructorParameters<typeof ToolOutput>[0]&{toolName?:string}>};
    const terminalCards=snapshot.toolActivity.filter(card=>card.toolName==='terminal_process');assert.equal(terminalCards.length,4);
    const rendered=terminalCards.map(card=>new ToolOutput(card,true,plainTheme).render(100).map(stripTerminalSequences).join('\n')).join('\n');
    assert.match(rendered,/ANSWER:violet-17/);assert.match(rendered,/退出码 0/);assert.doesNotMatch(rendered,/"digest"|"sourceProof"|"secret"/);
    const source=core.store.db.prepare('SELECT body FROM signals WHERE id=?').get(owner.sourceSignalIds[0]!)!;
    core.store.db.prepare('UPDATE signals SET body=? WHERE id=?').run(JSON.stringify({...JSON.parse(String(source.body)),content:'different synthetic authorization'}),owner.sourceSignalIds[0]!);
    assert.throws(()=>core.capabilities.readTerminalProcess(owner.contextId,processId),/process_source_changed/);
    core.store.db.prepare('UPDATE signals SET body=? WHERE id=?').run(String(source.body),owner.sourceSignalIds[0]!);
    core.runtime.updateTask(owner.id,{grants:{write:true,execute:true,mcp:true}});assert.throws(()=>core.capabilities.readTerminalProcess(owner.contextId,processId),/process_source_changed/);core.runtime.updateTask(owner.id,{grants:owner.grants});
    const head=core.store.db.prepare('SELECT leaf_id FROM session_graph_heads WHERE context_id=?').get(owner.contextId)!;
    core.store.db.prepare('UPDATE session_graph_heads SET leaf_id=NULL WHERE context_id=?').run(owner.contextId);assert.throws(()=>core.capabilities.readTerminalProcess(owner.contextId,processId),/process_branch_changed/);core.store.db.prepare('UPDATE session_graph_heads SET leaf_id=? WHERE context_id=?').run(head.leaf_id!,owner.contextId);
    assert.match(JSON.stringify(core.capabilities.readTerminalProcess(owner.contextId,processId)),/ANSWER:violet-17/);
  }finally{await core.close();await removeTemp(directory);}
});

test('declining a native interactive start creates no executable process or output receipt',{timeout:20000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-core-terminal-deny-'));let core!:Core,called=false;
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{if(called||!request.tools?.some(tool=>tool.name==='task_report'))return reply();called=true;return reply({name:'terminal_process',input:{action:'start',command:`${quote(process.execPath)} -e ${quote("require('fs').writeFileSync('forbidden.txt','executed')")}`,description:'Write a forbidden synthetic file',pty:true}},1);}});
  core=await Core.open({dataDir:directory,model,memoryEnabled:false});try{const app=authenticatedApp(core);await app.request('/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Decline a synthetic start',content:'Ask before starting.'})});const approval=await until(()=>core.runtime.approvals().find(row=>row.status==='pending'),Boolean);const denied=await app.request(`/approvals/${encodeURIComponent(approval!.id)}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision:'decline'})});assert.equal(denied.status,200);await until(()=>core.runtime.tasks()[0],task=>task?.status!=='running'&&task?.status!=='waiting');
    assert.equal(fs.existsSync(path.join(directory,'workspace','forbidden.txt')),false);assert.equal(core.store.db.prepare("SELECT COUNT(*) n FROM runtime_settings WHERE id LIKE 'terminal-process:%'").get()!.n,0);
  }finally{await core.close();await removeTemp(directory);}
});
