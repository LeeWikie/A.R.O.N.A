import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import headless from '@xterm/headless';
import { CURSOR_MARKER, TuiAltScreen, visibleWidth, type Editor, type Terminal } from '@earendil-works/pi-tui';
import { TerminalEditor } from '../src/tui/terminal-editor.js';
import { QueueEditorComponent, type QueueEditingHost } from '../src/tui/queue-editor.js';
import { plainTheme } from '../src/tui/upstream/theme.js';
import type { QueueEditDocument, QueueEditEntry, QueueEditPage } from '../src/protocol.js';
import { until } from './helpers.js';

class EmulatedTerminal implements Terminal {
  columns=40;rows=18;kittyProtocolActive=false;readonly screen=new headless.Terminal({cols:40,rows:18,allowProposedApi:true});
  input:(data:string)=>void=()=>{};resizeCallback:()=>void=()=>{};flushed=Promise.resolve();
  start(input:(data:string)=>void,resize:()=>void){this.input=input;this.resizeCallback=resize;}stop(){}async drainInput(){}
  write(data:string){this.flushed=this.flushed.then(()=>new Promise<void>(resolve=>this.screen.write(data,resolve)));}
  resize(columns:number,rows:number){this.columns=columns;this.rows=rows;this.screen.resize(columns,rows);this.resizeCallback();}
  moveBy(){}hideCursor(){}showCursor(){}clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(){}setProgress(){}setProgramStatus(){}
}
function fixture(){
  const terminal=new EmulatedTerminal(),ui=new TuiAltScreen(terminal),editors:Editor[]=[],actions:unknown[]=[];
  let draft:QueueEditDocument={id:randomUUID(),contextId:'main',revision:1,status:'editing',entryCount:2,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),skipped:[]};
  const rows:QueueEditEntry[]=[{id:randomUUID(),content:'第一行中文\n尾行中文',attachments:[],sourceSignalIds:[randomUUID()],removed:false},{id:randomUUID(),content:'second',attachments:[],sourceSignalIds:[randomUUID()],removed:false}];
  const local=structuredClone(rows);const host:QueueEditingHost={
    createEditor(){const editor=new TerminalEditor(ui,plainTheme.editor(),{paddingX:1});editors.push(editor);return editor;},rows:()=>terminal.rows,render:()=>ui.requestRender(),
    async request<T>(){return {draft:structuredClone(draft),entries:structuredClone(rows),nextCursor:null} as T;},
    async write(_route,body){const input=body as {expectedRevision:number;action:any};assert.equal(input.expectedRevision,draft.revision);const action=input.action,index=rows.findIndex(row=>row.id===action.entryId);actions.push(action);
      if(action.kind==='edit')Object.assign(rows[index]!,{content:action.content,attachments:action.attachments});
      if(action.kind==='remove')rows[index]!.removed=action.removed;
      if(action.kind==='add')rows.splice(rows.findIndex(row=>row.id===action.afterId)+1,0,{id:randomUUID(),content:action.input.content,attachments:[],sourceSignalIds:[],removed:false});
      if(action.kind==='move'){const [row]=rows.splice(index,1);rows.splice(action.beforeId===null?rows.length:rows.findIndex(row=>row.id===action.beforeId),0,row!);}
      draft={...draft,revision:draft.revision+1};return structuredClone(draft);
    },select:async()=>undefined,choose:async()=>undefined,attachment:async()=>undefined,external:async()=>undefined,note(){}
  };
  const done:unknown[]=[],component=new QueueEditorComponent(host,draft,local,action=>done.push(action));ui.addChild(component);ui.setFocus(component);ui.start();
  return {terminal,ui,editors,component,rows,actions,done,async close(){component.dispose();ui.stop();await terminal.flushed;terminal.screen.dispose();}};
}

test('queue editing retains native delete/undo and completion before document actions',async()=>{
  const f=fixture();try{
    const editor=f.editors[0]!;f.terminal.input('\x01');f.terminal.input('\x04');await f.component.flush();
    assert.equal(f.rows[0]!.content,'第一行中文\n行中文');assert.equal(f.rows[0]!.removed,false,'Ctrl+D is native delete forward');
    f.terminal.input('\x1f');await f.component.flush();assert.equal(f.rows[0]!.content,'第一行中文\n尾行中文');
    editor.setText('');editor.setAutocompleteProvider({getSuggestions:async()=>({prefix:'/',items:[{value:'/fixture',label:'/fixture'}]}),applyCompletion:(_lines,_line,_col,item)=>({lines:[item.value],cursorLine:0,cursorCol:item.value.length})});
    f.terminal.input('/');await until(()=>editor.isShowingAutocomplete(),Boolean);f.terminal.input('\r');await until(()=>f.done.length,n=>n===1);assert.equal(editor.getExpandedText(),'/fixture');assert.equal((f.done[0] as {kind:string}).kind,'send');assert.equal(f.rows[1]!.content,'second');
  }finally{await f.close();}
});

test('document keyboard actions add, remove, restore and reorder without changing original source identities',async()=>{
  const f=fixture();try{
    const original=f.rows.map(row=>({id:row.id,source:[...row.sourceSignalIds]}));
    f.terminal.input('\x1b\x04');await until(()=>f.rows[0]!.removed,Boolean);await new Promise(resolve=>setImmediate(resolve));
    f.terminal.input('\x1b\x04');await until(()=>f.rows[0]!.removed,value=>!value);await new Promise(resolve=>setImmediate(resolve));
    f.terminal.input('\x1b\x0e');await until(()=>f.rows.length,n=>n===3);await new Promise(resolve=>setImmediate(resolve));f.terminal.input('new message');await f.component.flush();
    f.terminal.input('\x1b[1;3A');await until(()=>f.rows[0]!.content,text=>text==='new message');await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(f.rows.slice(1).map(row=>({id:row.id,source:row.sourceSignalIds})),original);assert.deepEqual(f.rows[0]!.sourceSignalIds,[]);
    f.terminal.input('\x1b');await until(()=>f.done.length,n=>n===1);assert.equal((f.done[0] as {kind:string}).kind,'close');
  }finally{await f.close();}
});

test('queue document renders the real Chinese multiline cursor after narrow/tiny resize and restores focus',async()=>{
  const f=fixture();try{
    for(const [columns,rows] of [[40,18],[14,14],[14,4],[14,1],[40,18]]){
      f.terminal.resize(columns!,rows!);f.ui.requestRender(true);await new Promise(resolve=>setTimeout(resolve,40));await f.terminal.flushed;
      const lines=f.component.render(columns!),marked=lines.filter(line=>line.includes(CURSOR_MARKER));assert.equal(marked.length,1);assert.ok(lines.length<=rows!);assert.equal(f.component.focused,true);
      const expected=visibleWidth(marked[0]!.split(CURSOR_MARKER)[0]!);assert.equal(f.terminal.screen.buffer.active.cursorX,expected);assert.match(f.terminal.screen.buffer.active.getLine(f.terminal.screen.buffer.active.cursorY)!.translateToString(true),/尾行中文/);
    }
  }finally{await f.close();}
});
