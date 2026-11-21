import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';

const[directory,phase]=process.argv.slice(2);if(!directory||!phase)throw Error('fixture_arguments');
const core=await Core.open({dataDir:directory,memoryEnabled:false,model:new MastraLanguageModelV2Mock({doStream:async()=>{throw Error('editing must not execute');}})}),attachments:string[]=[];
for(let index=0;index<9;index++)attachments.push((await core.assets.put(new Response(`ATTACHMENT_CRASH_ORIGINAL_${index}_END`).body,`original-${index}.txt`)).id);
const nonce=randomUUID(),draft=core.queueEditor().create('main',{current:{content:'ORIGINAL_BEFORE_EDIT',clientDraftId:nonce},captureQueue:false,localCapture:true},randomUUID()),entry=core.queueEditor().page('main',draft.id).entries[0]!,operation=randomUUID(),content='ORIGINAL_LOGICAL_INPUT',parts=[JSON.stringify(attachments.slice(0,5)),JSON.stringify(attachments.slice(5))],input={entryId:entry.id,expectedRevision:draft.revision,partCount:1,characters:content.length,hash:createHash('sha256').update(content).digest('hex'),attachments:[],captureDraftId:nonce,localContext:'ORIGINAL_CLIENT_OBSERVATION',attachmentParts:{partCount:parts.length,items:attachments.length,hash:createHash('sha256').update(JSON.stringify(attachments)).digest('hex')}},upload=core.queueEditor().beginEntryEdit('main',draft.id,input,operation);
const boundary=(saved?:unknown)=>{fs.writeFileSync(path.join(directory,'attachment-boundary.json'),JSON.stringify({draftId:draft.id,entryId:entry.id,operation,input,uploadId:upload.id,content,parts,attachments,saved}));process.kill(process.pid,'SIGKILL');};
core.queueEditor().writeEntryPart('main',draft.id,upload.id,0,{content});
if(phase==='during-part'){const set=core.runtime.setSetting.bind(core.runtime);core.runtime.setSetting=(key,value)=>{set(key,value);if(key===`queue-entry-part:${upload.id}:attachments:0`)boundary();};}
core.queueEditor().writeEntryPart('main',draft.id,upload.id,0,{content:parts[0]!},'attachments');if(phase==='part-committed')boundary();core.queueEditor().writeEntryPart('main',draft.id,upload.id,1,{content:parts[1]!},'attachments');const saved=core.queueEditor().commitEntryEdit('main',draft.id,upload.id);if(phase==='upload-committed')boundary(saved);throw Error('crash_boundary_not_reached');
