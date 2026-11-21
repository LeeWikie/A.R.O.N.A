import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import type { Memory } from '@mastra/memory';
import { AppError } from './domain.js';

const anchorSchema = z.object({ contextId: z.string(), leafId: z.string().nullable(), revision: z.number().int().nonnegative() }).strict();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const resourceSchema=z.object({taskId:z.string(),nativeTaskId:z.string(),deadlineAt:z.number().safe().positive(),originalTimeoutMs:z.number().safe().positive(),digest:hash}).strict();
export const recoveryEnvelopeSchema = z.object({
  version: z.literal(1), contextId: z.string(), runId: z.string(), signalId: z.string(),
  sourceHash: hash, configurationHash: hash, credentialHash: hash,
  imagePolicyHash:hash.optional(),
  anchor: anchorSchema.nullable(),
  connections: z.array(z.object({ id: z.string(), key: hash }).strict()).default([]),
  resources:z.array(resourceSchema).optional(),
  gates: z.array(z.object({ toolCallId: z.string(), toolName: z.string(), approval: z.boolean() }).strict()).min(1),
}).strict();
export type RunRecoveryEnvelope = z.infer<typeof recoveryEnvelopeSchema>;
export type RecoveryResource=z.infer<typeof resourceSchema>;
export function recoveryResource(input:{taskId:string;nativeTaskId:string;startedAt?:Date;timeoutMs:number},key:string,previous?:RecoveryResource):RecoveryResource{
  if(previous){const {digest,...value}=previous;if(value.taskId!==input.taskId||value.nativeTaskId!==input.nativeTaskId||recoveryDigest(value,key)!==digest)throw new AppError('run_recovery_resource_changed',409);return previous;}
  const startedAt=input.startedAt?.getTime();if(!Number.isFinite(startedAt)||!Number.isSafeInteger(input.timeoutMs)||input.timeoutMs<=0)throw new AppError('run_recovery_task_receipt_unavailable',409);
  const value={taskId:input.taskId,nativeTaskId:input.nativeTaskId,deadlineAt:startedAt!+input.timeoutMs,originalTimeoutMs:input.timeoutMs};return {...value,digest:recoveryDigest(value,key)};
}
export function recoveryRemaining(resource:RecoveryResource,key:string,now=Date.now()){
  const {digest,...value}=resource;if(recoveryDigest(value,key)!==digest)throw new AppError('run_recovery_resource_changed',409);
  const remaining=Math.ceil(resource.deadlineAt-now);if(remaining<=0)throw new AppError('run_recovery_task_expired',409);return Math.min(remaining,resource.originalTimeoutMs);
}
export interface NativeRecoveryRun {
  runId?: string; threadId?: string; resourceId?: string; status?: string;
  toolCalls: Array<{ toolCallId?: string; toolName?: string; requiresApproval?: boolean }>;
}
export type RecoveryStamp = Pick<RunRecoveryEnvelope, 'contextId' | 'sourceHash' | 'configurationHash' | 'credentialHash' | 'imagePolicyHash' | 'anchor'>;
export interface RunRecoveryCleanup {
  contextId:string; runId:string; status:'complete'|'pending'|'blocked';
  attempts?:number; nextAttemptAt?:string;
  resources:Array<{taskId:string;nativeTaskId:string;status:'released'|'pending'|'blocked';code?:string}>;
}
export function recoveryIdentity(envelope:RunRecoveryEnvelope){return {contextId:envelope.contextId,runId:envelope.runId,sourceHash:envelope.sourceHash,configurationHash:envelope.configurationHash,credentialHash:envelope.credentialHash,...(envelope.imagePolicyHash?{imagePolicyHash:envelope.imagePolicyHash}:{}),anchor:envelope.anchor,connections:envelope.connections};}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
/** Credentials enter only a keyed digest; no credential bytes become recovery records. */
export function recoveryDigest(value: unknown, key?: string): string {
  const text = JSON.stringify(canonical(value));
  return key ? createHmac('sha256', key).update(text).digest('hex') : createHash('sha256').update(text).digest('hex');
}
export function recoveryMismatch(envelope: RunRecoveryEnvelope, current: RecoveryStamp, native: NativeRecoveryRun): string | undefined {
  if (native.status !== 'suspended' || native.runId !== envelope.runId || native.threadId !== envelope.contextId || native.resourceId !== 'local' || current.contextId !== envelope.contextId) return 'run_recovery_address_changed';
  if (recoveryDigest(envelope.anchor) !== recoveryDigest(current.anchor)) return 'run_recovery_branch_changed';
  if (envelope.sourceHash !== current.sourceHash) return 'run_recovery_source_changed';
  if(current.imagePolicyHash&&!envelope.imagePolicyHash)return 'run_recovery_image_policy_unavailable';
  if(envelope.imagePolicyHash!==current.imagePolicyHash)return 'run_recovery_image_policy_changed';
  if (envelope.configurationHash !== current.configurationHash) return 'run_recovery_configuration_changed';
  if (envelope.credentialHash !== current.credentialHash) return 'run_recovery_credentials_changed';
  if (!native.toolCalls.length || native.toolCalls.some(call => !envelope.gates.some(gate => gate.toolCallId === call.toolCallId && gate.toolName === call.toolName && gate.approval === Boolean(call.requiresApproval)))) return 'run_recovery_gate_changed';
  return undefined;
}

/** Native recall omits resourceId on stored messages; persistence still requires its real thread owner. */
export function bindMemoryResource(memory: Memory, expectedResourceId: string) {
  const save=memory.saveMessages.bind(memory);
  memory.saveMessages=async input=>{
    const owners=new Map<string,Promise<string|undefined>>();
    const messages=await Promise.all(input.messages.map(async message=>{
      if(message.resourceId||!message.threadId)return message;
      let owner=owners.get(message.threadId);
      if(!owner){owner=memory.getThreadById({threadId:message.threadId}).then(thread=>thread?.resourceId);owners.set(message.threadId,owner);}
      const resourceId=await owner;
      if(!resourceId)return message;
      if(resourceId!==expectedResourceId)throw new AppError('memory_resource_mismatch',403);
      return {...message,resourceId};
    }));
    return save({...input,messages});
  };
}
