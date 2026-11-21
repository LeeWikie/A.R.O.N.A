import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import type { Core } from '../src/core.js';
import { RuntimeStore, type RuntimeEvent } from '../src/runtime-store.js';
import { publicToolEvent, toolActivity } from '../src/tool-activity.js';
import { publicToolOutput } from '../src/tool-output.js';
import { ToolOutput } from '../src/tui/tool-output.js';
import { plainTheme } from '../src/tui/upstream/theme.js';

function fixture() {
  const db = new DatabaseSync(':memory:'); const runtime = new RuntimeStore(db);
  let secrets = ['synthetic-provider-key'];
  const core = { store: { db }, runtime, redactionValues: () => secrets } as unknown as Core;
  const emit = (kind: string, data: unknown, publish = true) => {
    runtime.event({ kind, data, contextId: 'main', runId: 'run' });
    const event: RuntimeEvent = { seq: runtime.eventHead(), kind, data, contextId: 'main', runId: 'run', taskId: null, createdAt: new Date().toISOString() };
    const projected = publicToolEvent(core, event);
    if (publish) runtime.event({ kind: 'public_tool', key: `tool.public:${event.seq}`, data: projected, contextId: 'main', runId: 'run' });
    return projected;
  };
  return { db, core, emit, removeSecrets: () => { secrets = []; } };
}

test('public workspace output is durably redacted before credentials disappear', () => {
  const { db, core, emit, removeSecrets } = fixture();
  try {
    emit('tool_start', { toolCallId: 'call', toolName: 'mastra_workspace_execute_command', args: { command: 'echo synthetic-\u001b[31mprovider-key' } });
    const result = emit('tool_end', { toolCallId: 'call', result: 'ordinary command output\nsynthetic-provider-key\nsynthetic-\u001b[31mprovider-key\napi_key="other-key"\nCookie: unknown_session=first-cookie; next_session=second-cookie\nhttps://example.invalid/?token=query-secret\n\u001b]52;c;clipboard\u0007clean\u001b[31m' });
    assert.match(result.output!.text, /ordinary command output/);
    assert.doesNotMatch(result.output!.text, /synthetic-provider-key|other-key|query-secret|first-cookie|second-cookie|clipboard|\u001b/);
    removeSecrets();
    emit('command_exit', { toolCallId: 'call', exitCode: 0, success: true });
    const activity = toolActivity(core, 'main');
    assert.match(JSON.stringify(activity), /ordinary command output/);
    assert.doesNotMatch(JSON.stringify(activity), /synthetic-provider-key|other-key|query-secret|clipboard/);
  } finally { db.close(); }
});

test('unknown, delivery and memory tools do not acquire a raw result display; legacy rows stay private', () => {
  const { db, core, emit } = fixture();
  try {
    for (const tool of ['custom_tool', 'emit_message', 'task_report', 'memory_read']) {
      assert.deepEqual(publicToolOutput(core, tool, {}, 'unpublished result'), {});
    }
    emit('tool_start', { toolCallId: 'call', toolName: 'mastra_workspace_read_file', args: { path: 'fixture.txt' } }, false);
    emit('tool_end', { toolCallId: 'call', result: 'unpublished legacy result' }, false);
    assert.doesNotMatch(JSON.stringify(toolActivity(core, 'main')), /unpublished legacy result/);
  } finally { db.close(); }
});

test('live stdout withholds incomplete secrets and keeps redaction after credential removal', async () => {
  const { db, core, emit, removeSecrets } = fixture();
  try {
    emit('tool_start', { toolCallId: 'call', toolName: 'mastra_workspace_execute_command', args: { command: 'echo synthetic-provider-key' } });
    const first = emit('shell_output', { toolCallId: 'call', stream: 'stdout', output: 'visible line\nsynthetic-pro' });
    assert.equal(first.output!.text, 'visible line\n');
    assert.doesNotMatch(JSON.stringify(first), /synthetic-pro/);
    const unframed = emit('tool_update', { toolCallId: 'call', partialResult: 'synthetic-pro' });
    assert.doesNotMatch(JSON.stringify(unframed), /synthetic-pro/);
    removeSecrets();
    const second = emit('shell_output', { toolCallId: 'call', stream: 'stdout', output: 'vider-key\nlast partial' });
    assert.equal(second.output!.text, 'visible line\n[hidden]\n');
    const exit = emit('command_exit', { toolCallId: 'call', exitCode: 0, success: true });
    assert.equal(exit.output!.text, 'visible line\n[hidden]\nlast partial');
    const final = emit('tool_end', { toolCallId: 'call', result: 'synthetic-provider-key\nfinal output' });
    assert.equal(final.output!.text, '[hidden]\nfinal output');
    const { publicEventPage } = await import('../src/event-stream.js');
    assert.doesNotMatch(JSON.stringify(publicEventPage(core, 0)), /synthetic-pro|vider-key/);
    assert.doesNotMatch(JSON.stringify(toolActivity(core, 'main')), /synthetic-pro|vider-key/);
    const restartedCore = { store: { db }, runtime: core.runtime, redactionValues: () => [] } as unknown as Core;
    assert.doesNotMatch(JSON.stringify(toolActivity(restartedCore, 'main')), /synthetic-pro|vider-key/);
    assert.doesNotMatch(JSON.stringify(publicEventPage(restartedCore, 0)), /synthetic-pro|vider-key/);
  } finally { db.close(); }
});

test('restart never reconstructs an in-flight private stdout tail with current credentials', () => {
  const { db, core, emit, removeSecrets } = fixture();
  try {
    emit('tool_start', { toolCallId: 'call', toolName: 'mastra_workspace_execute_command', args: { command: 'secret fixture' } });
    emit('shell_output', { toolCallId: 'call', stream: 'stdout', output: 'synthetic-pro' });
    removeSecrets();
    const restartedCore = { store: { db }, runtime: core.runtime, redactionValues: () => [] } as unknown as Core;
    const data = { toolCallId: 'call', stream: 'stdout', output: 'vider-key\n' };
    core.runtime.event({ kind: 'shell_output', data, contextId: 'main', runId: 'run' });
    const projected = publicToolEvent(restartedCore, { seq: core.runtime.eventHead(), kind: 'shell_output', data, contextId: 'main', runId: 'run', taskId: null, createdAt: '' });
    assert.equal(projected.output, undefined);
    assert.doesNotMatch(JSON.stringify(projected), /synthetic-pro|vider-key/);
  } finally { db.close(); }
});

test('unchanged bounded stream text is not copied into every durable update', () => {
  const { db, emit } = fixture();
  try {
    emit('tool_start', { toolCallId: 'call', toolName: 'mastra_workspace_execute_command', args: { command: 'fixture' } });
    const first = emit('shell_output', { toolCallId: 'call', stream: 'stdout', output: 'line\n'.repeat(30000) });
    assert.equal(first.output!.truncated, true);
    const next = emit('shell_output', { toolCallId: 'call', stream: 'stdout', output: 'later\n'.repeat(1000) });
    assert.equal(next.output, undefined);
    const final = emit('command_exit', { toolCallId: 'call', exitCode: 0, success: true });
    assert.equal(final.output!.characters, 156000);
    assert.equal(final.output!.truncated, true);
  } finally { db.close(); }
});

test('successful edits show removed and added lines, while failed edits never claim a diff', () => {
  const { db, core } = fixture();
  try {
    const args = { path: 'fixture.ts', old_string: 'same\nold\nlast', new_string: 'same\nnew synthetic-provider-key\nlast' };
    const projected = publicToolOutput(core, 'mastra_workspace_edit_file', args, 'Replaced 1 occurrence in fixture.ts', undefined, true);
    assert.match(projected.diff!.text, /\n-old\n\+new \[hidden\]\n last/);
    assert.equal(publicToolOutput(core, 'mastra_workspace_edit_file', args, 'String not found', undefined, false).diff, undefined);
    const patch = '*** Begin Patch\n*** Update File: fixture.ts\n@@\n-old\n+new\n*** End Patch';
    assert.equal(publicToolOutput(core, 'mastra_workspace_apply_patch', { patch }, 'Applied patch:\nM fixture.ts', undefined, true).diff!.text, patch);
    assert.equal(publicToolOutput(core, 'mastra_workspace_apply_patch', { patch }, 'Patch not applied', undefined, true).diff, undefined);
    const write = publicToolOutput(core, 'mastra_workspace_write_file', { path: 'fixture.ts', content: 'written source\nsynthetic-provider-key' }, 'Wrote 40 bytes to fixture.ts', undefined, true);
    assert.match(write.output!.text, /written source\n\[hidden\]/);
    assert.equal(write.diff, undefined, 'an overwrite without an old version is content, not an invented diff');
  } finally { db.close(); }
});

test('media and web representations omit binary data and internal guidance', () => {
  const { db, core } = fixture();
  try {
    const media = publicToolOutput(core, 'mastra_workspace_read_file', {}, { __workspaceMedia: true, text: 'picture.png · image/png', data: 'private-binary-data' });
    assert.equal(media.output!.text, 'picture.png · image/png');
    const web = publicToolOutput(core, 'web_fetch', {}, { title: 'Example', content: 'Visible page text', security: 'internal guidance', metadata: 'private metadata' });
    assert.equal(web.output!.text, 'Example\nVisible page text');
    assert.doesNotMatch(JSON.stringify([media, web]), /private|internal guidance/);
  } finally { db.close(); }
});

test('MCP cards render safe typed content, retained references and honest source status without encoded bytes or private fields',()=>{
 const{core,db}=fixture();try{const image='SYNTHETIC_ENCODED_IMAGE_BYTES',raw='SYNTHETIC_PRIVATE_PACKET_FIELD',result={version:1,kind:'mcp-model-result',status:'output-invalid',packetReceived:true,validated:false,isError:false,error:true,content:[{type:'text',text:'Original source text synthetic-provider-key\u001b]52;c;malicious\u0007'},{type:'image',data:image,mimeType:'image/png'}],references:[{id:'mcp-result.synthetic-image',representation:'mcp-model-image',mediaType:'image/png',bytes:27},{id:'mcp-result.synthetic-data',representation:'mcp-model-structured',mediaType:'application/json',bytes:44}],_meta:{private:raw}},display=publicToolOutput(core,'ext_source_read',{},result).output!.text;assert.match(display,/来源结果未通过验证/);assert.match(display,/Original source text \[hidden\]/);assert.match(display,/图像 · image\/png · 27 字节/);assert.match(display,/结构化数据 · application\/json/);assert.doesNotMatch(display,new RegExp(image+'|'+raw+'|synthetic-provider-key|malicious'));
  const page=publicToolOutput(core,'read_mcp_result',{}, {source:{name:'Original image',mediaType:'image/png',validated:true,isError:true},representation:'base64',byteLength:27,content:image,nextByteOffset:27}).output!.text;assert.match(page,/服务原结果报告错误/);assert.match(page,/27 字节/);assert.match(page,/从字节 27 继续/);assert.doesNotMatch(page,new RegExp(image));const historical=publicToolOutput(core,'read_mcp_result',{}, {source:{name:'Original historical text',mediaType:'text/plain',authority:'imported-untrusted-history',original:{mcp:{validated:false,isError:false}}},representation:'utf8-source-text',content:'Preserved historical source'}).output!.text;assert.match(historical,/来源结果未通过验证/);assert.match(historical,/Preserved historical source/);assert.deepEqual(publicToolOutput(core,'unrelated_custom_tool',{},result),{},'the typed MCP display does not make unrelated tool results public');
 }finally{db.close();}
});

test('web cards expose real status and retained text while leaving host framing and encoded bytes out of the display',()=>{
  const {core,db}=fixture(),id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',guide='Synthetic host boundary',content=`${guide}\n<external-content id="${id}">\nOriginal page body\n</external-content id="${id}">`;try{
  const fetched=publicToolOutput(core,'web_fetch',{}, {status:403,error:'HTTP 403 from origin',title:'Source',url:'https://synthetic.example/',security:guide,content,textTruncated:true,resultRef:{isTruncated:false}});assert.match(fetched.output!.text,/HTTP 403/);assert.match(fetched.output!.text,/Original page body/);assert.match(fetched.output!.text,/其余正文已保留/);assert.doesNotMatch(fetched.output!.text,/Synthetic host boundary|external-content/);
  const raw=publicToolOutput(core,'read_web_result',{}, {source:{url:'https://synthetic.example/',status:200,isTruncated:true},representation:'base64',byteLength:8,content:'c2VjcmV0IQ=='});assert.match(raw.output!.text,/8 字节/);assert.match(raw.output!.text,/来源内容不完整/);assert.doesNotMatch(raw.output!.text,/c2VjcmV0/);
  }finally{db.close();}
});

test('web cards show actual provider tier, one-call rescue and excerpt coverage while an unknown origin stays unknown',()=>{
  const {core,db}=fixture();try{const provider={name:'parallel',mode:'keyless',coverage:'excerpt',rescuedFrom:'tavily',backendError:'synthetic-provider-key rejected'},fetched=publicToolOutput(core,'web_fetch',{}, {status:null,title:'Source',content:'Provider excerpt',provider,resultRef:{isTruncated:true}}).output!.text;assert.match(fetched,/Parallel · 免密钥/);assert.match(fetched,/仅返回摘要/);assert.match(fetched,/接续了 Tavily/);assert.match(fetched,/\[hidden\] rejected/);assert.doesNotMatch(fetched,/HTTP 200|synthetic-provider-key/);const read=publicToolOutput(core,'read_web_result',{}, {source:{status:null,provider,isTruncated:true},representation:'utf8-source-text',content:'Retained excerpt'}).output!.text;assert.match(read,/仅返回摘要/);assert.match(read,/Retained excerpt/);assert.doesNotMatch(read,/HTTP 200|synthetic-provider-key/);}finally{db.close();}
});

test('web failure cards preserve provider refusal text and distinguish disabled search from a successful empty search',()=>{
  const {core,db}=fixture();try{const disabled=publicToolOutput(core,'web_search',{}, {status:'not configured',isError:true,reason:'Web search is disabled.'}).output!.text;assert.match(disabled,/网页搜索未启用/);const failed=publicToolOutput(core,'web_search',{}, {status:'error',isError:true,error:'HTTP 401: synthetic-provider-key rejected'}).output!.text;assert.match(failed,/HTTP 401: \[hidden\] rejected/);assert.doesNotMatch(failed,/synthetic-provider-key/);}finally{db.close();}
});

test('expanded text exposes explicit truncation and folded previews count wrapped rows', () => {
  const { db, core } = fixture();
  try {
    const data = publicToolOutput(core, 'mastra_workspace_read_file', {}, '漢'.repeat(140000));
    assert.equal(data.output!.truncated, true);
    assert.equal(data.output!.characters, 140000);
    const short = { output: { text: Array.from({ length: 20 }, (_, i) => `output row ${i}`).join('\n'), characters: 270, lines: 20 } };
    const folded = new ToolOutput(short, false, plainTheme).render(80).map(stripTerminalSequences).join('\n');
    assert.match(folded, /output row 9/); assert.doesNotMatch(folded, /output row 10/); assert.match(folded, /还有 10 行/);
    const expanded = new ToolOutput(short, true, plainTheme).render(80).join('\n');
    assert.match(expanded, /output row 19/); assert.doesNotMatch(expanded, /还有/);
    const clipped = new ToolOutput(data, true, plainTheme).render(1000).join('\n');
    assert.match(clipped, /输出已截断，原文 140000 字符/);
    const narrow = new ToolOutput({ output: { text: 'long output '.repeat(30), characters: 360, lines: 1 } }, false, plainTheme).render(20);
    assert.ok(narrow.length >= 11); assert.match(narrow.join('\n'), /还有/);
  } finally { db.close(); }
});

test('MCP progress displays only typed safe live fields and never overrides a settled result',()=>{
 const {db,emit,removeSecrets}=fixture();try{
  emit('tool_start',{toolCallId:'mcp-progress',toolName:'ext_synthetic_work',args:{}});
  const progress=emit('tool_update',{toolCallId:'mcp-progress',partialResult:{version:1,kind:'mcp-progress',progress:1,total:2,message:'正在处理 synthetic-provider-key\u001b]52;c;clipboard\u0007',_meta:{private:'SYNTHETIC_PRIVATE_PROGRESS_META'}}});
  assert.match(progress.output!.text,/进度 1 \/ 2/);assert.match(progress.output!.text,/正在处理/);assert.doesNotMatch(JSON.stringify(progress),/synthetic-provider-key|clipboard|SYNTHETIC_PRIVATE_PROGRESS_META|\u001b/);
  removeSecrets();const next=emit('tool_update',{toolCallId:'mcp-progress',partialResult:{version:1,kind:'mcp-progress',progress:2,total:2,message:'synthetic-provider-key'}});assert.doesNotMatch(JSON.stringify(next),/synthetic-provider-key/);
  emit('tool_end',{toolCallId:'mcp-progress',result:{version:1,kind:'mcp-model-result',status:'returned',content:[{type:'text',text:'Original completed result'}],references:[]}});
  const late=emit('tool_update',{toolCallId:'mcp-progress',partialResult:{version:1,kind:'mcp-progress',progress:3,total:3,message:'LATE_SHOULD_NOT_REPLACE_RESULT'}});assert.doesNotMatch(JSON.stringify(late),/LATE_SHOULD_NOT_REPLACE_RESULT/);
 }finally{db.close();}
});

test('native attachment image views display safe source metadata and hints without exposing base64 or granting raw page display',()=>{
 const f=fixture();try{const source={id:'synthetic-attachment-image',name:'Original image\u001b[31m',mediaType:'image/png',bytes:31415,sha256:'a'.repeat(64)},content=Buffer.from('SYNTHETIC_RAW_ATTACHMENT_PIXELS').toString('base64'),image={source,authority:'external-attachment-data',representation:'image',complete:true,mediaType:'image/png',content,byteLength:1000,hints:['Resized for the selected model.'],imageOmitted:false},visible=publicToolOutput(f.core,'read_attachment',{},image);assert.ok(visible.output);assert.match(visible.output.text,/Original image\nimage\/png\n图像 · 1000 字节\nResized/);assert.doesNotMatch(JSON.stringify(visible),new RegExp(content+'|\\u001b|SYNTHETIC_RAW_ATTACHMENT_PIXELS'));const omitted=publicToolOutput(f.core,'read_attachment',{}, {...image,content:'',byteLength:0,imageOmitted:true,hints:['synthetic-provider-key']});assert.match(omitted.output!.text,/当前模型无法查看图像/);assert.doesNotMatch(omitted.output!.text,/synthetic-provider-key/);assert.deepEqual(publicToolOutput(f.core,'read_attachment',{}, {...image,representation:'base64'}),{});}finally{f.db.close();}
});
