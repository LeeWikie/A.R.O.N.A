import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTemp } from './helpers.js';
import { DatabaseSync } from 'node:sqlite';
import { MessageList, type MastraDBMessage } from '@mastra/core/agent/message-list';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import type { ProcessLLMRequestArgs } from '@mastra/core/processors';
import { createProvider, type Context, type Model } from '@earendil-works/pi-ai';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { azureOpenAIResponsesApi } from '@earendil-works/pi-ai/api/azure-openai-responses.lazy';
import { Core } from '../src/core.js';
import { completeHistory } from '../src/context-history.js';
import { serializeConversation, type NativeMessage } from '../src/compaction.js';
import { conversationPage, contextThinking, publicEventPage, snapshot } from '../src/event-stream.js';
import { legacyResponsesMetadata, responsesReplayMetadata } from '../src/providers/replay-metadata.js';
import { finished } from './helpers.js';

type ResponsesApi = 'openai-responses' | 'azure-openai-responses';
const opaque = 'SYNTHETIC-LEGACY-ENCRYPTED-CONTENT';
const empty = { type: 'reasoning', id: 'rs_legacy_empty', summary: [], encrypted_content: opaque };
const visible = { type: 'reasoning', id: 'rs_legacy_visible', summary: [{ type: 'summary_text', text: 'legacy visible summary\n\n' }] };
const middle = { type: 'reasoning', id: 'rs_legacy_middle', summary: [], encrypted_content: null };
const base = { id: 'legacy-model', name: 'Fixture', baseUrl: 'https://legacy.invalid', input: ['text'] as ['text'], reasoning: true, contextWindow: 100000, maxTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function modelFor(api: ResponsesApi): Model<ResponsesApi> { return { ...base, api, provider: `legacy-${api}` }; }
function providerFor(model: Model<ResponsesApi>, alternatives: Model<ResponsesApi>[] = []) {
  return createProvider({ id: model.provider, name: 'Fixture', baseUrl: model.baseUrl, models: [model, ...alternatives], api: model.api === 'openai-responses' ? openAIResponsesApi() : azureOpenAIResponsesApi(), auth: { apiKey: { name: 'Fixture', resolve: async () => ({ auth: { apiKey: 'synthetic-only-key' }, source: 'fixture' }) } } });
}
function oldMessages(api: ResponsesApi): MastraDBMessage[] {
  const model = modelFor(api);
  const provenance = { api, provider: model.provider, model: model.id };
  const reasoning = (item: typeof empty | typeof visible | typeof middle) => ({ type: 'reasoning' as const, reasoning: item.summary.map(s => s.text).join('\n\n'), details: [{ type: 'text' as const, text: item.summary.map(s => s.text).join('\n\n') }], providerMetadata: { pi: { provenance, thinkingSignature: JSON.stringify(item) } } });
  return [
    { id: 'legacy-user', role: 'user', parts: [{ type: 'text' as const, text: 'legacy question' }] },
    { id: 'legacy-pure', role: 'assistant', parts: [reasoning(empty), reasoning(visible)] },
    { id: 'legacy-mixed', role: 'assistant', parts: [{ type: 'text' as const, text: 'before legacy thinking' }, reasoning(middle), { type: 'text' as const, text: 'after legacy thinking' }] },
  ].map((m, index) => ({ id: m.id, role: m.role as 'user' | 'assistant', threadId: 'main', resourceId: 'local', createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, index)), content: { format: 2, parts: m.parts } }));
}
function response(output: Record<string, unknown>[], model: Model<ResponsesApi>) {
  const frames = [
    ...output.flatMap((item, output_index) => [
      { type: 'response.output_item.added', output_index, item: item.type === 'function_call' ? { ...item, arguments: '' } : item },
      { type: 'response.output_item.done', output_index, item },
    ]),
    { type: 'response.completed', response: { id: 'resp_legacy', model: model.id, status: 'completed', output, usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } },
  ];
  return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
type InputItem = { type: string; id?: string; role?: string; output?: string; content?: Array<{ type: string; text?: string }> };
type Body = { input: InputItem[] };
async function seedLegacyHistory(directory: string, messages: MastraDBMessage[]) {
  const storage = new LibSQLStore({ id: 'arona-storage', url: 'file:' + join(directory, 'history.sqlite').replaceAll('\\', '/') });
  await storage.init();
  const memory = new Memory({ storage, options: { lastMessages: false, generateTitle: false, semanticRecall: false, workingMemory: { enabled: false } } });
  try { await memory.createThread({ threadId: 'main', resourceId: 'local' }); await memory.saveMessages({ messages }); }
  finally { await storage.close(); }
}

for (const api of ['openai-responses', 'azure-openai-responses'] as const) test(`pi-only legacy replay is request-only through Core/Models/HTTP, restart and two copyThread generations: ${api}`, { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arona-legacy-replay-'));
  const model = modelFor(api); const originalFetch = globalThis.fetch;
  const requests: Body[] = []; const contexts: Context[] = [];
  let toolNext = false; let summarizing = false;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); assert.ok(request.url.startsWith(model.baseUrl + '/'));
    const body = await request.json() as Body; requests.push(body);
    const output = toolNext
      ? [{ type: 'function_call', id: 'fc_legacy_history', call_id: 'call_legacy_history', name: 'context_history', arguments: JSON.stringify({ id: 'main', page: 0 }) }]
      : [{ type: 'message', id: 'msg_legacy_answer', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: summarizing ? '## Summary\nLegacy visible conversation.' : 'new answer', annotations: [] }] }];
    toolNext = false;
    return response(output, model);
  };
  let core: Core | undefined;
  const open = async () => {
    const app = await Core.open({ dataDir: directory, controlToken: 'synthetic-legacy-control-'.repeat(3), memoryEnabled: false });
    app.providerRegistry.setProvider(providerFor(model));
    app.models.save({ id: 'default', name: 'Fixture', providerId: model.provider, modelId: model.id });
    const stream = app.providerRegistry.streamSimple.bind(app.providerRegistry);
    app.providerRegistry.streamSimple = (target, context, options) => { contexts.push(structuredClone(context)); return stream(target, context, options); };
    return app;
  };
  const send = async (contextId = 'main') => {
    const receipt = await core!.submitMessage({ contextId, content: 'Continue the synthetic old conversation' });
    assert.equal((await finished(core!, receipt.runId!))?.status, 'succeeded'); return receipt.runId!;
  };
  const recall = async (id: string) => (await core!.memory.recall({ threadId: id, page: 0, perPage: 100, hideSignals: false, orderBy: { field: 'createdAt', direction: 'ASC' } })).messages;
  const assertReplay = () => {
    const assistants = contexts.at(-1)!.messages.filter(m => m.role === 'assistant');
    const first = assistants[0]!; assert.equal(first.role, 'assistant');
    assert.deepEqual({ api: first.api, provider: first.provider, model: first.model }, { api, provider: model.provider, model: model.id });
    assert.deepEqual(first.content, [
      { type: 'thinking', thinking: '', thinkingSignature: JSON.stringify(empty) },
      { type: 'thinking', thinking: 'legacy visible summary\n\n', thinkingSignature: JSON.stringify(visible) },
    ]);
    assert.deepEqual(assistants[1]!.content.map(p => p.type), ['text', 'thinking', 'text']);
    const items = requests.at(-1)!.input;
    const relevant = items.filter(p => p.type === 'reasoning' && p.id?.startsWith('rs_legacy') || p.type === 'message' && p.role === 'assistant' && p.content?.some(c => c.text?.includes('legacy thinking')));
    assert.deepEqual(relevant.map(p => p.type), ['reasoning', 'reasoning', 'message', 'reasoning', 'message']);
    assert.deepEqual(relevant[0], empty); assert.deepEqual(relevant[1], visible); assert.deepEqual(relevant[3], middle);
    assert.equal(relevant[2]?.content?.[0]?.text, 'before legacy thinking'); assert.equal(relevant[4]?.content?.[0]?.text, 'after legacy thinking');
  };
  try {
    const old = oldMessages(api); await seedLegacyHistory(directory, old);
    core = await open();
    const storedRows = () => {
      const db = new DatabaseSync(join(directory, 'history.sqlite'), { readOnly: true });
      try { return db.prepare('SELECT * FROM mastra_messages WHERE id IN (?, ?, ?) ORDER BY id').all(...old.map(m => m.id)); }
      finally { db.close(); }
    };
    const beforeRows = storedRows(); assert.equal(beforeRows.length, old.length);
    const before = structuredClone(await recall('main'));
    for (const message of before) for (const part of message.content.parts) assert.ok(!part.providerMetadata || !('openai' in part.providerMetadata) && !('azure' in part.providerMetadata), 'fixture really predates native mirroring');
    const unfixed = new MessageList().add(before, 'memory');
    const oldPrompt = await unfixed.get.all.aiV5.llmPrompt();
    assert.ok(!JSON.stringify(oldPrompt).includes(empty.id), 'installed Mastra drops the pi-only pure reasoning turn before repair');
    assert.ok(JSON.stringify(oldPrompt).includes('before legacy thinking'));
    const firstRun = await send(); assertReplay();
    const firstSnapshot = structuredClone(core.projectMemory.snapshot(firstRun));
    const assertOriginalStorage = async () => {
      assert.deepEqual((await recall('main')).filter(m => before.some(old => old.id === m.id)), before);
      assert.deepEqual(core!.projectMemory.snapshot(firstRun), firstSnapshot);
      assert.deepEqual(storedRows(), beforeRows, 'original SQLite row fields, including serialized content bytes, are unchanged');
    };
    await assertOriginalStorage(); await send(); assertReplay(); await assertOriginalStorage();
    const native = (firstSnapshot.nativeMessages as { messages: NativeMessage[] }).messages;
    const oldNative = native.find(m => m.id === 'legacy-pure')!; assert.ok(oldNative);
    assert.ok(!JSON.stringify(oldNative).includes('itemId'), 'private native snapshot retains the pi-only original');
    for (const value of [await core.history('main'), contextThinking(core, 'main'), publicEventPage(core, 0), snapshot(core), serializeConversation(native)]) {
      const encoded = JSON.stringify(value);
      for (const privateValue of [opaque, 'thinkingSignature', 'rs_legacy']) assert.ok(!encoded.includes(privateValue));
    }
    toolNext = true; await send(); assertReplay();
    const results = requests.at(-1)!.input.filter(p => p.type === 'function_call_output');
    assert.equal(results.length, 1); assert.ok(!JSON.stringify(results).includes(opaque)); assert.ok(!JSON.stringify(results).includes('thinkingSignature'));
    assert.deepEqual(storedRows(), beforeRows, 'bytes before closing');
    await core.close(); core = undefined;
    assert.deepEqual(storedRows(), beforeRows, 'bytes after closing');
    core = await open();
    assert.deepEqual(storedRows(), beforeRows, 'bytes immediately after reopening');
    const restartedRun = await send(); assertReplay(); await assertOriginalStorage();
    const copy = core.memory.copyThread.bind(core.memory); let copies = 0;
    core.memory.copyThread = async (...args) => { copies++; return copy(...args); };
    const child = await core.branchContext('main', restartedRun, 'First legacy descendant', 'legacy.child');
    const childBefore = structuredClone(await recall(child.id));
    const childRun = await send(child.id); assertReplay();
    assert.deepEqual((await recall(child.id)).filter(m => childBefore.some(old => old.id === m.id)), childBefore);
    const grandchild = await core.branchContext(child.id, childRun, 'Second legacy descendant', 'legacy.grandchild');
    const grandchildBefore = structuredClone(await recall(grandchild.id)); assert.equal(copies, 2);
    await core.close(); core = undefined; core = await open();
    await send(grandchild.id); assertReplay();
    assert.deepEqual((await recall(grandchild.id)).filter(m => grandchildBefore.some(old => old.id === m.id)), grandchildBefore);
    await assertOriginalStorage();
    const count = requests.length; summarizing = true;
    await core.compactContext('main', { id: 'legacy.compacted', keepRecentTokens: 1 });
    assert.ok(requests.length > count, 'real summary request executed');
    for (const body of requests.slice(count)) for (const privateValue of [opaque, 'thinkingSignature', 'rs_legacy']) assert.ok(!JSON.stringify(body).includes(privateValue), 'summary has no private replay identity or ciphertext');
    await assertOriginalStorage();
    const different = { ...model, id: 'different-model' };
    core.providerRegistry.setProvider(providerFor(model, [different]));
    core.models.save({ id: 'default', name: 'Different fixture', providerId: model.provider, modelId: different.id });
    summarizing = false; await send();
    assert.ok(!JSON.stringify(requests.at(-1)).includes(opaque), 'cross-model requests cannot replay the old ciphertext');
    assert.ok(!requests.at(-1)!.input.some(p => p.type === 'reasoning' && p.id?.startsWith('rs_legacy')));
    await assertOriginalStorage();
  } finally { await core?.close(); globalThis.fetch = originalFetch; await removeTemp(directory); }
});

for (const api of ['openai-responses', 'azure-openai-responses'] as const) test(`legacy ${api} rejects unsupported metadata before model request conversion without changing its source`, async () => {
  const namespace = api === 'openai-responses' ? 'openai' : 'azure';
  const metadata = oldMessages(api)[1]!.content.parts[0]!.providerMetadata!;
  const bad: NonNullable<MastraDBMessage['content']['providerMetadata']>[] = [
    { pi: { thinkingSignature: JSON.stringify(empty) } },
    { pi: { ...metadata.pi, provenance: { api, provider: '', model: base.id } } },
    { pi: { ...metadata.pi, provenance: { api: '', provider: modelFor(api).provider, model: base.id } } },
    { pi: { ...metadata.pi, provenance: { provider: modelFor(api).provider, model: base.id } } },
    { pi: { ...metadata.pi, thinkingSignature: 'not JSON' } },
    { pi: { ...metadata.pi, thinkingSignature: JSON.stringify({ ...empty, type: 'message' }) } },
    { pi: { ...metadata.pi, thinkingSignature: JSON.stringify({ ...empty, summary: [{}] }) } },
    { pi: { ...metadata.pi, thinkingSignature: JSON.stringify({ ...empty, encrypted_content: 12 }) } },
    { ...metadata, [namespace]: { itemId: 'conflicting-item', reasoningEncryptedContent: opaque } },
    { ...metadata, [namespace]: { itemId: empty.id, reasoningEncryptedContent: 'conflicting ciphertext' } },
    { ...metadata, [namespace === 'openai' ? 'azure' : 'openai']: { itemId: empty.id } },
  ];
  for (const value of bad) {
    const list = new MessageList().add([{ ...oldMessages(api)[1]!, content: { format: 2, parts: [{ type: 'reasoning', reasoning: '', details: [], providerMetadata: value }] } }], 'memory');
    const before = structuredClone(list.serialize());
    const args = { messageList: list, prompt: await list.get.all.aiV5.llmPrompt() } as ProcessLLMRequestArgs;
    await assert.rejects(() => completeHistory(undefined as never).processLLMRequest(args), /legacy/);
    assert.deepEqual(list.serialize(), before);
  }
  const mirrored = responsesReplayMetadata(api, JSON.stringify(empty))!;
  assert.equal(legacyResponsesMetadata({ ...metadata, [mirrored.namespace]: mirrored.value }), undefined, 'already matching native identity needs no rewrite');
});

for (const api of ['openai-responses', 'azure-openai-responses'] as const) for (const problem of ['missing-provenance', 'missing-api', 'empty-api', 'invalid-signature', 'native-conflict'] as const) test(`Core fails closed for old ${api}/${problem} without HTTP or storage repair`, { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arona-legacy-reject-'));
  const originalFetch = globalThis.fetch; let requests = 0;
  globalThis.fetch = async (input,init) => {
    const url=input instanceof Request?input.url:String(input);
    if(url.startsWith('data:'))return originalFetch(input,init);
    requests++; throw new Error('Unexpected synthetic HTTP request');
  };
  let core: Core | undefined;
  try {
    const model = modelFor(api);
    const messages = oldMessages(api); const part = messages[1]!.content.parts[0]!;
    const metadata = part.providerMetadata!;
    if (problem === 'missing-provenance') delete metadata.pi!.provenance;
    if (problem === 'missing-api') metadata.pi!.provenance = { provider: model.provider, model: model.id };
    if (problem === 'empty-api') metadata.pi!.provenance = { api: '', provider: model.provider, model: model.id };
    if (problem === 'invalid-signature') metadata.pi!.thinkingSignature = JSON.stringify({ ...empty, encrypted_content: 12 });
    if (problem === 'native-conflict') metadata[api === 'openai-responses' ? 'openai' : 'azure'] = { itemId: 'conflicting-id', reasoningEncryptedContent: opaque };
    await seedLegacyHistory(directory, messages);
    core = await Core.open({ dataDir: directory, controlToken: 'synthetic-legacy-reject-'.repeat(3), memoryEnabled: false });
    core.providerRegistry.setProvider(providerFor(model));
    core.models.save({ id: 'default', name: 'Fixture', providerId: model.provider, modelId: model.id });
    const recall = async () => (await core!.memory.recall({ threadId: 'main', page: 0, perPage: 100, hideSignals: false })).messages.filter(m => messages.some(original => original.id === m.id));
    const before = structuredClone(await recall());
    const storedRows=()=>{const db=new DatabaseSync(join(directory,'history.sqlite'),{readOnly:true});try{return db.prepare('SELECT * FROM mastra_messages WHERE id IN (?, ?, ?) ORDER BY id').all(...messages.map(message=>message.id));}finally{db.close();}};
    const beforeRows=storedRows();
    const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3XcAAAAASUVORK5CYII=','base64');
    const textAsset=await core.assets.put(new Response('SYNTHETIC_FAILED_INPUT_ATTACHMENT').body,'failed-input.txt');
    const imageAsset=await core.assets.put(new Response(image).body,'failed-input.png');
    const content='Continue invalid synthetic legacy conversation';
    const receipt = await core.submitMessage({ content,attachments:[textAsset.id,imageAsset.id] });
    assert.equal((await finished(core, receipt.runId!))?.status, 'failed');
    assert.equal(requests, 0, 'reject before Models/HTTP even when Mastra dropped the pure reasoning turn');
    assert.deepEqual(await recall(), before);
    const checkInput=async()=>{
      const visible=conversationPage(core!,'main').messages.find(message=>message.id==='signal:'+receipt.id);
      assert.ok(visible,'accepted input remains visible even when request normalization fails');assert.equal(visible.content,content);assert.deepEqual(visible.attachments,[textAsset.id,imageAsset.id]);
      assert.ok(core!.sessionGraph.records('main').some(row=>row.source?.messageId===receipt.nativeSignalId&&row.source.publicMessageIds?.includes(visible.id)),'retain the actual accepted native ID and public source binding');
      const native=(await core!.memory.recall({threadId:'main',page:0,perPage:100,hideSignals:false})).messages.find(message=>message.id===receipt.nativeSignalId);
      assert.ok(native);const body=JSON.stringify(native.content);assert.ok(body.includes(content));assert.ok(body.includes('SYNTHETIC_FAILED_INPUT_ATTACHMENT'));assert.ok(body.includes(image.toString('base64')));
      const archived=core!.projectMemory.snapshot(receipt.runId!);assert.deepEqual(archived.promptState,{stage:'input',status:'unavailable'});assert.deepEqual(archived.prompt,[]);assert.equal(archived.lastRequestPrompt,undefined);
      assert.deepEqual(storedRows(),beforeRows,'failed input persistence does not rewrite any original legacy SQLite row');
      assert.deepEqual(await recall(),before);assert.deepEqual((await core!.assets.read(imageAsset.id)).bytes,image);assert.equal(requests,0);
    };
    await checkInput();await core.close();core=undefined;
    core=await Core.open({dataDir:directory,controlToken:'synthetic-legacy-reject-'.repeat(3),memoryEnabled:false});
    await checkInput();assert.equal(core.store.getRun(receipt.runId!)?.status,'failed');
  } finally { await core?.close(); globalThis.fetch = originalFetch; await removeTemp(directory); }
});

test('request-only conversion retains empty legacy bodies, IDs, source tracking and tagged systems', async () => {
  const old = oldMessages('openai-responses')[1]!;
  for (const part of old.content.parts) if (part.type === 'reasoning') part.details = [];
  const list = new MessageList().add([old], 'memory').add('new input', 'input').addSystem('tagged system fixture', 'fixture-tag');
  const before = structuredClone(list.serialize());
  const args = { messageList: list, prompt: await list.get.all.aiV5.llmPrompt(), apiProviderId: 'pi' } as ProcessLLMRequestArgs;
  const result = await completeHistory(undefined as never).processLLMRequest(args);
  assert.ok(result); assert.ok(result.prompt.some(m => m.role === 'system' && m.content === 'tagged system fixture'));
  const assistant = result.prompt.find(m => m.role === 'assistant'); assert.ok(assistant?.role === 'assistant');
  const first = assistant.content[0]; assert.ok(first?.type === 'reasoning'); assert.equal(first.text, '');
  assert.equal(first.providerOptions?.openai?.reasoningEncryptedContent, opaque);
  assert.deepEqual(list.serialize(), before);
  assert.equal(list.makeMessageSourceChecker().getSource(list.get.all.db()[0]!), 'memory');
});
