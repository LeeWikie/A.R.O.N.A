import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHash,randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { serve } from '@hono/node-server';
import type { Terminal } from '@earendil-works/pi-tui';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { Client } from '../src/client.js';
import { createApp } from '../src/http.js';
import { TerminalApp } from '../src/tui/index.js';
import { ShellOutputCaptures } from '../src/tui/shell-output.js';
import { QueueLocalEdits } from '../src/tui/queue-local-edits.js';
import type { QueueEditDocument } from '../src/protocol.js';
import { splitQueueText } from '../src/queue-content.js';
import { finished, until, removeTemp } from './helpers.js';
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const terminal={columns:100,rows:30,kittyProtocolActive:false,start(){},stop(){},async drainInput(){},write(){},moveBy(){},hideCursor(){},showCursor(){},clearLine(){},clearFromCursor(){},clearScreen(){},setTitle(){},setProgress(){},setProgramStatus(){}} as Terminal;
function reply(input?:unknown){return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});if(input)c.enqueue({type:'tool-call',toolCallId:randomUUID(),toolName:'read_attachment',input:JSON.stringify(input)});c.enqueue({type:'finish',finishReason:input?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}

for(const delivery of ['idle','steer','queue']as const)test(`real App ${delivery} Enter sends complete large Skill input, nine staged files and exact client shell streams as one native input group`, {timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-app-shell-logical-')),localDirectory=path.join(directory,'client'),captures=new ShellOutputCaptures(localDirectory,'control-scope'),local=new QueueLocalEdits(localDirectory,'control-scope');
  const stdout=Buffer.from(Array.from({length:70003},(_,i)=>i%256)),stderr=Buffer.from([0,255,27,7]);fs.writeFileSync(path.join(directory,'stdout.bin'),stdout);fs.writeFileSync(path.join(directory,'stderr.bin'),stderr);fs.writeFileSync(path.join(directory,'command.cjs'),"const fs=require('node:fs');process.stdout.write(fs.readFileSync('stdout.bin'));process.stderr.write(fs.readFileSync('stderr.bin'));process.exitCode=3;");
  let core!:Core,firstPrompt='',calls=0,error:unknown,manifestId='',stage=0,offset=0,currentStream=0,heldStarted=false,heldAborted=false,activeRequests=0,maximumRequests=0,release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});const original:[Buffer,Buffer]=[stdout,stderr],read:[Buffer[],Buffer[]]=[[],[]];let descriptors:Array<{stream:string;parts:Array<{id:string;sha256:string}>}> = [];
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{try{
    calls++;activeRequests++;maximumRequests=Math.max(maximumRequests,activeRequests);if(delivery!=='idle'&&!heldStarted){heldStarted=true;try{await new Promise<void>((resolve,reject)=>{hold.then(resolve);const abort=()=>{heldAborted=true;reject(new DOMException('Aborted','AbortError'));};if(request.abortSignal?.aborted)abort();else request.abortSignal?.addEventListener('abort',abort,{once:true});});return reply();}finally{activeRequests--;}}activeRequests--;const documents=core.runtime.queueEditDocuments<QueueEditDocument>(),sources=documents.at(-1)!.submission!.entries.map(row=>row.signalId);
    if(stage++===0){firstPrompt=JSON.stringify(request.prompt);const row=core.store.db.prepare("SELECT body FROM asset_records WHERE json_extract(body,'$.name') LIKE '%-shell-output.jsonl'").get();assert.ok(row);manifestId=(JSON.parse(String(row.body)) as {id:string}).id;return reply({id:manifestId,signalIds:sources,encoding:'text'});}
    const result=request.prompt.filter(message=>message.role==='tool').flatMap(message=>message.content).findLast(part=>part.type==='tool-result'&&part.toolName==='read_attachment');assert.ok(result&&result.type==='tool-result'&&result.output.type==='json');const page=result.output.value as unknown as {content:string;nextByteOffset:number|null;source:{sha256:string}};
    if(stage===2){const rows=page.content.trimEnd().split('\n').map(line=>JSON.parse(line));assert.equal(rows[0].exitCode,3);assert.equal(rows[0].state,'finished');descriptors=rows.slice(1);}
    else{read[currentStream]!.push(Buffer.from(page.content,'base64'));assert.equal(page.source.sha256,sha(original[currentStream]!));if(page.nextByteOffset===null){assert.deepEqual(Buffer.concat(read[currentStream]!),original[currentStream]);currentStream++;offset=0;}else offset=page.nextByteOffset;}
    if(currentStream===2)return reply();const part=descriptors[currentStream]!.parts[0]!;return reply({id:part.id,signalIds:sources,encoding:'base64',expectedSha256:part.sha256,byteOffset:offset,maxBytes:32768});
  }catch(caught){if(!(caught instanceof Error&&caught.name==='AbortError'&&request.abortSignal?.aborted))error=caught;throw caught;}}});
  core=await Core.open({dataDir:path.join(directory,'core'),model,memoryEnabled:false,modelConfig:{protocol:'responses',baseURL:'https://fixture.invalid/v1',apiKey:'synthetic-only',authHeader:'bearer',modelId:'app-input-fixture',contextWindow:512000,maxTokens:1024}});
  const skill=path.join(directory,'core','workspace','.agents','skills','example');fs.mkdirSync(skill,{recursive:true});fs.writeFileSync(path.join(skill,'SKILL.md'),'---\nname: example\ndescription: Synthetic explicitly selected input.\n---\nSYNTHETIC_APP_SKILL_BODY\n');
  const server=serve({fetch:createApp(core).fetch,hostname:'127.0.0.1',port:0});if(!server.listening)await once(server,'listening');const client=new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`,core.controlToken),app=new TerminalApp(client,'main',terminal,{completionBase:directory,shellOutputs:captures,queueEdits:local}),ui=app as any;const notes:string[]=[];ui.note=(text:string)=>notes.push(text);ui.choose=async(_title:string,items:Array<{value:string}>)=>items.some(row=>row.value==='yes')?'yes':items[0]?.value;
  Object.assign(ui,{storageId:core.storageId,instanceId:core.instanceId,contextReady:true,contextRole:'main',isMainContext:true,capabilities:new Set((await client.handshake()).capabilities)});
  try{
    assert.ok(ui.capabilities.has('logical-input'),'the unmodified Core handshake enables the actual default entry');
    const active=delivery==='idle'?undefined:await core.submitMessage({content:'SYNTHETIC_ORIGINAL_BUSY_INPUT'});if(active){await until(()=>heldStarted,Boolean);ui.currentRunId=active.runId;}
    await ui.submit(`!"${process.execPath}" command.cjs`);await ui.submit('!!echo SYNTHETIC_PRIVATE_COMMAND');assert.equal(calls,delivery==='idle'?0:1);assert.equal(captures.list(core.storageId,'main').length,2);
    for(let i=0;i<9;i++){const file=path.join(directory,`file-${i}.txt`);fs.writeFileSync(file,`SYNTHETIC_APP_FILE_${i}`);await ui.stageAttachment(await ui.readLocalAttachment(file));}assert.equal(ui.pendingAttachments.get('main').length,9);
    const text='/skill:example '+Array.from({length:7000},(_,i)=>`完整输入🙂${i.toString(16).padStart(6,'0')};`).join('');await ui.submit(text,delivery==='queue'?'queue':undefined);if(active){const current=core.runtime.queueEditDocuments<QueueEditDocument>().at(-1)!;assert.equal(current.submission!.mode,delivery);if(delivery==='queue'){assert.equal(stage,0,'follow-up waits for the active request');assert.equal(heldAborted,false);}else assert.equal(heldAborted,true,'native steering aborts the old provider request before the replacement request');assert.equal(maximumRequests,1,'native input admission never leaves two provider requests active');release();}
    await until(()=>core.runtime.queueEditDocuments<QueueEditDocument>().at(-1)?.status,status=>status==='submitted').catch(()=>assert.fail(JSON.stringify(notes)));const draft=core.runtime.queueEditDocuments<QueueEditDocument>().at(-1)!;assert.equal((await finished(core,draft.submission!.runId!))?.status,'succeeded');if(error)throw error;
    for(const part of splitQueueText(text))assert.ok(firstPrompt.includes(part));for(let i=0;i<9;i++)assert.match(firstPrompt,new RegExp(`SYNTHETIC_APP_FILE_${i}`));assert.equal(firstPrompt.split('SYNTHETIC_APP_SKILL_BODY').length-1,1);assert.equal(firstPrompt.includes('SYNTHETIC_PRIVATE_COMMAND'),false);assert.equal(firstPrompt.includes(stdout.toString('base64')),false);
    assert.equal(new Set(draft.submission!.entries.map(row=>core.store.getSignal(row.signalId)!.runId)).size,1);assert.equal(currentStream,2);assert.equal(captures.list(core.storageId,'main',true).length,0);assert.equal(local.captures(core.storageId,'main').length,0);assert.equal(ui.pendingAttachments.has('main'),false);assert.equal(ui.sharedShell.has('main'),false);assert.ok(calls>1,'further requests are real source reads in the same run, not extra input consumers');
  }finally{release();await app.stop();if('closeAllConnections'in server)server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await core.close();await removeTemp(directory);}
});
