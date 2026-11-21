import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {formatQuestionAnswer} from '@mastra/core/tools';
import {AppError} from './domain.js';
import type {InteractionAnswer,InteractionAnswerReceipt,InteractionAnswerStatus,InteractionRecord} from './interactions.js';

export interface InteractionAnswerRecord extends InteractionAnswerReceipt {answer:InteractionAnswer;answerHash:string;recoveryHash:string;nativeMessageId?:string}
const object=(value:unknown):Record<string,unknown>|undefined=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
/** Read the native foreach checkpoint, never infer completion from a missing suspension. */
export function interactionAnswerCheckpoint(snapshot:unknown,address:{contextId:string;runId:string;toolCallId:string;toolName:string;nativeMessageId?:string}){
  const state=object(snapshot),context=object(state?.context),request=object(state?.requestContext),owner=object(request?.['shittimchest-native-input-run']),parent=object(state?.parentWorkflow);
  if(state?.runId!==address.runId||parent?.workflowId!=='agentic-loop'||parent.runId!==address.runId||parent.stepId!=='executionWorkflow'||request?.mastra__threadId!==address.contextId||request.mastra__resourceId!=='local'||owner?.runId!==address.runId||owner.contextId!==address.contextId)return;
  const llm=object(context?.['llm-execution']),input=object(context?.input),output=object(llm?.output),step=object(context?.toolCallStep);
  const messageId=output?.messageId;if(llm?.status!=='success'||typeof messageId!=='string'||!messageId||input?.messageId!==messageId||address.nativeMessageId&&address.nativeMessageId!==messageId||!Array.isArray(step?.payload))return;
  const calls=step.payload.map(object),matches=calls.flatMap((call,index)=>call?.toolCallId===address.toolCallId&&call.toolName===address.toolName?[index]:[]);if(matches.length!==1)return;
  const index=matches[0]!,payload=object(step.suspendPayload),meta=object(payload?.__workflow_meta),entries=meta?.foreachOutput;
  const entry=object(Array.isArray(entries)?entries[index]:object(entries)?.[String(index)]);if(!entry)return;
  if(entry.status==='success'){
    const result=object(entry.output);if(result?.toolCallId!==address.toolCallId||result.toolName!==address.toolName)return;
    return {messageId,status:'completed' as const,result:result.result};
  }
  const suspension=object(entry.suspendPayload);
  if(entry.status==='suspended'&&suspension?.toolCallId===address.toolCallId&&suspension.toolName===address.toolName&&suspension.__agentId)return {messageId,status:'pending' as const};
}
const terminal=new Set<InteractionAnswerStatus>(['delivered','cancelled']);
export const interactionAnswerHash=(answer:InteractionAnswer)=>createHash('sha256').update(JSON.stringify(answer)).digest('hex');
export function interactionAnswerAcknowledged(record:InteractionAnswerRecord,interaction:InteractionRecord,result:unknown,isError?:boolean){
  if(isError||!result||typeof result!=='object'||Array.isArray(result))return false;
  const value=result as Record<string,unknown>;if(value.isError!==false)return false;
  if(interaction.kind==='question')return (typeof record.answer==='string'||Array.isArray(record.answer))&&value.content===`User answered: ${formatQuestionAnswer(record.answer)}`;
  if(typeof record.answer!=='object'||Array.isArray(record.answer)||!value.submittedPlan||typeof value.submittedPlan!=='object')return false;
  const plan=value.submittedPlan as Record<string,unknown>;
  return plan.action===record.answer.action&&(record.answer.action==='approved'||(plan.feedback??'')===(record.answer.feedback??''));
}

/** Durable user answers and delivery receipts share the host's transaction boundary. */
export class InteractionAnswerOutbox {
  constructor(private readonly db:DatabaseSync){db.exec("CREATE TABLE IF NOT EXISTS interaction_answer_outbox(id TEXT PRIMARY KEY,interaction_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS interaction_answer_scope ON interaction_answer_outbox(json_extract(body,'$.contextId'),json_extract(body,'$.status'))");}
  private transaction<T>(operation:()=>T){if(this.db.isTransaction)return operation();this.db.exec('BEGIN IMMEDIATE');try{const result=operation();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  private write(record:InteractionAnswerRecord){this.db.prepare('INSERT INTO interaction_answer_outbox(id,interaction_id,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(record.id,record.interactionId,JSON.stringify(record));return record;}
  get(id:string):InteractionAnswerRecord|undefined{const row=this.db.prepare('SELECT body FROM interaction_answer_outbox WHERE id=? OR interaction_id=?').get(id,id);return row?JSON.parse(String(row.body)) as InteractionAnswerRecord:undefined;}
  list(contextId?:string){return this.db.prepare('SELECT body FROM interaction_answer_outbox WHERE ? IS NULL OR json_extract(body,\'$.contextId\')=? ORDER BY rowid').all(contextId??null,contextId??null).map(row=>JSON.parse(String(row.body)) as InteractionAnswerRecord);}
  active(contextId?:string){return this.db.prepare("SELECT body FROM interaction_answer_outbox WHERE (? IS NULL OR json_extract(body,'$.contextId')=?) AND json_extract(body,'$.status') NOT IN ('delivered','cancelled') ORDER BY rowid").all(contextId??null,contextId??null).map(row=>JSON.parse(String(row.body)) as InteractionAnswerRecord);}
  page(options:{contextId?:string;after?:number;limit?:number;active?:boolean}={}){
    const after=options.after??0,limit=options.limit??100;if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>2000)throw new AppError('invalid_query');
    const rows=this.db.prepare("SELECT rowid,body FROM interaction_answer_outbox WHERE rowid>? AND (? IS NULL OR json_extract(body,'$.contextId')=?) AND (?=0 OR json_extract(body,'$.status') NOT IN ('delivered','cancelled')) ORDER BY rowid LIMIT ?").all(after,options.contextId??null,options.contextId??null,options.active?1:0,limit+1);
    const selected=rows.slice(0,limit);return {answers:selected.map(row=>this.public(JSON.parse(String(row.body)) as InteractionAnswerRecord)),nextCursor:selected.length?Number(selected.at(-1)!.rowid):after,hasMore:rows.length>limit};
  }
  public(record:InteractionAnswerRecord):InteractionAnswerReceipt{const {answer,answerHash,recoveryHash,nativeMessageId,...receipt}=record;return receipt;}
  save(interaction:InteractionRecord,answer:InteractionAnswer,recoveryHash:string,nativeMessageId?:string){return this.transaction(()=>{
    const previous=this.get(interaction.id),answerHash=interactionAnswerHash(answer);
    if(previous){if(previous.runId!==interaction.runId||previous.contextId!==interaction.contextId||previous.toolCallId!==interaction.toolCallId||previous.answerHash!==answerHash)throw new AppError('interaction_already_answered',409);return previous;}
    if(interaction.status!=='pending')throw new AppError('interaction_not_active',409);
    const address=[interaction.contextId,interaction.runId,interaction.toolCallId],base='answer.'+createHash('sha256').update(JSON.stringify(address)).digest('hex'),id=this.get(base)?'answer.'+createHash('sha256').update(JSON.stringify([...address,interaction.id])).digest('hex'):base;
    const now=new Date().toISOString();return this.write({id,interactionId:interaction.id,contextId:interaction.contextId,runId:interaction.runId,toolCallId:interaction.toolCallId,status:'pending',savedAt:now,updatedAt:now,attempts:0,answer,answerHash,recoveryHash,...(nativeMessageId?{nativeMessageId}:{})});
  });}
  bindNativeMessage(id:string,messageId:string){return this.transaction(()=>{const row=this.get(id);if(!row)throw new AppError('interaction_answer_not_found',404);if(row.nativeMessageId&&row.nativeMessageId!==messageId)throw new AppError('interaction_answer_source_changed',409);if(terminal.has(row.status))return row;return this.write({...row,nativeMessageId:messageId});});}
  update(id:string,patch:Partial<Pick<InteractionAnswerRecord,'status'|'attempts'|'deliveredAt'|'acknowledgementSeq'|'errorCode'|'retryable'|'nextAttemptAt'|'cancelRequestedAt'>>){return this.transaction(()=>{
    const previous=this.get(id);if(!previous)throw new AppError('interaction_answer_not_found',404);
    if(terminal.has(previous.status))return previous;
    return this.write({...previous,...patch,updatedAt:new Date().toISOString()});
  });}
  claim(id:string){return this.transaction(()=>{const previous=this.get(id);if(!previous)throw new AppError('interaction_answer_not_found',404);if(!['pending','blocked','unknown'].includes(previous.status)||previous.cancelRequestedAt)return undefined;return this.write({...previous,status:'delivering',attempts:previous.attempts+1,updatedAt:new Date().toISOString(),errorCode:undefined,retryable:undefined,nextAttemptAt:undefined});});}
  delivered(id:string,acknowledgementSeq:number){return this.update(id,{status:'delivered',acknowledgementSeq,deliveredAt:new Date().toISOString(),errorCode:undefined,retryable:undefined,nextAttemptAt:undefined});}
  cancel(id:string){const row=this.get(id);if(!row||terminal.has(row.status))return row;return this.update(id,{status:row.status==='delivering'||row.status==='unknown'?'unknown':'cancelled',cancelRequestedAt:new Date().toISOString(),errorCode:row.status==='delivering'||row.status==='unknown'?'interaction_answer_delivery_unknown':undefined,retryable:false,nextAttemptAt:undefined});}
  recover(){for(const row of this.list())if(row.status==='delivering')this.update(row.id,{status:'unknown',errorCode:'interaction_answer_delivery_unknown',retryable:false});}
}
