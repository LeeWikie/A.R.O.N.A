import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Core} from '../src/core.js';
import {publicToolEvent} from '../src/tool-activity.js';
import {authenticatedApp,finished,removeTemp,scriptedModel} from './helpers.js';

test('durable tool summaries redact named/provider secrets and never replay raw result text',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-tool-activity-'));const core=await Core.open({dataDir:directory,memoryEnabled:false});
 try{
  core.credentials.set('FIXTURE_KEY','synthetic-named-key-value');await core.credentials.providerStore.modify('fixture',async()=>({type:'oauth',access:'synthetic-provider-access-value',refresh:'synthetic-refresh-value',expires:Date.now()+3600000}));
  const event={contextId:'main',runId:'fixture-run',taskId:null,kind:'tool_start',data:{toolCallId:'fixture-call',toolName:'web_fetch',args:{url:'https://example.invalid/?token=source-secret',command:'echo synthetic-named-key-value synthetic-provider-access-value',content:'internal prompt must not render'}},createdAt:new Date().toISOString()};
  core.runtime.event(event);const start={...event,seq:core.runtime.eventHead()};core.runtime.event({...event,kind:'public_tool',key:'tool.public:'+start.seq,data:publicToolEvent(core,start)});
  const end={...event,kind:'tool_end',data:{toolCallId:'fixture-call',result:'raw internal tool result must not render',isError:false}};core.runtime.event(end);const terminal={...end,seq:core.runtime.eventHead()};core.runtime.event({...end,kind:'public_tool',key:'tool.public:'+terminal.seq,data:publicToolEvent(core,terminal)});
  core.credentials.remove('FIXTURE_KEY');await core.credentials.providerStore.delete('fixture');
  const app=authenticatedApp(core);const text=await(await app.request('/snapshot')).text();
  for(const secret of ['synthetic-named-key-value','synthetic-provider-access-value','source-secret','internal prompt must not render','raw internal tool result must not render'])assert.ok(!text.includes(secret),secret);
  const snapshot=JSON.parse(text) as {toolActivity:{state:string;toolName:string;summary:{characters:number}}[]};assert.equal(snapshot.toolActivity.length,1);assert.equal(snapshot.toolActivity[0]?.toolName,'web_fetch');assert.equal(snapshot.toolActivity[0]?.state,'finished');assert.ok(snapshot.toolActivity[0]!.summary.characters>0);
  const events=await(await app.request('/event-page?after=0')).json() as {events:{kind:string}[]};assert.equal(events.events.filter(event=>event.kind==='tool').length,2);
 }finally{await core.close();await removeTemp(directory);}
});

test('native tools create recoverable public activity without exposing their result bodies',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-native-tool-activity-'));const core=await Core.open({dataDir:directory,model:scriptedModel().model,memoryEnabled:false});
 try{
  const input=await core.submitSignal({version:2,type:'user-message',source:'fixture',content:'synthetic user request'});await finished(core,input.runId!);
  assert.ok(core.runtime.events('main').some(event=>event.kind==='public_tool'));
  const snapshot=await(await authenticatedApp(core).request('/snapshot')).json() as {toolActivity:{toolName:string;state:string}[]};assert.ok(snapshot.toolActivity.some(tool=>tool.toolName==='emit_message'&&tool.state==='finished'));
 }finally{await core.close();await removeTemp(directory);}
});
