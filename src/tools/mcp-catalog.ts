/*
 * Adapted from Pi 1.5.1 packages/coding-agent/src/extensions/mcp/resources.ts
 * https://github.com/earendil-works/pi/blob/dd30101cfc5b0609411dd80b6f93adbc14db14cf/packages/coding-agent/src/extensions/mcp/resources.ts
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

/** Interface resources require an MCP App renderer and cannot be used as model source data. */
function isMcpAppResource(item:{uri?:string;uriTemplate?:string;mimeType?:string}):boolean{
 const uri=item.uri??item.uriTemplate??'';return uri.startsWith('ui://')||/;\s*profile\s*=\s*"?mcp-app"?/i.test(item.mimeType??'');
}
/** Public catalog descriptions retain business fields and the real hosting server. */
export function listMcpCatalogItems<T extends{_meta?:unknown;uri?:string;uriTemplate?:string;mimeType?:string}>(server:string,items:readonly T[]){
 return items.filter(item=>!isMcpAppResource(item)).map(item=>{const{_meta,icons:_,...rest}=item as T&{icons?:unknown};return{...rest,server};});
}

export const mcpCatalogToolNames=new Set(['list_mcp_resources','list_mcp_resource_templates','list_mcp_prompts']);
export interface McpCatalogScope{workspaceId:string;toolName:string;capabilityKey:string;members:ReadonlyArray<{serverId:string;connectionKey:string}>}
