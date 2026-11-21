import fs from 'node:fs';
import path from 'node:path';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {until} from './helpers.js';
import {createHash} from 'node:crypto';
import {splitQueueText} from '../src/queue-content.js';

const directory=process.argv[2]!;let release!:()=>void,calls=0;const gate=new Promise<void>(resolve=>{release=resolve;});
const model=new MastraLanguageModelV2Mock({doStream:async request=>{if(++calls===1)await gate;else{fs.writeFileSync(path.join(directory,'ordered-group-boundary.json'),JSON.stringify({prompt:request.prompt}));process.send?.({type:'group-request'});await new Promise<void>(()=>{});}return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}});
const core=await Core.open({dataDir:directory,model,memoryEnabled:false});await core.submitMessage({content:'ORDER_ACTIVE'});await until(()=>calls,n=>n===1);
const logical=process.argv[3]==='logical',assets=[];for(let i=0;i<9;i++){const asset=await core.assets.put(new Response(`ORDER_ASSET_${i}`).body,`order-${i}.txt`);assets.push(asset);if(!logical)await core.submitMessage({content:`ORDER_MEMBER_${i}`,attachments:[asset.id],mode:'queue'});}if(logical)await core.submitMessage({content:'ORDER_LOGICAL_SOURCE',mode:'queue'});
const contents=core.assets.contents.bind(core.assets);core.assets.contents=async(...args)=>{const match=/^ORDER_MEMBER_(\d+)$/.exec(args[0]);if(match)await new Promise(resolve=>setTimeout(resolve,(9-Number(match[1]))*8));return contents(...args);};
let draft=core.queueEditor().create('main',{},'ordered-group');if(logical){const content='原始逻辑'.repeat(20000)+'ORDER_LOGICAL_END',parts=splitQueueText(content),entry=core.queueEditor().page('main',draft.id).entries[0]!;const upload=core.queueEditor().beginEntryEdit('main',draft.id,{entryId:entry.id,expectedRevision:draft.revision,partCount:parts.length,characters:content.length,hash:createHash('sha256').update(content).digest('hex'),attachments:assets.map(asset=>asset.id)},'logical-edit');for(const[index,part]of parts.entries())core.queueEditor().writeEntryPart('main',draft.id,upload.id,index,{content:part});draft=core.queueEditor().commitEntryEdit('main',draft.id,upload.id);}await core.queueEditor().submit('main',draft.id,{expectedRevision:draft.revision},'ordered-submit');release();await new Promise(()=>{});
