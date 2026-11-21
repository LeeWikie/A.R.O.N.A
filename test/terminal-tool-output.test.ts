import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import type {Core} from '../src/core.js';
import {RuntimeStore} from '../src/runtime-store.js';
import {publicToolEvent,toolActivity} from '../src/tool-activity.js';
import {ToolOutput} from '../src/tui/tool-output.js';
import {plainTheme} from '../src/tui/upstream/theme.js';
import {stripTerminalSequences} from '@earendil-works/pi-tui';
import {publicToolOutput} from '../src/tool-output.js';

test('terminal result cards retain real status and log text after credential removal without leaking the private fields or binary body',()=>{
  const db=new DatabaseSync(':memory:'),runtime=new RuntimeStore(db);let secrets=['synthetic-terminal-key'];const core={store:{db},runtime,redactionValues:()=>secrets} as unknown as Core;
  try{
    for(const [index,name] of ['terminal_process','read_terminal_result'].entries()){
      const id=`terminal-card-${index}`,args={action:'log',id:'process.11111111-1111-1111-1111-111111111111'};
      for(const [kind,data] of [['tool_start',{toolCallId:id,toolName:name,args}],['tool_end',{toolCallId:id,result:{...args,status:'failed',exitCode:7,content:'VISIBLE_LOG\nsynthetic-terminal-key\n\u001b]52;c;forbidden\u0007',encoding:'text',nextOffset:201,digest:'private-proof',root:'/private/hidden',secret:'private-control-key'}}]] as const){runtime.event({contextId:'main',runId:'synthetic-run',kind,data});const event={seq:runtime.eventHead(),contextId:'main',runId:'synthetic-run',taskId:null,kind,data,createdAt:new Date().toISOString()};const projected=publicToolEvent(core,event);runtime.event({contextId:'main',runId:'synthetic-run',kind:'public_tool',data:projected});}
    }
    secrets=[];const cards=toolActivity(core,'main');assert.equal(cards.length,2);
    for(const card of cards){const text=new ToolOutput(card,true,plainTheme).render(100).map(stripTerminalSequences).join('\n');assert.match(text,/VISIBLE_LOG/);assert.match(text,/退出失败/);assert.match(text,/退出码 7/);assert.match(text,/201 行/);assert.doesNotMatch(text,/synthetic-terminal-key|private-proof|private-control-key|\/private\/hidden|forbidden/);}
    const encoded=Buffer.from('SYNTHETIC_BINARY_SECRET').toString('base64'),binary=publicToolOutput(core,'read_terminal_result',{}, {id:'process.11111111-1111-1111-1111-111111111111',status:'completed',exitCode:0,encoding:'base64',content:encoded,totalBytes:23});
    assert.match(binary.output!.text,/二进制输出/);assert.doesNotMatch(binary.output!.text,new RegExp(encoded));assert.doesNotMatch(binary.output!.text,/业务成功|任务成功/);
  }finally{db.close();}
});
