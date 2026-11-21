import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {until,removeTemp} from './helpers.js';

function stream(name?:string,input:unknown={},id='empty'){return{stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});if(name)c.enqueue({type:'tool-call',toolCallId:id,toolName:name,input:JSON.stringify(input)});c.enqueue({type:'finish',finishReason:name?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}
test('actual scoped roots remain empty until precise approval and expose only the approved project to tools and resources',{timeout:30000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-core-roots-')),second=path.join(directory,'second');fs.mkdirSync(second);let core!:Core,connections=0,sequence=0;const turns=new Map<string,number>(),pending=new Map<string,(value:unknown)=>void>(),observed:Array<{method:string;session:string;roots:unknown}>=[];
 const remote=createServer(async(request,response)=>{
  if(request.method!=='POST'){response.writeHead(405).end();return;}let raw='';for await(const chunk of request)raw+=chunk;const rpc=JSON.parse(raw)as{id?:string|number;method?:string;params?:{protocolVersion:string};result?:unknown;error?:unknown},session=String(request.headers['mcp-session-id']??'');
  if(rpc.method===undefined){pending.get(String(rpc.id))?.(rpc.result??rpc.error);response.writeHead(202).end();return;}if(rpc.id===undefined){response.writeHead(202).end();return;}
  if(rpc.method==='initialize'){const id='synthetic-scope-'+(++connections);response.writeHead(200,{'content-type':'application/json','mcp-session-id':id}).end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{protocolVersion:rpc.params?.protocolVersion,capabilities:{tools:{},resources:{}},serverInfo:{name:'synthetic-scoped-root',version:'1'}}}));return;}
  let result:unknown={};if(['tools/list','tools/call','resources/read'].includes(rpc.method)){
   const rootId='synthetic-root-'+(++sequence),ready=new Promise<unknown>(resolve=>pending.set(rootId,resolve));response.writeHead(200,{'content-type':'text/event-stream'});response.write('event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',id:rootId,method:'roots/list',params:{}})+'\n\n');const timer=setTimeout(()=>pending.get(rootId)?.({error:'Root request was not answered'}),2000),roots=await ready;clearTimeout(timer);pending.delete(rootId);observed.push({method:rpc.method,session,roots});
   result=rpc.method==='tools/list'?{tools:[{name:'inspect',inputSchema:{type:'object',properties:{}}}]}:rpc.method==='tools/call'?{content:[{type:'text',text:JSON.stringify(roots)}]}:{contents:[{uri:'fixture://scope',text:'Synthetic root-scoped resource.'}]};response.end('event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',id:rpc.id,result})+'\n\n');return;
  }
  if(rpc.method==='resources/templates/list')result={resourceTemplates:[]};if(rpc.method==='resources/list')result={resources:[{uri:'fixture://scope',name:'Scope'}]};response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
 });remote.listen(0,'127.0.0.1');await once(remote,'listening');const address=remote.address();assert.ok(address&&typeof address!=='string');
 const model=new MastraLanguageModelV2Mock({doStream:async request=>{if(!request.tools?.some(tool=>tool.name==='task_report'))return stream();const task=core.runtime.tasks().find(task=>task.status==='running');assert.ok(task);const phase=turns.get(task.id)??0;turns.set(task.id,phase+1);if(phase===0)return stream('ext_scope_inspect',{},'root-tool-'+task.id);if(phase===1)return stream('read_mcp_resource',{serverId:'scope',uri:'fixture://scope'},'root-resource-'+task.id);if(phase===2){assert.match(JSON.stringify(request.prompt),/Synthetic root-scoped resource/);return stream('task_report',{id:task.id,report:{outcome:'succeeded',summary:'Read only the authorized project roots and resource.',checks:[{description:'Original scoped source returned.',passed:true}],deliveries:[],unresolved:[]}},'root-report-'+task.id);}return stream();}});
 core=await Core.open({dataDir:directory,model,memoryEnabled:false});
 try{core.capabilities.saveRoot({id:'second',path:second,name:'Second project'});await core.capabilities.saveMCP({id:'scope',url:`http://127.0.0.1:${address.port}`,protocolVersion:'legacy'});await core.capabilities.connect('scope');assert.deepEqual(observed[0]?.roots,{roots:[]});const expected:string[]=[];
  for(const workspaceId of ['default','second']){const root=core.capabilities.root(workspaceId),task=await core.submitTask({workspaceId,title:'Inspect exact project roots',content:'Read this project roots and its synthetic source. Request approval before each MCP operation.'},'synthetic-root-owner-'+workspaceId);const approvals=[];
   for(const name of ['ext_scope_inspect','read_mcp_resource']){const gate=await until(()=>core.runtime.approvals().find(row=>row.taskId===task.id&&row.status==='pending'&&row.toolName===name),Boolean);assert.ok(gate);approvals.push(gate);assert.equal(core.runtime.task(task.id).grants.mcp,false);if(name==='ext_scope_inspect')assert.deepEqual(observed.filter(row=>row.method==='tools/list').at(-1)?.roots,{roots:[]},'scope preparation does not disclose a root before approval');await core.approve(gate.id,'approve','once');expected.push(pathToFileURL(fs.realpathSync(root.path)).href);}
   const done=await until(()=>core.runtime.task(task.id),row=>['succeeded','failed','blocked','unreported','interrupted'].includes(row.status));assert.equal(done.status,'succeeded',JSON.stringify({done,observed,events:core.runtime.events(task.contextId,0,1000)}));assert.equal(approvals.length,2);
  }
  const actual=observed.filter(row=>row.method!=='tools/list').map(row=>{assert.ok(row.roots&&typeof row.roots==='object'&&'roots'in row.roots&&Array.isArray(row.roots.roots));assert.equal(row.roots.roots.length,1);return row.roots.roots[0]?.uri;});assert.deepEqual(actual,expected);assert.equal(new Set(observed.map(row=>row.session)).size,3,'rootless administration and both actual owners use separate native sessions');
 }finally{await core.close();remote.closeAllConnections();await new Promise<void>(resolve=>remote.close(()=>resolve()));await removeTemp(directory);}
});
