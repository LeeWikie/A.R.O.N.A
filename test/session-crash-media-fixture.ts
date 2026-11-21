import {serve} from '@hono/node-server';
import {createHash} from 'node:crypto';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {createApp} from '../src/http.js';

const directory=process.argv[2],mode=process.argv[3];if(!directory||!process.send)throw new Error('fixture_requires_ipc');let calls=0;
const model=new MastraLanguageModelV2Mock({doStream:async request=>{calls++;const text=request.prompt.filter(message=>message.role!=='system').flatMap(message=>message.content.flatMap(part=>part.type==='text'?[part.text]:[])).join('\n');const images=request.prompt.flatMap(message=>message.role==='user'?message.content.flatMap(part=>{if(part.type!=='file')return [];if(part.data instanceof URL)throw new Error('unexpected_remote_attachment');const bytes=typeof part.data==='string'?Buffer.from(part.data.replace(/^data:[^,]*,/i,''),'base64'):Buffer.from(part.data);return [{mediaType:part.mediaType,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}];}):[]);process.send?.({type:'model-call',calls,text,images});
  if(mode==='gap')await new Promise<void>(()=>{});
  return {stream:new ReadableStream({start(controller){controller.enqueue({type:'stream-start',warnings:[]});controller.enqueue({type:'text-start',id:'text'});controller.enqueue({type:'text-delta',id:'text',delta:'SYNTHETIC_MEDIA_RECOVERY_COMPLETE'});controller.enqueue({type:'text-end',id:'text'});controller.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});controller.close();}})};
}});
const core=await Core.open({dataDir:directory,model,memoryEnabled:false});
if(mode==='gap'){
  const save=core.memory.saveMessages.bind(core.memory);
  core.memory.saveMessages=async input=>{if(input.messages.some(message=>['user','signal'].includes(message.role)&&JSON.stringify(message.content).includes('SYNTHETIC_MEDIA_ORIGINAL'))){process.send?.({type:'user-save-gap'});await new Promise<void>(()=>{});}return save(input);};
}
const server=serve({hostname:'127.0.0.1',port:0,fetch:createApp(core).fetch});server.on('listening',()=>{const address=server.address();if(address&&typeof address!=='string')process.send?.({type:'ready',port:address.port,token:core.controlToken,storageId:core.storageId});});
process.on('message',message=>{if(!message||typeof message!=='object'||!('type' in message)||message.type!=='inspect')return;void (async()=>{const native=await core.memory.recall({threadId:'main',page:0,perPage:100,hideSignals:false});process.send?.({type:'inspection',calls,nativeIds:native.messages.map(row=>row.id),sources:core.sessionGraph.records('main').flatMap(row=>row.source?.recoveredSignalId?[row.source]:[]),files:native.messages.flatMap(row=>row.content.parts.filter(part=>part.type==='file')),assetCount:Number(core.store.db.prepare('SELECT COUNT(*) n FROM asset_records').get()!.n)});})();});
let stopping=false;const stop=()=>{if(stopping)return;stopping=true;server.close();if('closeAllConnections' in server)server.closeAllConnections();void core.close().finally(()=>process.exit(0));};process.once('SIGTERM',stop);process.once('SIGINT',stop);
