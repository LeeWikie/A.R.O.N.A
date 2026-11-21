import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageList } from '@mastra/core/agent/message-list';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { nativeSessionEntries, projectPiSessionWithOrigins,projectSessionToolMetadata } from '../src/providers/session-replay.js';

const at='2026-01-02T03:04:05.000Z';
const origin={api:'openai-codex-responses',provider:'openai-codex',model:'synthetic-codex'};
const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};

test('native session projection retains opaque provenance, tool arguments and matching results through SDK conversion',async()=>{
  const entries:SessionEntry[]=[{type:'message',id:'user',parentId:null,timestamp:at,message:{role:'user',content:'authorized historical input',timestamp:1}},
    {type:'message',id:'assistant',parentId:'user',timestamp:at,message:{role:'assistant',...origin,usage,stopReason:'toolUse',timestamp:1,content:[{type:'thinking',thinking:'',thinkingSignature:JSON.stringify({type:'reasoning',id:'rs_synthetic',encrypted_content:'SYNTHETIC_OPAQUE',summary:[]})},{type:'text',text:'visible',textSignature:'synthetic-text-signature'},{type:'toolCall',id:'call_synthetic',name:'read_file',arguments:{path:'synthetic.txt'}}]}},
    {type:'message',id:'result',parentId:'assistant',timestamp:at,message:{role:'toolResult',toolCallId:'call_synthetic',toolName:'read_file',content:[{type:'text',text:'SYNTHETIC_TOOL_RESULT'}],isError:false,timestamp:1}}];
  const projected=projectPiSessionWithOrigins(entries,'result','one');const list=new MessageList({threadId:'one',resourceId:'local',filterIncompleteToolCalls:false});list.add(projected.messages,'memory');const prompt=JSON.stringify(await list.get.all.aiV5.llmPrompt());
  assert.ok(prompt.includes('SYNTHETIC_OPAQUE'));assert.ok(prompt.includes('synthetic-text-signature'));assert.ok(prompt.includes('SYNTHETIC_TOOL_RESULT'));assert.ok(prompt.includes('synthetic.txt'));
  const roundtrip=await nativeSessionEntries(projected.messages,null);const serialized=JSON.stringify(roundtrip);assert.ok(serialized.includes('SYNTHETIC_OPAQUE'));assert.ok(serialized.includes('SYNTHETIC_TOOL_RESULT'));assert.ok(serialized.includes('openai-codex-responses'));
  const legacy=structuredClone(projected.messages);for(const row of legacy)for(const part of row.content.parts)if(part.type==='reasoning'&&part.providerMetadata?.pi)part.providerMetadata={pi:part.providerMetadata.pi};
  const legacyBefore=JSON.stringify(legacy);const repaired=await nativeSessionEntries(legacy,null);assert.ok(JSON.stringify(repaired).includes('SYNTHETIC_OPAQUE'));assert.equal(JSON.stringify(legacy),legacyBefore);
  const other=projectPiSessionWithOrigins(entries,'result','two');assert.equal(new Set(projected.messages.map(row=>row.id).filter(id=>other.messages.some(row=>row.id===id))).size,0);
});

test('failed tool results retain image bytes and the failure bit through durable SDK roundtrip',async()=>{
  const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZQ0AAAAASUVORK5CYII=';
  const entries:SessionEntry[]=[{type:'message',id:'assistant',parentId:null,timestamp:at,message:{role:'assistant',...origin,usage,stopReason:'toolUse',timestamp:1,content:[{type:'toolCall',id:'failed-call',name:'image_tool',arguments:{}}]}},{type:'message',id:'result',parentId:'assistant',timestamp:at,message:{role:'toolResult',toolCallId:'failed-call',toolName:'image_tool',content:[{type:'text',text:'SYNTHETIC_ERROR'},{type:'image',mimeType:'image/png',data:image}],isError:true,timestamp:1}}];
  const native=projectPiSessionWithOrigins(entries,'result','failure');assert.ok(JSON.stringify(native.messages).includes(image));const restored=await nativeSessionEntries(native.messages,null);const result=restored.find(row=>row.entry.type==='message'&&row.entry.message.role==='toolResult')!;assert.equal(result.entry.type,'message');if(result.entry.type==='message'&&result.entry.message.role==='toolResult'){assert.equal(result.entry.message.isError,true);assert.equal(result.entry.message.content.find(part=>part.type==='image')?.data,image);}
});

test('imported system and extension content never becomes host instructions or runs code',async()=>{
  const entries:SessionEntry[]=[{type:'message',id:'system',parentId:null,timestamp:at,message:{role:'system',content:'SYNTHETIC_EXTERNAL_SYSTEM',timestamp:1}},{type:'custom',id:'extension',parentId:'system',timestamp:at,customType:'run-code',data:{command:'SYNTHETIC_NEVER_EXECUTE'}},{type:'custom_message',id:'custom',parentId:'extension',timestamp:at,customType:'historical-note',display:true,content:'SYNTHETIC_NOTE'}];
  const projected=projectPiSessionWithOrigins(entries,'custom','main');assert.equal(projected.messages.some(row=>row.role==='system'),false);const text=JSON.stringify(projected.messages);assert.ok(text.includes('SYNTHETIC_EXTERNAL_SYSTEM'));assert.ok(text.includes('SYNTHETIC_NOTE'));assert.ok(!text.includes('SYNTHETIC_NEVER_EXECUTE'));
});

test('request-only result metadata repair requires one exact matching tool name and failure bit',()=>{
  const call={role:'assistant' as const,content:[{type:'tool-call' as const,toolCallId:'call',toolName:'read_file',input:{},providerOptions:{pi:{isError:true}}}]};const result={role:'tool' as const,content:[{type:'tool-result' as const,toolCallId:'call',toolName:'read_file',output:{type:'json' as const,value:{}},providerOptions:{pi:{isError:true}}}]};const prompt=[call,result];const before=JSON.stringify(prompt);const projected=projectSessionToolMetadata(prompt);assert.equal(projected[0]!.role,'assistant');assert.ok(!JSON.stringify(projected[0]).includes('isError'));assert.ok(JSON.stringify(projected[1]).includes('isError'));assert.equal(JSON.stringify(prompt),before);
  const orphan=[call];assert.equal(projectSessionToolMetadata(orphan),orphan);
  const duplicate=[call,result,result];assert.equal(projectSessionToolMetadata(duplicate),duplicate);
  const wrongName=[call,{...result,content:[{...result.content[0]!,toolName:'write_file'}]}];assert.equal(projectSessionToolMetadata(wrongName),wrongName);
  const wrongFlag=[call,{...result,content:[{...result.content[0]!,providerOptions:{pi:{isError:false}}}]}];assert.equal(projectSessionToolMetadata(wrongFlag),wrongFlag);
});

test('unrepresented and invalid native reasoning retain source identities without becoming invented Pi messages',async()=>{
  const source={id:'native-reasoning-only',threadId:'main',resourceId:'local',role:'assistant' as const,type:'text',createdAt:new Date(at),content:{format:2 as const,parts:[{type:'reasoning' as const,reasoning:'SYNTHETIC_REASONING_SOURCE',details:[]}]}};
  const original=JSON.stringify(source);const retained=await nativeSessionEntries([source],null);assert.equal(retained.length,1);assert.equal(retained[0]!.entry.type,'custom');assert.equal(retained[0]!.source!.messageId,source.id);assert.equal(projectPiSessionWithOrigins(retained.map(row=>row.entry),retained[0]!.entry.id,'main').messages.length,0);assert.equal(JSON.stringify(source),original);
  const invalid={...source,id:'invalid-reasoning',content:{...source.content,parts:[{...source.content.parts[0]!,providerMetadata:{pi:{thinkingSignature:'SYNTHETIC_UNTRUSTED_OPAQUE'}}}]}};const before=JSON.stringify(invalid);const parked=await nativeSessionEntries([invalid],null);assert.equal(parked[0]!.entry.type,'custom');assert.equal(parked[0]!.source!.messageId,invalid.id);assert.equal(JSON.stringify(invalid),before);
});
