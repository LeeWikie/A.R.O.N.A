import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';

export async function liveMcpCatalogFixture(options:{versioned?:boolean;notifyDuringFirstList?:boolean;names?:string[]}={}){
 let revision=0;
 let heldList:{entered:()=>void;gate:Promise<void>}|undefined,releaseList:(()=>void)|undefined;
 let heldName:string|undefined,entered:(()=>void)|undefined,release:(()=>void)|undefined,gate:Promise<void>|undefined,firstList=true;
 const calls:Array<{method:string;name?:string}>=[];
 const tool=(name:string)=>({name,description:'Synthetic catalog tool.',inputSchema:{type:'object',properties:{}}});
 const server=createServer(async(request,response)=>{
  if(request.method!=='POST'){response.writeHead(405).end();return;}
  let text='';for await(const chunk of request)text+=chunk;
  const rpc=JSON.parse(text) as {id?:number|string;method:string;params?:{protocolVersion?:string;name?:string;arguments?:{revision?:number}}};
  calls.push({method:rpc.method,name:rpc.params?.name});
  if(rpc.id===undefined){response.writeHead(202).end();return;}
  const send=(result:unknown)=>response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
  if(rpc.method==='initialize'){send({protocolVersion:rpc.params?.protocolVersion,capabilities:{tools:{listChanged:true}},serverInfo:{name:'synthetic-live-catalog',version:'1'}});return;}
  if(rpc.method==='tools/list'){
   if(heldList){const held=heldList;heldList=undefined;held.entered();await held.gate;}
   const tools=[tool('change'),...(options.names??[revision?'new_read':'old_read']).map(tool),...(options.versioned?[{name:'versioned',description:'Synthetic versioned tool.',inputSchema:{type:'object',properties:{revision:{const:revision}},required:['revision']},outputSchema:{type:'object',properties:{revision:{const:revision}},required:['revision']}}]:[])];
   if(firstList&&options.notifyDuringFirstList){firstList=false;revision++;response.writeHead(200,{'content-type':'text/event-stream'});response.write('event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',method:'notifications/tools/list_changed'})+'\n\n');response.end('event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{tools}})+'\n\n');return;}
   send({tools});return;
  }
  if(rpc.method==='tools/call'&&rpc.params?.name==='change'){
   revision++;
   response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
   response.write('event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',method:'notifications/tools/list_changed'})+'\n\n');
   response.end('event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{content:[{type:'text',text:'Catalog changed.'}]}})+'\n\n');return;
  }
  if(rpc.method==='tools/call'){
   const dispatchedRevision=revision;if(heldName===rpc.params?.name){heldName=undefined;entered?.();await gate;}
   send({content:[{type:'text',text:'Executed '+rpc.params?.name}],...(rpc.params?.name==='versioned'?{structuredContent:{revision:dispatchedRevision}}:{})});return;
  }
  send({});
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
 return{url:`http://127.0.0.1:${address.port}`,calls,configuration:{id:'live',url:`http://127.0.0.1:${address.port}`,protocolVersion:'legacy' as const},holdNextList(){let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});const gate=new Promise<void>(resolve=>{releaseList=resolve;});heldList={entered,gate};return {entered:ready,release(){releaseList?.();}};},holdNext(name:string){heldName=name;const ready=new Promise<void>(resolve=>{entered=resolve;});gate=new Promise<void>(resolve=>{release=resolve;});return{entered:ready,release(){release?.();}};},async close(){releaseList?.();release?.();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
