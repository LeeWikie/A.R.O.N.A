import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { Core } from '../src/core.js';
import { finished, removeTemp } from './helpers.js';

for(const pages of [4,6])test(`one native conversation compacts ${pages} original byte pages without replaying completed reads`, { timeout: 30_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-growing-tool-turn-'));
  const core = await Core.open({ dataDir: directory, memoryEnabled: false });
  const provider = fauxProvider({ provider: 'synthetic-growing-turn', models: [{ id: 'bounded-context', contextWindow: 40000, maxTokens: 2000 }] });
  let primary = 0, summaries = 0;
  const requests: string[] = [];
  const bytes = Buffer.from(Array.from({ length: pages * 32768 }, (_, index) => index % 251));
  try {
    const asset = await core.assets.put(new Response(bytes).body, 'growing-turn.bin', undefined, { purpose: 'client-shell-output' });
    provider.setResponses(Array.from({ length: 20 }, () => context => {
      const prompt = JSON.stringify(context.messages); requests.push(prompt);
      if (!getCurrentTools(context.messages).length) { summaries++; return fauxAssistantMessage('Retain the original request to inspect all original byte pages and the completed reads.'); }
      const step = primary++;
      if (step < pages) {
        const source = core.store.db.prepare("SELECT id FROM signals WHERE json_extract(body,'$.contextId')='main' AND status='accepted' ORDER BY rowid DESC LIMIT 1").get();
        assert.ok(source);
        return fauxAssistantMessage([fauxToolCall('read_attachment', { id: asset.id, signalIds: [String(source.id)], encoding: 'base64', byteOffset: step * 32768, maxBytes: 32768 }, { id: `page-${step}` })], { stopReason: 'toolUse' });
      }
      assert.ok(summaries > 0, 'the primary model receives a compacted working set before the final response');
      return fauxAssistantMessage('All original pages were inspected.');
    }));
    core.providerRegistry.setProvider(provider.provider);
    core.models.save({ id: 'default', name: 'Bounded context', providerId: provider.provider.id, modelId: 'bounded-context' });
    core.configure('runtime', { autoCompaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 5000 } });
    const source = await core.submitMessage({ content: `Inspect all ${pages} original byte pages, preserve each completed read and do not repeat them.`, attachments: [asset.id] });
    const run = await finished(core, source.runId!);
    assert.equal(run?.status, 'succeeded', JSON.stringify({ primary, summaries, events: core.runtime.events('main', 0, 1000).filter(event => ['error','compaction_state','context_budget','capacity_state'].includes(event.kind)) }));
    assert.equal(primary, pages+1);
    assert.equal(summaries, pages===6?2:1);
    const events = core.runtime.events('main', 0, 1000);
    const completed = events.filter(event => event.kind === 'tool_end' && /^page-/.test(String((event.data as {toolCallId?:string}).toolCallId)));
    assert.equal(completed.length, pages);
    assert.equal(new Set(completed.map(event => (event.data as {toolCallId:string}).toolCallId)).size, pages);
    for(let index=0;index<pages;index++){
      const event=completed.find(event=>(event.data as {toolCallId:string}).toolCallId===`page-${index}`)!;
      const result=(event.data as {result:{content:string;byteOffset:number;byteLength:number}}).result;
      assert.equal(result.byteOffset,index*32768);assert.equal(result.byteLength,32768);
      assert.deepEqual(Buffer.from(result.content,'base64'),bytes.subarray(index*32768,(index+1)*32768));
    }
    assert.equal(core.store.getSignal(source.id)?.content, source.content);
    assert.ok(core.sessionGraph.records('main').some(row => row.entry.type === 'compaction'));
    assert.equal(core.runtime.approvals().length, 0);
    assert.match(requests.at(-1)!, /Retain the original request/);
  } finally { await core.close(); await removeTemp(directory); }
});
