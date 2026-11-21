import assert from 'node:assert/strict';
import test from 'node:test';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {effectiveSessionDataIds} from '../src/session-data-scope.js';

test('historical data follows native last-edit restoration without mutating raw messages or adding a sibling target',()=>{
 const session=SessionManager.inMemory(),target=session.appendMessage({role:'user',content:'original',timestamp:1});session.appendContextEdit(target,{content:'first'});session.appendContextEdit(target,null);
 let branch=session.getBranch(),original=structuredClone(branch);assert.equal(effectiveSessionDataIds(branch).has(target),false);assert.equal(session.buildSessionProjection().entries.find(row=>row.sourceEntry.id===target)!.messages.length,0);assert.deepEqual(branch,original);
 session.appendContextEdit(target,{content:'restored'});branch=session.getBranch();original=structuredClone(branch);assert.equal(effectiveSessionDataIds(branch).has(target),true);assert.equal(session.buildSessionProjection().entries.find(row=>row.sourceEntry.id===target)!.messages.length,1);assert.deepEqual(branch,original);
 const restoredLeaf=session.getLeafId();session.branch(target);const sibling=session.appendMessage({role:'user',content:'sibling',timestamp:2});session.appendContextEdit(target,null);assert.equal(effectiveSessionDataIds(session.getBranch()).has(target),false);session.branch(restoredLeaf!);assert.equal(effectiveSessionDataIds(session.getBranch()).has(target),true);assert.equal(effectiveSessionDataIds(session.getBranch()).has(sibling),false);
});

test('compaction keeps prior data but does not revive a covered explicit omission; later non-null edits can restore it',()=>{
 const session=SessionManager.inMemory(),retained=session.appendMessage({role:'user',content:'original retained data',timestamp:1}),omitted=session.appendMessage({role:'user',content:'explicitly omitted data',timestamp:2});session.appendContextEdit(omitted,null);const checkpoint=session.appendCompaction('summary',null,100);let branch=session.getBranch();
 assert.equal(session.buildSessionProjection().entries.some(row=>row.sourceEntry.id===retained),false,'the native model projection has compacted this entry');assert.equal(session.buildSessionProjection().entries.some(row=>row.sourceEntry.type==='context_edit'),false,'the old edit is also outside the native retained model range');assert.equal(effectiveSessionDataIds(branch).has(retained),true,'historical data is not limited to current model message rows');assert.equal(effectiveSessionDataIds(branch).has(omitted),false,'compaction does not restore an explicit omission');
 session.appendContextEdit(omitted,{content:'explicit restoration'});assert.equal(effectiveSessionDataIds(session.getBranch()).has(omitted),true);session.branch(checkpoint);branch=session.getBranch();const hypothetical=[...branch,{type:'context_edit' as const,id:'foreign-edit',parentId:branch.at(-1)!.id,timestamp:new Date().toISOString(),targetId:'not-on-this-branch',replacement:{content:'cannot add another branch'}}];assert.equal(effectiveSessionDataIds(hypothetical).has('not-on-this-branch'),false);assert.equal(effectiveSessionDataIds(branch).has(omitted),false);
});
