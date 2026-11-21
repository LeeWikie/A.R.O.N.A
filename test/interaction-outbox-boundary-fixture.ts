import {InteractionAnswerOutbox} from '../src/interaction-outbox.js';

const point=process.env.SYNTHETIC_ANSWER_BOUNDARY;
const park=(id:string)=>{process.send?.({type:'answer-boundary',point,id});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
if(point==='claim'){
  const claim=InteractionAnswerOutbox.prototype.claim;
  InteractionAnswerOutbox.prototype.claim=function(id){const result=claim.call(this,id);if(result)park(result.id);return result;};
}
if(point==='ack'){
  const delivered=InteractionAnswerOutbox.prototype.delivered;
  InteractionAnswerOutbox.prototype.delivered=function(id,sequence){park(id);return delivered.call(this,id,sequence);};
}
await import('./control-recovery-fixture.js');
