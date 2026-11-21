import {isMcpResultToolName} from './tools/mcp-protocol-witness.js';
import type { Core } from './core.js';
import { createHash } from 'node:crypto';
import { safeTerminalText } from './terminal-format.js';
import { redactPublicArgs } from './tool-activity.js';
import type { RuntimeEvent } from './runtime-store.js';

export interface PublicToolText {
  text: string;
  characters: number;
  lines: number;
  truncated?: boolean;
}

const textTools = new Set([
  'mastra_workspace_execute_command', 'mastra_workspace_get_process_output',
  'mastra_workspace_read_file', 'mastra_workspace_list_files', 'mastra_workspace_grep',
  'mastra_workspace_file_stat', 'mastra_workspace_mkdir', 'mastra_workspace_write_file',
  'mastra_workspace_edit_file', 'mastra_workspace_apply_patch', 'mastra_workspace_delete', 'mastra_workspace_delete_file',
  'mastra_workspace_kill_process', 'web_fetch', 'web_search',
  'terminal_process', 'read_terminal_result','read_web_result','read_mcp_result',
]);
const MAX_TEXT = 128 * 1024;
interface StreamState {
  secrets: Set<string>;
  blocked: boolean;
  stdout: string;
  stderr: string;
  characters: number;
  lines: number;
  truncated: boolean;
  completed: boolean;
  lastSource: number;
  lastOutputHash?: string;
}
const streams = new WeakMap<Core, Map<string, StreamState>>();

/** Raw stream tails and historical credential values live only for this core process. */
export function toolOutputState(core: Core, event: RuntimeEvent, name: string) {
  const row = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
  const nativeMessageId=typeof core.toolMessageId==='function'&&typeof row.toolCallId==='string'?core.toolMessageId(event.contextId,event.runId,row.toolCallId,event.seq+1):undefined;
  const key = JSON.stringify([event.contextId, event.runId, row.toolCallId,...(nativeMessageId?[nativeMessageId]:[])]);
  let stateMap = streams.get(core);
  if (!stateMap) { stateMap = new Map(); streams.set(core, stateMap); }
  let state = stateMap.get(key);
  if (!state && event.kind === 'tool_start') {
    if (stateMap.size >= 1024) {
      for (const [oldKey, old] of stateMap) if (old.completed) { stateMap.delete(oldKey); if (stateMap.size < 1024) break; }
    }
    if (stateMap.size < 1024) {
      state = { secrets: new Set(), blocked: false, stdout: '', stderr: '', characters: 0, lines: 0, truncated: false, completed: false, lastSource: 0 };
      stateMap.set(key, state);
    }
  }
  if (!state) return undefined;
  try { for (const secret of core.redactionValues(1)) state.secrets.add(secret); }
  catch { state.blocked = true; }
  if (state.blocked) return undefined;
  if (event.seq > state.lastSource && event.kind === 'shell_output' && typeof row.output === 'string' && (row.stream === 'stdout' || row.stream === 'stderr') && !state.completed) {
    const available = Math.max(0, MAX_TEXT - state.stdout.length - state.stderr.length);
    state[row.stream] += row.output.slice(0, available);
    state.characters += row.output.length;
    state.lines += row.output.split('\n').length - 1;
    if (row.output.length > available) state.truncated = true;
  }
  state.lastSource = Math.max(state.lastSource, event.seq);
  const final = event.kind === 'command_exit' || event.kind === 'tool_end';
  if (final) state.completed = true;
  const complete = (text: string) => {
    if (final && !state.truncated) return text;
    let cutoff = text.lastIndexOf('\n') + 1;
    for (const secret of state.secrets) {
      if (!secret) continue;
      for (let size = 1; size < secret.length && size <= cutoff; size++) {
        if (text.slice(0, cutoff).endsWith(secret.slice(0, size))) cutoff -= size;
      }
      let start = text.indexOf(secret);
      while (start >= 0) {
        if (start < cutoff && start + secret.length > cutoff) cutoff = start;
        start = text.indexOf(secret, start + 1);
      }
    }
    return text.slice(0, cutoff);
  };
  const stdout = complete(safeTerminalText(state.stdout)), stderr = complete(safeTerminalText(state.stderr));
  const text = stdout && stderr ? `stdout:\n${stdout}\nstderr:\n${stderr}` : stdout || stderr;
  const partial=event.kind==='tool_update'&&row.partialResult&&typeof row.partialResult==='object'&&!Array.isArray(row.partialResult)?row.partialResult as Record<string,unknown>:undefined;
  const progress=!state.completed&&name.startsWith('ext_')&&partial?.kind==='mcp-progress'&&partial.version===1&&typeof partial.progress==='number'&&Number.isFinite(partial.progress)?partial:undefined;
  const progressText=progress?[`进度 ${progress.progress}${typeof progress.total==='number'&&Number.isFinite(progress.total)?` / ${progress.total}`:''}`,typeof progress.message==='string'?progress.message:undefined].filter(value=>typeof value==='string').join(' · '):undefined;
  const body = progressText!==undefined?boundedText(core,progressText,[...state.secrets]):textTools.has(name) && (text || state.truncated) ? boundedText(core, text, [...state.secrets]) : undefined;
  if (body) {
    const hash = createHash('sha256').update(body.text).update(state.truncated ? 'truncated' : 'complete').digest('hex');
    if (!final && hash === state.lastOutputHash) return { secrets: [...state.secrets] };
    state.lastOutputHash = hash;
  }
  return { secrets: [...state.secrets], ...(body ? { output: { ...body, ...(state.truncated ? { truncated: true, characters: state.characters, lines: state.lines + 1 } : {}) } } : {}) };
}

function boundedText(core: Core, value: string, secrets?: readonly string[]): PublicToolText {
  if (!secrets) { try { secrets = core.redactionValues(1); } catch { return { text: '[unavailable]', characters: 13, lines: 1 }; } }
  let clean = safeTerminalText(value);
  for (const secret of secrets) if (secret.length > 0 && secret.length < 4) clean = clean.split(secret).join('[hidden]');
  const redacted = String(redactPublicArgs(core, clean, '', secrets))
    .replace(/((?:^|\n)\s*(?:set-cookie|cookie|authorization|proxy-authorization)\s*:\s*)[^\n]*/gi, '$1[hidden]')
    .replace(/((?:["']?(?:password|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|authorization|cookie)["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;\n]+)/gi, '$1[hidden]');
  const characters = redacted.length;
  const lines = redacted.split('\n').length;
  if (characters <= MAX_TEXT) return { text: redacted, characters, lines };
  let text = redacted.slice(0, MAX_TEXT);
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  return { text, characters, lines, truncated: true };
}

function webProviderText(value:unknown,includeError=false){
  if(!value||typeof value!=='object'||Array.isArray(value))return '';
  const row=value as Record<string,unknown>,names:Record<string,string>={tavily:'Tavily',perplexity:'Perplexity',exa:'Exa',parallel:'Parallel',keenable:'Keenable',firecrawl:'Firecrawl',searxng:'SearXNG',brave:'Brave'},name=typeof row.name==='string'?names[row.name]:undefined;
  if(!name)return '';const origin=typeof row.rescuedFrom==='string'?names[row.rescuedFrom]:undefined;
  return [`来源服务：${name}${row.mode==='keyless'?' · 免密钥':row.mode==='keyed'?' · 凭据模式':''}`,row.coverage==='excerpt'?'供应商仅返回摘要，原网页全文不可用':undefined,origin?`本次接续了 ${origin} 的失败请求，后续仍优先使用 ${origin}`:undefined,typeof row.backendError==='string'?row.backendError:undefined,includeError&&typeof row.error==='string'?row.error:undefined].filter(Boolean).join('\n');
}
function attachmentImageResult(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)&&'representation'in value&&value.representation==='image'&&'authority'in value&&value.authority==='external-attachment-data'&&'source'in value&&value.source!==null&&typeof value.source==='object'&&!Array.isArray(value.source)&&'mediaType'in value&&typeof value.mediaType==='string'&&value.mediaType.startsWith('image/');}

function resultText(tool: string, value: unknown): string | undefined {
  if (typeof value === 'string') return tool === 'web_fetch' || tool === 'web_search' ? undefined : value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if(tool==='read_attachment'&&attachmentImageResult(value)){const source=value.source as Record<string,unknown>;return[source.name,value.mediaType,value.imageOmitted===true?'当前模型无法查看图像':`图像 · ${typeof value.byteLength==='number'&&Number.isFinite(value.byteLength)&&value.byteLength>=0?value.byteLength:0} 字节`,...(Array.isArray(value.hints)?value.hints.filter((hint):hint is string=>typeof hint==='string'):[])].filter((part):part is string=>typeof part==='string'&&part.length>0).join('\n');}
  if(isMcpResultToolName(tool)&&row.kind==='mcp-model-result'&&row.version===1&&Array.isArray(row.content)){
    const states:Record<string,string>={returned:'服务已返回','tool-error':'服务返回错误','output-invalid':'来源结果未通过验证'},parts=row.content.flatMap(part=>part&&typeof part==='object'&&part.type==='text'&&typeof part.text==='string'?[part.text]:[]),references=Array.isArray(row.references)?row.references.filter((ref):ref is Record<string,unknown>=>Boolean(ref)&&typeof ref==='object'&&!Array.isArray(ref)):[],names:Record<string,string>={'mcp-model-image':'图像','mcp-model-audio':'音频','mcp-model-resource':'二进制资源','mcp-model-structured':'结构化数据'};
    const retained=references.flatMap(ref=>typeof ref.representation==='string'&&names[ref.representation]?[`${names[ref.representation]} · ${typeof ref.mediaType==='string'?ref.mediaType:'未知格式'}${typeof ref.bytes==='number'?` · ${ref.bytes} 字节`:''}${typeof ref.id==='string'?` · ${ref.id}`:''}`]:[]);
    const inlineImages=row.content.filter(part=>part&&typeof part==='object'&&part.type==='image');if(!references.some(ref=>ref.representation==='mcp-model-image'))for(const image of inlineImages)retained.push(`图像 · ${typeof image.mimeType==='string'?image.mimeType:'未知格式'}`);
    return[row.fromCache===true?'来源缓存 · 本次未获取新的资源响应':typeof row.status==='string'?states[row.status]:undefined,...parts,...retained].filter((part):part is string=>typeof part==='string'&&part.length>0).join('\n');
  }
  if(tool==='read_mcp_result'&&row.source&&typeof row.source==='object'&&!Array.isArray(row.source)){
    const source=row.source as Record<string,unknown>,original=source.original&&typeof source.original==='object'&&!Array.isArray(source.original)?source.original as Record<string,unknown>:undefined,origin=original?.mcp&&typeof original.mcp==='object'&&!Array.isArray(original.mcp)?original.mcp as Record<string,unknown>:source,state=origin.validated===false?'来源结果未通过验证':origin.isError===true?'服务原结果报告错误':origin.fromCache===true?'来源缓存 · 原读取未获取新的资源响应':undefined;
    if(row.representation==='image')return[state,source.name,source.mediaType,row.imageOmitted===true?'当前模型无法查看图像':`图像 · ${typeof row.byteLength==='number'?row.byteLength:0} 字节`,...(Array.isArray(row.hints)?row.hints.filter((value):value is string=>typeof value==='string'):[])].filter((part):part is string=>typeof part==='string'&&part.length>0).join('\n');
    return[state,source.name,source.mediaType,row.representation==='base64'||row.encoding==='base64'?`原始字节页 · ${typeof row.byteLength==='number'?row.byteLength:0} 字节`:typeof row.content==='string'?row.content:undefined,typeof row.nextOffset==='number'?`后续内容从第 ${row.nextOffset} 行继续`:row.requiresByteRead===true?'该行超过文本页容量，可按字节读取':typeof row.nextByteOffset==='number'?`后续内容从字节 ${row.nextByteOffset} 继续`:undefined].filter((part):part is string=>typeof part==='string'&&part.length>0).join('\n');
  }
  if(tool==='web_fetch'&&Array.isArray(row.results))return row.results.map(result=>resultText(tool,result)).filter((text):text is string=>typeof text==='string').join('\n\n');
  if(tool==='web_fetch'&&row.isError===true&&typeof row.content!=='string')return [row.url,row.error].filter(value=>typeof value==='string').join('\n');
  if(tool==='mastra_workspace_edit_file'&&Array.isArray(row.content))return row.content.flatMap(part=>part&&typeof part==='object'&&'type'in part&&part.type==='text'&&'text'in part&&typeof part.text==='string'?[part.text]:[]).join('\n');
  if(tool==='terminal_process'||tool==='read_terminal_result'){
    const states:Record<string,string>={starting:'正在启动',running:'运行中',completed:'已退出',failed:'退出失败',cancelled:'已取消',timed_out:'已超时',interrupted:'已中断',unknown:'状态未确认','input-delivered':'输入已送达',resized:'已调整窗口'};
    const describe=(item:Record<string,unknown>)=>[typeof item.id==='string'?item.id:'',typeof item.status==='string'?states[item.status]??item.status:'',typeof item.exitCode==='number'?`退出码 ${item.exitCode}`:''].filter(Boolean).join(' · ');
    if(Array.isArray(row.processes))return row.processes.filter((item):item is Record<string,unknown>=>Boolean(item)&&typeof item==='object'&&!Array.isArray(item)).map(item=>[describe(item),typeof item.command==='string'?item.command:''].filter(Boolean).join('\n')).join('\n\n')||'没有进程记录。';
    const header=describe(row);if(!header)return undefined;
    if(row.encoding==='base64')return `${header}\n二进制输出 · ${typeof row.totalBytes==='number'?row.totalBytes:0} 字节`;
    return [header,typeof row.content==='string'?row.content:'',typeof row.nextOffset==='number'?`后续输出从第 ${row.nextOffset} 行继续`:row.requiresByteRead===true?'该行超过文本页容量，可按字节读取':''].filter(Boolean).join('\n');
  }
  if((tool==='web_fetch'||tool==='web_search')&&typeof row.content!=='string'&&row.isError===true){
    const provider=typeof row.provider==='string'?{name:row.provider,mode:row.mode,rescuedFrom:row.rescuedFrom,backendError:row.backendError}:row.provider;
    return [row.url,webProviderText(provider),row.status==='not configured'?'网页搜索未启用':undefined,row.error,row.reason].filter(item=>typeof item==='string'&&item.length>0).join('\n');
  }
  if ((tool === 'web_fetch' || tool === 'web_search') && typeof row.content === 'string') {
    let content=row.content;
    if(typeof row.security==='string'&&content.startsWith(row.security+'\n')){
      const framed=content.slice(row.security.length+1),opening=/^<external-content id="([0-9a-f-]{36})">\n/.exec(framed),closing=opening?`\n</external-content id="${opening[1]}">`:undefined;
      if(opening&&closing&&framed.endsWith(closing))content=framed.slice(opening[0].length,-closing.length);
    }
    const retained=row.resultRef&&typeof row.resultRef==='object'&&!Array.isArray(row.resultRef)?row.resultRef as Record<string,unknown>:undefined;
    const provider=typeof row.provider==='string'?{name:row.provider,mode:row.mode,rescuedFrom:row.rescuedFrom,backendError:row.backendError}:row.provider;
    return [row.title,row.url,typeof row.status==='number'?`HTTP ${row.status}`:undefined,webProviderText(provider),row.error,content,retained?.isTruncated===true?'来源内容不完整':row.textTruncated===true&&retained?'其余正文已保留，可继续读取':undefined].filter(item=>typeof item==='string'&&item.length>0).join('\n');
  }
  if(tool==='read_web_result'&&row.source&&typeof row.source==='object'&&!Array.isArray(row.source)){
    const source=row.source as Record<string,unknown>;
    return [source.title,source.url,typeof source.status==='number'?`HTTP ${source.status}`:undefined,webProviderText(source.provider,true),row.representation==='base64'?`原文字节页 · ${typeof row.byteLength==='number'?row.byteLength:0} 字节`:typeof row.content==='string'?row.content:undefined,source.isTruncated===true?'来源内容不完整':undefined].filter(item=>typeof item==='string'&&item.length>0).join('\n');
  }
  // Workspace media includes a textual header alongside binary data.
  if (row.__workspaceMedia === true && typeof row.text === 'string') return row.text;
  const fields = ['stdout', 'stderr'].flatMap(key => typeof row[key] === 'string' ? [`${key}:\n${row[key]}`] : []);
  if (fields.length) return fields.join('\n');
  return undefined;
}

function editDiff(tool: string, args: unknown, result: unknown): string | undefined {
  if(tool==='mastra_workspace_edit_file'&&result&&typeof result==='object'&&!Array.isArray(result)&&'details'in result&&result.details&&typeof result.details==='object'&&'patch'in result.details&&typeof result.details.patch==='string')return result.details.patch;
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof result !== 'string') return undefined;
  const row = args as Record<string, unknown>;
  if (tool === 'mastra_workspace_apply_patch' && result.startsWith('Applied patch:') && typeof row.patch === 'string') return row.patch;
  if (tool !== 'mastra_workspace_edit_file' || !result.startsWith('Replaced ') || typeof row.old_string !== 'string' || typeof row.new_string !== 'string') return undefined;
  const oldLines = row.old_string.split('\n'), newLines = row.new_string.split('\n');
  let prefix = 0, suffix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;
  const name = typeof row.path === 'string' ? row.path : 'file';
  const lines = [`--- ${name}`, `+++ ${name}`, '@@ replacement @@'];
  lines.push(...oldLines.slice(Math.max(0, prefix - 3), prefix).map(line => ` ${line}`));
  lines.push(...oldLines.slice(prefix, oldLines.length - suffix).map(line => `-${line}`));
  lines.push(...newLines.slice(prefix, newLines.length - suffix).map(line => `+${line}`));
  lines.push(...oldLines.slice(oldLines.length - suffix, oldLines.length - suffix + 3).map(line => ` ${line}`));
  return lines.join('\n');
}

/** Project text only for tools whose results have an explicit public representation. */
export function publicToolOutput(core: Core, tool: string, args: unknown, result: unknown, secrets?: readonly string[], completed = false) {
  if (!textTools.has(tool)&&!(tool==='read_attachment'&&attachmentImageResult(result))&&!(isMcpResultToolName(tool)&&result&&typeof result==='object'&&!Array.isArray(result)&&'kind'in result&&result.kind==='mcp-model-result'&&'version'in result&&result.version===1)) return {};
  let output = resultText(tool, result);
  const row = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
  if (completed && tool === 'mastra_workspace_write_file' && typeof output === 'string' && /^Wrote \d+ bytes to /.test(output) && typeof row.content === 'string') output += `\n\n${row.content}`;
  const diff = completed ? editDiff(tool, args, result) : undefined;
  return {
    ...(output !== undefined ? { output: boundedText(core, output, secrets) } : {}),
    ...(diff !== undefined ? { diff: boundedText(core, diff, secrets) } : {}),
  };
}
