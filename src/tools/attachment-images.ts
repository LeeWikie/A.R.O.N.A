import type {AssetInfo} from '../assets.js';
import {processInputImage,type InputImagePolicy} from '../input-images.js';

export interface AttachmentImageView {
 source:Pick<AssetInfo,'id'|'name'|'mediaType'|'bytes'|'sha256'|'purpose'|'originalAssetIds'>;
 authority:'external-attachment-data';representation:'image';complete:true;
 mediaType:string;content:string;byteLength:number;hints:string[];imageOmitted:boolean;
}
export function isAttachmentImageView(value:unknown):value is AttachmentImageView{
 if(!value||typeof value!=='object'||!('representation'in value)||value.representation!=='image'||!('authority'in value)||value.authority!=='external-attachment-data'||!('source'in value)||!value.source||typeof value.source!=='object')return false;
 return 'id'in value.source&&typeof value.source.id==='string'&&'mediaType'in value&&typeof value.mediaType==='string'&&value.mediaType.startsWith('image/')&&'content'in value&&typeof value.content==='string'&&'imageOmitted'in value&&typeof value.imageOmitted==='boolean'&&'hints'in value&&Array.isArray(value.hints)&&value.hints.every(hint=>typeof hint==='string');
}
/** The saved asset stays original; only the model-facing image is normalized. */
export async function normalizeAttachmentImage(view:AttachmentImageView,policy:InputImagePolicy={},signal?:AbortSignal):Promise<AttachmentImageView>{
 const result=await processInputImage(Buffer.from(view.content,'base64'),view.mediaType,policy,signal);
 return result.ok?{...view,content:result.data,mediaType:result.mimeType,byteLength:Buffer.byteLength(result.data,'base64'),hints:result.hints,imageOmitted:false}:{...view,content:'',byteLength:0,hints:[result.message],imageOmitted:true};
}
export function attachmentResultToModelOutput(output:unknown){
 if(!isAttachmentImageView(output))return undefined;
 const value:Array<{type:'text';text:string}|{type:'media';data:string;mediaType:string}>=[{type:'text',text:`User-provided attachment image, retained as external source data: ${JSON.stringify(output.source)}`}];
 if(!output.imageOmitted)value.push({type:'media',data:output.content,mediaType:output.mediaType});
 for(const text of output.hints)value.push({type:'text',text});return{type:'content'as const,value};
}
