import {Core} from '../src/core.js';
import {Models} from '../src/models.js';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {BackgroundTaskManager} from '@mastra/core/background-tasks';
import {createApp} from '../src/http.js';
import {createHash} from 'node:crypto';

const [directory,variant]=process.argv.slice(2);if(!directory||!variant||!process.send)throw Error('fixture_arguments');
const nativeImagePolicy=Models.prototype.imageReadOptions;
Models.prototype.imageReadOptions=function(id){const profile=this.profile(id);if(profile&&'providerId'in profile){const descriptor=this.providers?.getModel(profile.providerId,profile.modelId);if(descriptor){descriptor.input=variant==='text'?['text']:['text','image'];descriptor.inputLimits={images:{resize:{maxWidth:variant.startsWith('two')?2:8,maxHeight:variant.startsWith('two')?1:4}}};}}return nativeImagePolicy.call(this,id);};
let cancelUnavailable=variant==='two-cancel-unavailable';const nativeCancel=BackgroundTaskManager.prototype.cancel;BackgroundTaskManager.prototype.cancel=async function(id){if(cancelUnavailable)throw Error('SYNTHETIC_NATIVE_CANCEL_UNAVAILABLE');return nativeCancel.call(this,id);};
let core:Core,workerCalls=0,mainCalls=0;
const model=new MastraLanguageModelV2Mock({doStream:async request=>{const work=request.tools?.some(tool=>tool.name==='task_report');if(work)workerCalls++;else mainCalls++;const results=request.prompt.flatMap(message=>message.role==='tool'?message.content:[]),asked=results.some(part=>part.type==='tool-result'&&part.toolName==='ask_user'),reported=results.some(part=>part.type==='tool-result'&&part.toolName==='task_report');return {stream:new ReadableStream({start(controller){controller.enqueue({type:'stream-start',warnings:[]});if(work&&!asked)controller.enqueue({type:'tool-call',toolCallId:'image-policy-question',toolName:'ask_user',input:JSON.stringify({question:'SYNTHETIC_IMAGE_POLICY_QUESTION'})});else if(work&&!reported){const task=core.runtime.tasks().find(task=>task.status==='running')!;controller.enqueue({type:'tool-call',toolCallId:'image-policy-report',toolName:'task_report',input:JSON.stringify({id:task.id,report:{outcome:'succeeded',summary:'Synthetic decision completed',checks:[{description:'Actual answer received',passed:true}],deliveries:[],unresolved:[]}})});}controller.enqueue({type:'finish',finishReason:work&&!reported?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});controller.close();}})};}});
core=await Core.open({dataDir:directory,model,memoryEnabled:false});if(!core.models.profile('default')){core.models.save({id:'default',name:'Synthetic image policy',providerId:'openai',modelId:'gpt-6-luna',defaultThinkingLevel:'max'});await core.switchModel('main','default','max');}
process.send({type:'ready'});
process.on('message',message=>{if(!message||typeof message!=='object'||!('type'in message))return;void(async()=>{
 if(message.type==='submit')await core.submitTask({title:'Synthetic image policy gate',content:'Ask for a synthetic decision.'},'image-policy-original');
 if(message.type==='answer'){const question=core.interactions().find(row=>row.status==='pending')!;await core.answerInteraction(question.id,question.runId,'Synthetic answer');}
 if(message.type==='retry-cleanup'){cancelUnavailable=false;const question=core.interactions()[0]!,response=await createApp(core).request(`/runs/${question.runId}/recovery-cleanup`,{method:'POST',headers:{authorization:`Bearer ${core.controlToken}`}});if(response.status!==200)throw Error('cleanup_http_'+response.status);}
 if(message.type==='network-restored')cancelUnavailable=false;
 if(message.type==='close'){await core.close();process.send?.({type:'closed'});process.disconnect?.();return;}
 const task=core.runtime.tasks().find(row=>row.title==='Synthetic image policy gate'),question=core.interactions()[0],native=task?.nativeTaskId?await core.sessions.controller.getMastra()!.backgroundTaskManager!.getTask(task.nativeTaskId):undefined;
 const publicTask=task?await(await createApp(core).request(`/tasks/${task.id}`,{headers:{authorization:`Bearer ${core.controlToken}`}})).json() as {resourceCleanup?:unknown}:undefined;
 const snapshot=question?core.runtime.getSnapshot(question.runId)?.body as {data?:string}|undefined:undefined,event=question?core.store.db.prepare('SELECT data FROM runtime_events WHERE event_key=?').get(`snapshot:${question.runId}`):undefined,proof=event?JSON.parse(String(event.data)) as {sha256:string;sequence:number}:undefined;
 const snapshotEvidence=snapshot?.data&&question?{dataHash:createHash('sha256').update(snapshot.data).digest('hex'),eventHash:proof?.sha256,sequence:core.projectMemory.snapshot(question.runId).sequence,eventSequence:proof?.sequence}:undefined;
 process.send?.({type:'state',workerCalls,mainCalls,task,question,nativeStatus:native?.status,cleanup:question?core.recoveryCleanup(question.runId):undefined,publicResourceCleanup:publicTask?.resourceCleanup,snapshotEvidence,seal:question?core.runtime.setting(`run-recovery:${question.runId}`,null):null,events:core.runtime.events(undefined,0,1000).filter(row=>row.kind==='run_recovery_unavailable')});
})().catch(error=>process.send?.({type:'fixture-error',error:String(error)}));});
