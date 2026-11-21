import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {SessionSource} from './session-graph.js';

const id=z.string().min(1).max(1024);
export const logicalSessionInputSchema=z.object({id,kind:z.literal('queue-logical-input'),contextId:id,runId:id,draftId:id,revision:z.number().int().positive(),entryId:id,originEntryId:id.optional(),originRevision:z.number().int().positive().optional(),signalIds:z.array(id).min(2),nativeMessageIds:z.array(id).min(2),originalNativeMessageIds:z.array(id).min(2),content:z.string(),contentHash:z.string().regex(/^[a-f0-9]{64}$/),attachments:z.array(z.string().uuid())}).strict().refine(value=>(value.originEntryId===undefined)===(value.originRevision===undefined)&&value.signalIds.length===value.nativeMessageIds.length&&value.signalIds.length===value.originalNativeMessageIds.length&&new Set(value.signalIds).size===value.signalIds.length&&new Set(value.nativeMessageIds).size===value.nativeMessageIds.length&&new Set(value.originalNativeMessageIds).size===value.originalNativeMessageIds.length&&createHash('sha256').update(value.content).digest('hex')===value.contentHash);
export type LogicalSessionInput=z.infer<typeof logicalSessionInputSchema>;
export function sourceMessageIds(source:SessionSource|undefined):string[]{return source?source.messageIds??[source.messageId]:[];}
