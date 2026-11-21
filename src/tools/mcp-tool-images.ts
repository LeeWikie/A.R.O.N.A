/*
 * Adapted from Pi 1.5.1 packages/coding-agent/src/utils/tool-result-images.ts:
 * https://github.com/earendil-works/pi/blob/dd30101cfc5b0609411dd80b6f93adbc14db14cf/packages/coding-agent/src/utils/tool-result-images.ts
 *
 * MIT License
 * 
 * Copyright (c) 2025 Mario Zechner
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import {processInputImage,type InputImagePolicy} from '../input-images.js';
import type {LlmContent} from './mcp-content.js';

/** Normalizes the model view while retained MCP originals remain immutable. */
export async function normalizeMcpToolImages(content:LlmContent[],policy:InputImagePolicy={},signal?:AbortSignal):Promise<LlmContent[]>{
 signal?.throwIfAborted();if(!content.some(block=>block.type==='image'))return content;
 const normalized:LlmContent[]=[];let changed=false;
 for(const block of content){
  signal?.throwIfAborted();if(block.type!=='image'){normalized.push(block);continue;}
  const processed=await processInputImage(Buffer.from(block.data,'base64'),block.mimeType,{autoResizeImages:policy.autoResizeImages??true,resizeOptions:policy.resizeOptions,supportsImages:policy.supportsImages},signal);
  if(!processed.ok){
   if(policy.supportsImages===false){normalized.push({type:'text',text:processed.message});changed=true;}
   else normalized.push(block);
   continue;
  }
  if(processed.data===block.data&&processed.mimeType===block.mimeType&&processed.hints.length===0){normalized.push(block);continue;}
  normalized.push({type:'image',data:processed.data,mimeType:processed.mimeType});
  if(processed.hints.length>0)normalized.push({type:'text',text:processed.hints.join('\n')});changed=true;
 }
 signal?.throwIfAborted();return changed?normalized:content;
}
