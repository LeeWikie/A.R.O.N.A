import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {AppError} from '../domain.js';

export interface ProcessReadOptions {stream?:'stdout'|'stderr';offset?:number;limit?:number;byteOffset?:number;maxBytes?:number;encoding?:'text'|'base64'}
/** Verify the original snapshot while retaining only the requested page. */
export function readProcessOutput(fd:number,bytes:number,expected:string|undefined,options:ProcessReadOptions={},allowIncompleteUtf8=false){
  const binary=options.encoding==='base64',offset=options.offset??1,limit=options.limit??200,start=options.byteOffset??0,maximum=options.maxBytes??32768;
  if(!Number.isSafeInteger(offset)||offset<1||!Number.isSafeInteger(limit)||limit<1||limit>2000||!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(maximum)||maximum<1||maximum>1048576)throw new AppError('invalid_process_output_page');
  if(binary&&start>bytes)throw new AppError('process_output_offset');
  const end=Math.min(bytes,start+maximum),page=binary?Buffer.alloc(end-start):undefined,hash=expected?createHash('sha256'):undefined,decoder=binary?undefined:new TextDecoder('utf8',{fatal:true,ignoreBOM:true});
  const buffer=Buffer.alloc(65536),selected:Buffer[]=[];let position=0,line=1,lineBytes=0,selectedBytes=0,count=0,lastByte:number|undefined,full=false,tooWide=false,lineParts:Buffer[]=[];
  const decode=(decoder:TextDecoder,bytes?:Uint8Array,stream=false)=>{try{return decoder.decode(bytes,{stream});}catch(error){if(error instanceof TypeError)throw new AppError('process_output_not_utf8',415);throw error;}};
  const finishLine=()=>{
    if(!full&&line>=offset&&line<offset+limit){if(selectedBytes+lineBytes>32768){full=true;tooWide=count===0;}else{selected.push(...lineParts);selectedBytes+=lineBytes;count++;}}
    line++;lineBytes=0;lineParts=[];
  };
  while(position<bytes){
    const size=fs.readSync(fd,buffer,0,Math.min(buffer.length,bytes-position),position);if(!size)throw new AppError('process_output_changed',409);
    const chunk=buffer.subarray(0,size);hash?.update(chunk);
    if(binary){const first=Math.max(start,position),last=Math.min(end,position+size);if(first<last)chunk.copy(page!,first-start,first-position,last-position);}
    else{
      decode(decoder!,chunk,true);let begin=0;
      for(;;){const newline=chunk.indexOf(10,begin),through=newline<0?size:newline+1,length=through-begin;
        if(!full&&line>=offset&&line<offset+limit){lineBytes+=length;if(selectedBytes+lineBytes<=32768)lineParts.push(Buffer.from(chunk.subarray(begin,through)));else lineParts=[];}
        if(newline<0)break;finishLine();begin=through;if(begin===size)break;
      }
    }
    lastByte=chunk[size-1];position+=size;
  }
  if(decoder&&!allowIncompleteUtf8)decode(decoder);if(hash&&hash.digest('hex')!==expected)throw new AppError('process_output_changed',409);
  if(binary)return {content:page!.toString('base64'),encoding:'base64' as const,byteOffset:start,nextByteOffset:end<bytes?end:null,totalBytes:bytes};
  if(bytes&&lastByte!==10)finishLine();const totalLines=line-1;if(offset>totalLines+1)throw new AppError('process_output_offset');
  return {content:decode(new TextDecoder('utf8',{fatal:true,ignoreBOM:true}),Buffer.concat(selected,selectedBytes),allowIncompleteUtf8),encoding:'text' as const,offset,nextOffset:offset-1+count<totalLines?offset+count:null,totalLines,totalBytes:bytes,...(tooWide?{requiresByteRead:true}:{})};
}
