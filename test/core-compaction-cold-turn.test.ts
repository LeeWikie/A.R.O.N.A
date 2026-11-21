import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { Core } from '../src/core.js';
import { finished, removeTemp, until } from './helpers.js';

test('a compacted native turn resumes its original checkpoint after a question and cold service restart', { timeout: 30_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-cold-compacted-turn-'));
  const provider = fauxProvider({ provider: 'synthetic-cold-turn', models: [{ id: 'bounded-context', contextWindow: 40000, maxTokens: 2000 }] });
  const recover=Reflect.get(Core.prototype,'recoverSuspendedRuns');
  Reflect.set(Core.prototype,'recoverSuspendedRuns',async function(this:Core){
    this.providerRegistry.setProvider(provider.provider);
    if(!this.models.profile('default'))this.models.save({id:'default',name:'Synthetic native provider',providerId:provider.provider.id,modelId:'bounded-context'});
    return recover.call(this);
  });
  const options = { dataDir: directory, memoryEnabled: false };
  let core = await Core.open(options), pages = 0, summaries = 0, asked = false, primary = 0;
  const bytes = Buffer.from(Array.from({ length: 6 * 32768 }, (_, index) => index % 251));
  try {
    const asset = await core.assets.put(new Response(bytes).body, 'cold-turn.bin', undefined, { purpose: 'client-shell-output' });
    provider.setResponses(Array.from({ length: 30 }, () => context => {
      if (!getCurrentTools(context.messages).length) { summaries++; return fauxAssistantMessage('Retain the original six-page request and each completed read.'); }
      primary++;
      if (pages === 3 && !asked) { asked = true; return fauxAssistantMessage([fauxToolCall('ask_user', { question: 'Continue the original six-page read?', options: [{ label: 'Continue' }] }, { id: 'question-after-third-page' })], { stopReason: 'toolUse' }); }
      if (pages < 6) {
        const source = core.store.db.prepare("SELECT id FROM signals WHERE json_extract(body,'$.contextId')='main' AND status='accepted' ORDER BY rowid DESC LIMIT 1").get(); assert.ok(source);
        const index = pages++;
        return fauxAssistantMessage([fauxToolCall('read_attachment', { id: asset.id, signalIds: [String(source.id)], encoding: 'base64', byteOffset: index * 32768, maxBytes: 32768 }, { id: `original-page-${index}` })], { stopReason: 'toolUse' });
      }
      return fauxAssistantMessage('All six original byte pages were inspected.');
    }));
    core.configure('runtime', { autoCompaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 5000 } });
    const input = await core.submitMessage({ content: 'Inspect six original byte pages without repeating completed reads. Ask before the fourth page.', attachments: [asset.id] });
    const state = await until(() => ({question:core.interactions().find(row => row.status === 'pending'),run:core.store.getRun(input.runId!)}), value => Boolean(value.question)||value.run?.status!=='running');
    const question=state.question;assert.ok(question,JSON.stringify({pages,summaries,primary,run:state.run,events:core.runtime.events('main',0,1000).filter(event=>['error','compaction_state','context_budget'].includes(event.kind))}));
    await until(() => core.agent.listSuspendedRuns({ threadId: 'main', resourceId: 'local' }), value => value.total === 1);
    assert.equal(pages, 3); assert.equal(summaries, 1);
    const original = core.sessionGraph.records('main').map(row => JSON.stringify(row)), count = provider.state.callCount;
    await core.close(); core = await Core.open(options);
    assert.equal(provider.state.callCount, count, 'cold open does not dispatch a model or replay a completed read');
    const pending = core.interactions().find(row => row.id === question.id); assert.ok(pending); assert.equal(pending.runId, input.runId); assert.equal(pending.status, 'pending');
    await core.answerInteraction(question.id, input.runId!, 'Continue');
    assert.equal((await finished(core, input.runId!))?.status, 'succeeded');
    assert.equal(pages, 6); assert.equal(primary, 8);
    assert.equal(summaries, 2, 'resuming preserves the first checkpoint; only the newly grown tail is summarized again');
    const ends = core.runtime.events('main', 0, 1000).filter(event => event.kind === 'tool_end' && /^original-page-/.test(String((event.data as {toolCallId?:string}).toolCallId)));
    assert.equal(ends.length, 6);
    for (let index = 0; index < 6; index++) {
      const event = ends.find(event => (event.data as {toolCallId:string}).toolCallId === `original-page-${index}`)!;
      assert.deepEqual(Buffer.from((event.data as {result:{content:string}}).result.content, 'base64'), bytes.subarray(index * 32768, (index + 1) * 32768));
    }
    for (const record of original) assert.ok(core.sessionGraph.records('main').some(row => JSON.stringify(row) === record));
    assert.equal(core.store.getSignal(input.id)?.content, input.content);
    assert.equal(core.runtime.approvals().length, 0);
  } finally { await core.close();Reflect.set(Core.prototype,'recoverSuspendedRuns',recover);await removeTemp(directory); }
});
