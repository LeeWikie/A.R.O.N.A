import {serve} from '@hono/node-server';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {createApp} from '../src/http.js';
import fs from 'node:fs';import path from 'node:path';

const directory=process.argv[2],mode=process.argv[3];if(!directory||!process.send)throw new Error('fixture_requires_ipc');
let calls=0;
const model=new MastraLanguageModelV2Mock({doStream:async()=>{calls++;throw new Error('unexpected_model_execution');}});
const core=await Core.open({dataDir:directory,model,memoryEnabled:false});
if(mode==='blob-gap'){
 const original=fs.linkSync;fs.linkSync=(source,target)=>{original(source,target);if(String(source).includes(path.join(directory,'session-transfers'))&&String(source).endsWith('.tmp')){fs.writeFileSync(path.join(directory,'blob-link-gap.json'),JSON.stringify({hash:path.basename(String(target)),links:fs.lstatSync(target).nlink}),{mode:0o600});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}};
}
if(mode==='publication-gap'){
 const original=core['importParsedPiContextNow'].bind(core);
 core['importParsedPiContextNow']=async(...args)=>{const context=await original(...args);process.send?.({type:'published',contextId:context.id});await new Promise<void>(()=>{});return context;};
}
const server=serve({hostname:'127.0.0.1',port:0,fetch:createApp(core).fetch});server.on('listening',()=>{const address=server.address();if(address&&typeof address!=='string')process.send?.({type:'ready',port:address.port,token:core.controlToken,storageId:core.storageId,calls,contexts:core.runtime.contexts().map(row=>row.id)});});
let stopping=false;process.once('SIGTERM',()=>{if(stopping)return;stopping=true;server.close();if('closeAllConnections'in server)server.closeAllConnections();void core.close().finally(()=>process.exit(0));});
