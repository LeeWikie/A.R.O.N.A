import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import test from 'node:test';
import {serve} from '@hono/node-server';
import type {Terminal} from '@earendil-works/pi-tui';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {Client} from '../src/client.js';
import {createApp} from '../src/http.js';
import {TerminalApp} from '../src/tui/index.js';
import {removeTemp} from './helpers.js';
const terminal={columns:100,rows:30,kittyProtocolActive:false,start(){},stop(){},async drainInput(){},write(){},moveBy(){},hideCursor(){},showCursor(){},clearLine(){},clearFromCursor(){},clearScreen(){},setTitle(){},setProgress(){},setProgramStatus(){}} as Terminal;
for(const protocol of ['responses','chat-completions','messages']as const)for(const selected of ['api-key','bearer']as const)test(`real TUI custom ${protocol} ${selected} selection reaches the actual provider request`,async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-tui-request-auth-')),originalFetch=globalThis.fetch,oldKey=process.env.SYNTHETIC_UI_AUTH_KEY,key='synthetic-ui-auth-value';process.env.SYNTHETIC_UI_AUTH_KEY=key;
 const core=await Core.open({dataDir:directory,model:new MastraLanguageModelV2Mock({doStream:async()=>{throw new Error('Unexpected native request');}}),memoryEnabled:false}),server=serve({fetch:createApp(core).fetch,hostname:'127.0.0.1',port:0});if(!server.listening)await once(server,'listening');const app=new TerminalApp(new Client(`http://127.0.0.1:${(server.address()as AddressInfo).port}`,core.controlToken),'main',terminal),ui=app as any;let observed:Headers|undefined;
 Object.assign(ui,{storageId:core.storageId,instanceId:core.instanceId,capabilities:new Set((await (ui.client as Client).handshake()).capabilities)});
 ui.prompt=async(title:string)=>({'模型配置 ID':'example','名称':'Example','服务地址':'https://ui-model-auth.invalid/v1','模型 ID':'synthetic-model','凭据名称（不是密钥）':'SYNTHETIC_UI_AUTH_KEY'}[title]);ui.choose=async(title:string)=>({'模型来源':'custom','接口协议':protocol,'认证方式':selected}[title]);
 globalThis.fetch=async(input,init)=>{const request=new Request(input,init);if(new URL(request.url).hostname!=='ui-model-auth.invalid')return originalFetch(input,init);observed=request.headers;if(protocol==='responses')return Response.json({id:'resp_ui',model:'synthetic-model',status:'completed',output:[{type:'message',id:'msg_ui',role:'assistant',content:[{type:'output_text',text:'answer',annotations:[]}]}],usage:{input_tokens:1,output_tokens:1,total_tokens:2}});if(protocol==='chat-completions')return Response.json({id:'chat_ui',object:'chat.completion',created:1,model:'synthetic-model',choices:[{index:0,message:{role:'assistant',content:'answer'},finish_reason:'stop',logprobs:null}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});return Response.json({id:'msg_ui',type:'message',role:'assistant',model:'synthetic-model',content:[{type:'text',text:'answer'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:1,output_tokens:1}});};
 try{await ui.createModel();const saved=core.models.profile('example');assert.ok(saved&&'requestAuth'in saved);assert.equal(saved.requestAuth,selected);assert.equal(saved.authHeader,selected);const result=await core.models.resolve('example').doGenerate({prompt:[{role:'user',content:[{type:'text',text:'Synthetic model request.'}]}]});assert.equal(result.content.find(part=>part.type==='text')?.text,'answer');assert.ok(observed);assert.equal(observed.get('authorization'),selected==='bearer'?`Bearer ${key}`:null);assert.equal(observed.get('api-key')??observed.get('x-api-key'),selected==='api-key'?key:null);
 }finally{globalThis.fetch=originalFetch;if(oldKey===undefined)delete process.env.SYNTHETIC_UI_AUTH_KEY;else process.env.SYNTHETIC_UI_AUTH_KEY=oldKey;await app.stop();if('closeAllConnections'in server)server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await core.close();await removeTemp(directory);}
});

test('legacy OpenAI authentication preselects the actual Bearer behavior while explicit editing records the selected new scheme',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-tui-legacy-auth-')),core=await Core.open({dataDir:directory,model:new MastraLanguageModelV2Mock({doStream:async()=>{throw new Error('Unexpected model request');}}),memoryEnabled:false});core.models.save({id:'legacy',name:'Legacy',protocol:'responses',baseURL:'https://ui-model-auth.invalid/v1',modelId:'synthetic',apiKeyEnv:'SYNTHETIC_UI_AUTH_KEY',authHeader:'api-key',thinking:{}});
 const server=serve({fetch:createApp(core).fetch,hostname:'127.0.0.1',port:0});if(!server.listening)await once(server,'listening');const app=new TerminalApp(new Client(`http://127.0.0.1:${(server.address()as AddressInfo).port}`,core.controlToken),'main',terminal),ui=app as any;Object.assign(ui,{storageId:core.storageId,instanceId:core.instanceId,capabilities:new Set((await (ui.client as Client).handshake()).capabilities)});ui.pick=async()=> 'legacy';
 ui.choose=async(title:string,items:Array<{value:string;label:string;description?:string}>)=>{if(title.startsWith('编辑')){assert.match(items.find(row=>row.value==='authHeader')!.label,/Bearer/);return 'authHeader';}assert.equal(title,'认证方式');assert.equal(items[0]!.value,'bearer');assert.equal(items[0]!.description,'当前生效');return 'api-key';};
 try{await ui.editModel();const saved=core.models.profile('legacy');assert.ok(saved&&'requestAuth'in saved);assert.equal(saved.requestAuth,'api-key');assert.equal(saved.authHeader,'api-key');}finally{await app.stop();if('closeAllConnections'in server)server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await core.close();await removeTemp(directory);}
});
