import assert from 'node:assert/strict';
import test from 'node:test';
import { recoveryDigest, recoveryEnvelopeSchema, recoveryMismatch,recoveryResource,recoveryRemaining, type RunRecoveryEnvelope, type NativeRecoveryRun } from '../src/run-recovery.js';

const envelope: RunRecoveryEnvelope = { version: 1, contextId: 'main', runId: 'run-one', signalId: 'signal-one', sourceHash: recoveryDigest('source'), configurationHash: recoveryDigest('configuration'), credentialHash: recoveryDigest('synthetic-key', 'local-salt'), anchor: { contextId: 'main', leafId: 'entry-one', revision: 3 }, connections: [], gates: [{ toolCallId: 'question-one', toolName: 'ask_user', approval: false }, { toolCallId: 'approval-two', toolName: 'synthetic_write', approval: true }] };
const native: NativeRecoveryRun = { runId: 'run-one', threadId: 'main', resourceId: 'local', status: 'suspended', toolCalls: [{ toolCallId: 'question-one', toolName: 'ask_user', requiresApproval: false }] };
test('only the original suspended run, source, configuration, branch and named native gate can recover', () => {
  assert.equal(recoveryMismatch(envelope, envelope, native), undefined);
  assert.equal(recoveryMismatch(envelope, envelope, { ...native, status: 'running' }), 'run_recovery_address_changed');
  for (const property of ['runId', 'threadId', 'resourceId'] as const) assert.equal(recoveryMismatch(envelope, envelope, { ...native, [property]: 'another' }), 'run_recovery_address_changed');
  assert.equal(recoveryMismatch(envelope, { ...envelope, anchor: { ...envelope.anchor!, revision: 4 } }, native), 'run_recovery_branch_changed');
  for (const [property, reason] of [['sourceHash', 'source'], ['configurationHash', 'configuration'], ['credentialHash', 'credentials']] as const) assert.equal(recoveryMismatch(envelope, { ...envelope, [property]: recoveryDigest('changed') }, native), `run_recovery_${reason}_changed`);
  for (const call of [{ toolCallId: 'unknown', toolName: 'ask_user' }, { toolCallId: 'question-one', toolName: 'synthetic_write' }, { toolCallId: 'question-one', toolName: 'ask_user', requiresApproval: true }]) assert.equal(recoveryMismatch(envelope, envelope, { ...native, toolCalls: [call] }), 'run_recovery_gate_changed');
  assert.equal(recoveryMismatch(envelope, envelope, { ...native, toolCalls: [] }), 'run_recovery_gate_changed');
});
test('already settled sibling calls do not block remaining native gates, and secrets are never envelope fields', () => {
  assert.equal(recoveryMismatch(envelope, envelope, { ...native, toolCalls: [{ toolCallId: 'approval-two', toolName: 'synthetic_write', requiresApproval: true }] }), undefined);
  assert.equal(recoveryEnvelopeSchema.safeParse({ ...envelope, access: 'synthetic-secret' }).success, false);
  assert.ok(!JSON.stringify(envelope).includes('synthetic-key'));
  assert.equal(recoveryDigest({ b: 2, a: { z: 3, y: 4 } }), recoveryDigest({ a: { y: 4, z: 3 }, b: 2 }));
  assert.notEqual(recoveryDigest(['a', 'b']), recoveryDigest(['b', 'a']));
  assert.notEqual(recoveryDigest('synthetic-key', 'local-salt'), recoveryDigest('synthetic-key', 'different-salt'));
});
test('repeated native restarts preserve one sealed deadline and reject widened or foreign resource records',()=>{
  const key='synthetic-resource-key',startedAt=new Date('2020-01-01T00:00:00Z');
  const resource=recoveryResource({taskId:'task',nativeTaskId:'native',startedAt,timeoutMs:30000},key);
  assert.equal(recoveryRemaining(resource,key,startedAt.getTime()+20000),10000);
  assert.deepEqual(recoveryResource({taskId:'task',nativeTaskId:'native',startedAt:new Date(startedAt.getTime()+20000),timeoutMs:10000},key,resource),resource);
  assert.equal(recoveryRemaining(resource,key,startedAt.getTime()+25000),5000);
  assert.throws(()=>recoveryRemaining(resource,key,startedAt.getTime()+30000),/run_recovery_task_expired/);
  assert.throws(()=>recoveryRemaining({...resource,deadlineAt:resource.deadlineAt+30000},key,startedAt.getTime()),/run_recovery_resource_changed/);
  assert.throws(()=>recoveryResource({taskId:'another',nativeTaskId:'native',startedAt,timeoutMs:30000},key,resource),/run_recovery_resource_changed/);
});
