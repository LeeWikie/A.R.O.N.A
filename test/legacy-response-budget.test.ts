import assert from 'node:assert/strict';
import test from 'node:test';
import {legacyConversationPage,legacySnapshot,LEGACY_RESPONSE_CHARACTERS} from '../src/legacy-response.js';
import type {ConversationMessage,TuiSnapshot} from '../src/protocol.js';
const message=(content:string,id='synthetic'):ConversationMessage=>({id,contextId:'main',role:'assistant',content,createdAt:'2026-01-01T00:00:00.000Z',runId:null,status:'committed',kind:'message'});

test('legacy page capacity follows the exact JSON character envelope, including the final cursor',()=>{
 const original=message('','漢'.repeat(1700)),empty=legacyConversationPage({messages:[original],hasMore:false,nextCursor:null});
 original.content='中'.repeat(LEGACY_RESPONSE_CHARACTERS-JSON.stringify(empty).length);
 const full=legacyConversationPage({messages:[original],hasMore:false,nextCursor:null});
 assert.equal(JSON.stringify(full).length,LEGACY_RESPONSE_CHARACTERS);
 assert.equal(full.messages[0]!.content,original.content);assert.equal(full.messages[0]!.payloadRef,undefined);
 assert.ok(Buffer.byteLength(JSON.stringify(full))>LEGACY_RESPONSE_CHARACTERS*2);
 const overflow=legacyConversationPage({messages:[{...original,content:original.content+'a'}],hasMore:false,nextCursor:null});
 assert.ok(overflow.messages[0]!.payloadRef);assert.ok(JSON.stringify(overflow).length<LEGACY_RESPONSE_CHARACTERS);
});

test('a crowded snapshot cannot silently downgrade a message that a standalone page can carry',()=>{
 const row=message('a'.repeat(LEGACY_RESPONSE_CHARACTERS-1200));
 assert.equal(legacyConversationPage({messages:[row],hasMore:false,nextCursor:null}).messages[0]!.payloadRef,undefined);
 const snapshot={conversation:{messages:[row],hasMore:false,nextCursor:null},synthetic:'x'.repeat(2000)} as unknown as TuiSnapshot;
 assert.throws(()=>legacySnapshot(snapshot),{code:'snapshot_requires_stream'});
 const many={messages:[message('x'.repeat(6*1024*1024),'first'),message('y'.repeat(6*1024*1024),'second')],hasMore:false,nextCursor:null};
 const page=legacyConversationPage(many);assert.equal(page.messages.length,1);assert.equal(page.hasMore,true);assert.ok(page.nextCursor);assert.equal(page.messages[0]!.payloadRef,undefined);
});
