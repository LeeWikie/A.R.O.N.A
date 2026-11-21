import assert from 'node:assert/strict';

const object=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
function sourcePage(value:unknown):Record<string,unknown>|undefined{
  if(typeof value==='string'){try{return sourcePage(JSON.parse(value));}catch{return;}}
  if(!object(value))return;
  if(object(value.source)&&Array.isArray(value.parts)&&'next'in value)return value;
  if(value.type==='content'&&Array.isArray(value.value))for(const part of value.value){if(!object(part)||part.type!=='text')continue;const page=sourcePage(part.text);if(page)return page;}
}
export class MemorySourcePageModel {
  readonly requests:unknown[]=[];
  private readonly calls=new Map<string,number>();
  next(request:{prompt:unknown;tools?:readonly {name:string}[]}){
    this.requests.push(request.prompt);
    const serialized=JSON.stringify(request.prompt);
    if(!serialized.includes('business-evidence-directory'))return;
    assert.ok(request.tools?.some(tool=>tool.name==='memory_source_page'));
    let runId=/来源运行是 ([0-9a-f-]{36})/.exec(serialized)?.[1];
    if(!runId)for(const message of Array.isArray(request.prompt)?request.prompt:[]){
      if(!object(message)||message.role!=='user'||!Array.isArray(message.content))continue;
      for(const part of message.content){if(!object(part)||part.type!=='text'||typeof part.text!=='string')continue;try{const row:unknown=JSON.parse(part.text);if(object(row)&&row.type==='business-evidence-directory'&&object(row.source)&&typeof row.source.runId==='string')runId=row.source.runId;}catch{}}
    }
    assert.ok(runId);
    let latest:Record<string,unknown>|undefined;
    for(const message of Array.isArray(request.prompt)?request.prompt:[]){
      if(!object(message)||message.role!=='tool'||!Array.isArray(message.content))continue;
      for(const part of message.content){
        if(!object(part)||part.type!=='tool-result'||part.toolName!=='memory_source_page')continue;
        let value=part.output??part.result;
        for(let depth=0;depth<4;depth++){
          if(typeof value==='string'){try{value=JSON.parse(value);}catch{break;}}
          else if(object(value)&&(value.type==='json'||value.type==='text')&&'value'in value)value=value.value;
          else break;
        }
        const page=sourcePage(value);if(page&&object(page.source)&&page.source.runId===runId)latest=page;
      }
    }
    if(latest?.next===null)return;
    if(latest)assert.ok(object(latest.next)&&Number.isSafeInteger(latest.next.index)&&Number.isSafeInteger(latest.next.offset));
    const input=latest?latest.next as {index:number;offset:number}:{index:0,offset:0},ordinal=this.calls.get(runId)??0;this.calls.set(runId,ordinal+1);
    return {type:'tool-call' as const,toolName:'memory_source_page',toolCallId:`source-page-${runId}-${ordinal}`,input:JSON.stringify(input)};
  }
}
