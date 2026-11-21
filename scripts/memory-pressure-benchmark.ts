import fs from 'node:fs';
import files from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { Core } from '../src/core.js';
import type { MemoryEntry } from '../src/memory/v1/contracts.js';

class ProbeError extends Error { constructor(readonly code: string) { super(code); } }
function check(value: unknown, code: string): asserts value { if (!value) throw new ProbeError(code); }
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

function archive(messages: string[]) {
  const start = Math.floor(Date.now() / 1000) - 3600;
  const mapping: Record<string, unknown> = { root: { id: 'root', parent: null, children: ['n0'], message: null } };
  for (const [index, text] of messages.entries()) mapping[`n${index}`] = { id: `n${index}`, parent: index ? `n${index - 1}` : 'root', children: index + 1 < messages.length ? [`n${index + 1}`] : [],
    message: { id: `message-${index}`, author: { role: 'user' }, create_time: start + index, content: { content_type: 'text', parts: [text] } } };
  const bytes = Buffer.from(JSON.stringify([{ id: 'synthetic-pressure', current_node: `n${messages.length - 1}`, mapping }])), name = Buffer.from('conversations-000.json');
  let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let n = 0; n < 8; n++) crc = crc & 1 ? crc >>> 1 ^ 0xedb88320 : crc >>> 1; } crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + bytes.length, 16);
  return Buffer.concat([local, name, bytes, central, name, end]);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log('Usage: node --import tsx scripts/memory-pressure-benchmark.ts --output /absolute/private/directory [--request-limit 96] [--round-timeout-ms 600000] [--check]\nRequires SHITTIMCHEST_ALLOW_LIVE_TESTS=1 and the normal MODEL_* environment configuration. Uses only fresh synthetic data; never loads a user corpus.'); return; }
  let output = '', limit = 96, roundTimeout = 600000, dry = false;
  for (let n = 0; n < args.length; n++) {
    const name = args[n]; if (name === '--check') { dry = true; continue; }
    const value = args[++n]; check(value, 'option_value_required');
    if (name === '--output') output = value;
    else if (name === '--request-limit') { limit = Number(value); check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 96, 'invalid_request_limit'); }
    else if (name === '--round-timeout-ms') { roundTimeout = Number(value); check(Number.isSafeInteger(roundTimeout) && roundTimeout >= 1000 && roundTimeout <= 1800000, 'invalid_round_timeout'); }
    else throw new ProbeError('unknown_option');
  }
  check(output && path.isAbsolute(output), 'absolute_output_required');
  if (dry) { console.log(JSON.stringify({ checked: true, syntheticOnly: true, modelCalls: 0, createsFiles: false, requestLimit: limit })); return; }
  check(process.env.SHITTIMCHEST_ALLOW_LIVE_TESTS === '1', 'live_test_authorization_required');
  const { readConfig } = await import('../src/config.js'); const config = readConfig(); check(config.model, 'live_model_not_configured');
  const model = config.model, modelURL = new URL(model.baseURL), basePath = modelURL.pathname.replace(/\/$/, '');
  await files.mkdir(output, { recursive: true, mode: 0o700 });
  const directory = await files.mkdtemp(path.join(output, 'memory-pressure-')); await files.chmod(directory, 0o700);
  const dataDir = path.join(directory, 'data'), temp = path.join(directory, 'temp'); await files.mkdir(dataDir, { mode: 0o700 }); await files.mkdir(temp, { mode: 0o700 });
  const source = [
    '我持续在一台完全离线的工作站上整理照片；在我明确说明恢复网络之前，涉及下载和远程访问都要按离线环境考虑。这不是临时故障猜测。',
    '我有一个尚未兑现的愿望：用现有的小望远镜拍到月球环形山。我还没拍过，也没有买新设备，等条件合适再考虑，不用替我安排或执行。',
    '只在这两天临时整理书桌：银色笔筒先放左后角，绿色记事簿放右前角，橙色文件夹靠左边。紫色纸夹收在浅蓝小盒，三个回形针留在盒盖内。明天我还要照着逐项核对，请先留着这些细节；不是已经完成了，活动结束后才不再需要。',
    '一次性便签索引草案：上午用黄色页记待分类资料，下午用浅绿色页记核对事项，晚间用灰色页记收尾。临时角标分别是方形、圆形、三角形。明天还需要用这份具体索引核对，先保留到这次活动结束，不会长期沿用。',
    '我这两天临时整理一组讲座录音的文件名：开场用小写字母a，问答用b，结语用c；试排时在文件名末尾加草稿，日期前用短横线。还没整理完，明天要继续按这份具体备忘核对，完成后不再沿用这些命名细节。',
    '给朋友打包一份小礼物的临时草案：里面用米白纸，外面用浅棕纸，左边贴一条蓝色胶带，右边绑一段绿色细绳。贺卡先放顶部，备用封口贴放袋底。尚未包装好，明天还要按这些细节检查；这只是一次安排，不需要长期记住。',
    '我取消了书桌摆法、便签索引、讲座命名和礼物包装四个临时方案，明天也不再需要逐项核对那些细节。这些临时活动不再跟进；工作站环境和望远镜愿望没有发生变化。只更新认识，不要执行。',
    '今天没有其他新信息，也不需要安排或执行任何操作。',
  ];
  const archivePath = path.join(directory, 'synthetic.zip'); await files.writeFile(archivePath, archive(source), { mode: 0o600 });
  const actualFetch = globalThis.fetch, stdout = process.stdout.write, stderr = process.stderr.write, previousTmp = process.env.TMPDIR;
  const shutdown = new AbortController(); let phase = 'setup', round: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let requests = 0, attempts = 0, passed = false, error: string | null = null, core: Core | undefined, logBytes = 0;
  const stages: Record<string, unknown>[] = [], requestAudit: Record<string, unknown>[] = [];
  const redact = (text: string) => text.replaceAll(model.apiKey, '[redacted]');
  const json = (value: unknown) => JSON.stringify(value, (_key, value: unknown) => typeof value === 'string' ? redact(value) : value, 2) + '\n';
  const save = (name: string, value: unknown) => fs.writeFileSync(path.join(directory, name), json(value), { mode: 0o600 });
  const report = () => ({ schemaVersion: 1, syntheticOnly: true, passed, error, phase, requests, requestLimit: limit,
    model: { protocol: model.protocol, modelId: model.modelId, reasoningEffort: model.reasoningEffort ?? null }, stages, requestAudit,
    scope: ['temporary-plan cancellation plus bounded resident compression/retirement', 'protected state and concrete unfulfilled wish', 'archived version integrity and recovery entry', 'protected-only capacity refusal', 'resident-only recall after restart'],
    limitations: ['Cancellation and capacity pressure are combined; this does not isolate capacity-only forgetting', 'One fixed synthetic pressure sequence; not a complete longitudinal forgetting benchmark', 'Retention scores are reported rather than treated as a calibrated fixed scale', 'Rejections caused by request or time limits do not count as protected-overflow verification'] });
  const quiet = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | (() => void), callback?: () => void) => {
    const text = redact(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')); const size = Buffer.byteLength(text);
    if (logBytes + size <= 1048576) { fs.appendFileSync(path.join(directory, 'runtime.log'), text, { mode: 0o600 }); logBytes += size; }
    queueMicrotask(() => (typeof encodingOrCallback === 'function' ? encodingOrCallback : callback)?.()); return true;
  }) as typeof process.stdout.write;
  process.stdout.write = quiet; process.stderr.write = quiet; process.env.TMPDIR = temp;
  globalThis.fetch = async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : input);
    check(target.origin === modelURL.origin && (target.pathname === basePath || target.pathname.startsWith(basePath + '/')), 'unexpected_network_destination');
    check(++attempts <= limit, 'request_limit'); shutdown.signal.throwIfAborted(); round?.signal.throwIfAborted();
    const audit = { n: ++requests, phase, status: 0 }; requestAudit.push(audit); save('result.json', report());
    const response = await actualFetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(120000), ...(round ? [round.signal] : []), ...(init?.signal ? [init.signal] : []), ...(input instanceof Request ? [input.signal] : [])]) }); audit.status = response.status; return response;
  };
  const inRound = async <T>(label: string, action: () => Promise<T>): Promise<T> => {
    phase = label; round = new AbortController(); timer = setTimeout(() => round!.abort(), roundTimeout);
    stdout.call(process.stdout, JSON.stringify({ phase, requests, output: directory }) + '\n');
    try { return await action(); } finally { clearTimeout(timer); timer = undefined; round = undefined; save('result.json', report()); }
  };
  const until = async <T>(read: () => T, ready: (value: T) => boolean): Promise<T> => {
    const deadline = Date.now() + roundTimeout;
    while (Date.now() < deadline) { round?.signal.throwIfAborted(); shutdown.signal.throwIfAborted(); const value = read(); if (ready(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new ProbeError('round_timeout');
  };
  const active = (entries: readonly MemoryEntry[]) => entries.filter((entry): entry is Extract<MemoryEntry, { format: 'reviewed' }> => entry.format === 'reviewed' && ['current', 'unresolved'].includes(entry.lifecycle) && entry.placement === 'resident');
  const low = (entry: MemoryEntry) => /银色笔筒|绿色记事簿|便签|讲座录音|文件名|包装|小礼物/.test(entry.text) && !/望远镜|月球/.test(entry.text);
  const highValue = (entries: readonly MemoryEntry[]) => {
    const current = active(entries);
    check(current.some(entry => entry.protection.mode === 'state' && /离线/.test(entry.text)), 'protected_environment_lost');
    check(current.some(entry => entry.nature === 'intent' && /望远镜/.test(entry.text) && /月球/.test(entry.text) && /环形山/.test(entry.text) && /未|没|尚|待/.test(entry.text) && entry.followup.outcome !== 'confirmed-success'), 'concrete_unfulfilled_wish_lost');
  };
  try {
    const { Core: CoreConstructor } = await import('../src/core.js'); const { createDefaultMemoryContextPolicy } = await import('../src/memory/v1/policy.js');
    const { measureMemoryText } = await import('../src/memory/v1/tokens.js');
    let policy = createDefaultMemoryContextPolicy();
    core = await CoreConstructor.open({ dataDir, modelConfig: model, memoryContextMode: 'v1', memoryContextPolicy: policy, memoryEnabled: true, concurrency: 1, maxSteps: 16 });
    core.configure('runtime', { memoryContextMode: 'v1', memoryEnabled: true });
    const namespace = `pressure:${randomUUID()}`;
    const organize = async (nodes: number) => {
      const receipt = await core!.importMemory({ archivePath, namespace, sourceRef: 'synthetic', conversation: { index: 0 }, maxNodes: nodes, organize: true, expectedHead: core!.projectMemory.version().id }, round?.signal);
      check('job' in receipt && receipt.job, 'native_import_job_missing');
      const job = await until(() => core!.projectMemory.jobs().find(row => row.id === receipt.job!.id), value => !!value && !['pending', 'running'].includes(value.status));
      check(job?.nativeTaskId, 'native_import_binding_missing');
      const usage = core!.store.db.prepare("SELECT data FROM runtime_events WHERE run_id=? AND kind='memory_usage'").all(job.runId).map(row => JSON.parse(String(row.data)) as { role: string });
      if (job.status === 'succeeded') {
        check(usage.some(row => row.role === 'memory') && usage.some(row => row.role === 'memory-review'), 'independent_review_not_observed');
        check(core!.store.db.prepare('SELECT job_id FROM memory_v1_processing WHERE job_id=?').get(job.id), 'sqlite_publication_not_observed');
      }
      check(core!.store.db.prepare('SELECT COUNT(*) AS n FROM signals').get()!.n === 0, 'historical_import_became_native_input');
      save(`${phase}-native.json`, { job, usage }); return job;
    };
    await inRound('permanent-baseline', async () => {
      const job = await organize(3); check(job.status === 'succeeded', `permanent_baseline_${job.error ?? 'failed'}`);
      const published = core!.projectMemory.readV1Version(core!.projectMemory.version().id); highValue(published.workspace.candidate.entries);
      save('permanent-baseline-published.json', published);
      stages.push({ phase, status: 'pass', version: published.manifest.id, residentTokens: published.draft.measurement.textTokens });
    });
    const first = await inRound('baseline', async () => {
      const job = await organize(7); check(job.status === 'succeeded', `baseline_${job.error ?? 'failed'}`);
      const published = core!.projectMemory.readV1Version(core!.projectMemory.version().id); highValue(published.workspace.candidate.entries);
      const transient = active(published.workspace.candidate.entries).filter(low);
      check(transient.length > 0, 'pressure_setup_transients_not_retained');
      save('baseline-published.json', published);
      stages.push({ phase, status: 'pass', version: published.manifest.id, residentTokens: published.draft.measurement.textTokens, temporaryEntries: transient.length, temporaryRetentionScores: transient.map(entry => entry.retention.score), requiredTokens: published.draft.diagnostics.requiredSubsetMeasurement.textTokens }); return published;
    });
    const target = Math.max(512, first.draft.diagnostics.requiredSubsetMeasurement.textTokens + 256, Math.floor(first.draft.measurement.textTokens * .65));
    check(target + 100 < first.draft.measurement.textTokens, 'pressure_setup_insufficient_resident_size');
    policy = { ...policy, revision: policy.revision + 1, resident: { ...policy.resident, textTokens: target } };
    core.configure('runtime', { memoryContextPolicy: policy });
    const compressed = await inRound('resident-pressure', async () => {
      const job = await organize(8); check(job.status === 'succeeded', `pressure_${job.error ?? 'failed'}`);
      const published = core!.projectMemory.readV1Version(core!.projectMemory.version().id); highValue(published.workspace.candidate.entries);
      check(published.draft.measurement.textTokens <= target, 'resident_budget_exceeded');
      const before = active(first.workspace.candidate.entries).filter(low), after = active(published.workspace.candidate.entries).filter(low);
      const beforeTokens = before.reduce((total, entry) => total + measureMemoryText(entry.text).textTokens, 0), afterTokens = after.reduce((total, entry) => total + measureMemoryText(entry.text).textTokens, 0);
      check(afterTokens + 20 < beforeTokens || after.length < before.length, 'temporary_information_not_compressed_or_retired');
      const old = core!.projectMemory.readV1Version(first.manifest.id); check(old.manifestHash === first.manifestHash && old.finalText === first.finalText, 'old_version_changed');
      const plan = core!.planMemoryV1Recovery(first.manifest.id, published.manifest.id);
      save('compressed-published.json', published); save('recovery-plan.json', plan);
      stages.push({ phase, status: 'pass', version: published.manifest.id, budget: target, residentTokens: published.draft.measurement.textTokens, beforeTemporaryTokens: beforeTokens, afterTemporaryTokens: afterTokens, oldVersionUnchanged: true, recoveryPlanId: plan.id }); return published;
    });
    await inRound('recovery-entry', async () => {
      const plan = core!.planMemoryV1Recovery(first.manifest.id, compressed.manifest.id);
      try {
        const admitted = await core!.executeMemoryV1Recovery(plan.id);
        const job = await until(() => core!.projectMemory.jobs().find(row => row.id === admitted.id), value => !!value && !['pending', 'running'].includes(value.status));
        check(job?.status === 'succeeded', 'recovery_execution_failed');
        highValue(core!.projectMemory.readV1Version(core!.projectMemory.version().id).workspace.candidate.entries);
        stages.push({ phase, status: 'pass', jobId: job.id });
      } catch (failure) {
        const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : failure instanceof ProbeError ? failure.code : 'recovery_failed';
        stages.push({ phase, status: 'fail', code }); save('recovery-entry.json', { code });
        // Preserve this result while still checking independent overflow and resident-recall boundaries.
      }
    });
    const beforeConflict = core.projectMemory.version();
    policy = { ...policy, revision: policy.revision + 1, resident: { ...policy.resident, textTokens: 1 }, organization: { ...policy.organization, maxCapacityCorrections: 1 } };
    core.configure('runtime', { memoryContextPolicy: policy });
    await inRound('protected-overflow', async () => {
      const job = await organize(9); check(job.status === 'failed' && job.error === 'memory_capacity_conflict', 'protected_overflow_not_verified');
      check(JSON.stringify(core!.projectMemory.version()) === JSON.stringify(beforeConflict), 'protected_overflow_changed_head');
      const persisted = core!.projectMemory.readV1Version(beforeConflict.id); highValue(persisted.workspace.candidate.entries);
      stages.push({ phase, status: 'pass', error: job.error, oldHeadUnchanged: true, requiredTokens: persisted.draft.diagnostics.requiredSubsetMeasurement.textTokens, budget: 1 });
    });
    policy = { ...policy, revision: policy.revision + 1, resident: { ...policy.resident, textTokens: target }, recent: { ...policy.recent, textTokens: 1 } };
    core.configure('runtime', { memoryContextPolicy: policy, memoryEnabled: false });
    await inRound('resident-only-restart', async () => {
      const head = core!.projectMemory.version().id, instance = core!.instanceId; await core!.close(); core = undefined;
      core = await CoreConstructor.open({ dataDir, modelConfig: model, memoryContextMode: 'v1', memoryContextPolicy: policy, memoryEnabled: false, concurrency: 1, maxSteps: 16 });
      check(core.instanceId !== instance && core.projectMemory.version().id === head, 'restart_head_changed');
      const contextId = `pressure.recall.${randomUUID()}`; core.createConversationContext({ id: contextId, name: 'pressure recall' }); const eventStart = core.runtime.eventHead();
      const signal = await core.submitMessage({ contextId, content: '这台工作站现在能否直接联网下载？我用望远镜拍月球的具体愿望已经实现了吗？只根据已有记忆回答，不翻阅旧对话、不安排或执行。' }); check(signal.runId, 'recall_missing');
      const run = await until(() => core!.store.getRun(signal.runId!), value => !!value && value.status !== 'running'); check(run?.status === 'succeeded', 'resident_recall_failed');
      const view = core.memoryV1RunView(signal.runId); check(view?.injected && view.recent.selected.length === 0 && view.recent.finalText === '', 'recent_originals_leaked');
      const tools = core.store.db.prepare("SELECT data FROM runtime_events WHERE seq>? AND kind='tool_start'").all(eventStart).map(row => JSON.parse(String(row.data)) as { toolName: string }); check(tools.every(tool => tool.toolName === 'emit_message'), 'recall_used_other_sources');
      const outputs = core.store.outputsForSignal(signal.id), answer = outputs.map(row => row.content).join('\n');
      check(/离线|不能|无法|不[可能]/.test(answer) && /望远镜/.test(answer) && /月球/.test(answer) && /环形山/.test(answer) && /未|没|尚|待/.test(answer), 'resident_recall_semantics_failed');
      check(core.runtime.tasks().length === 0 && core.runtime.approvals().length === 0, 'unexpected_actions'); save('resident-recall.json', { view, outputs, tools });
      stages.push({ phase, status: 'pass', version: head, recentRecords: 0 });
    });
    passed = stages.every(stage => stage.status === 'pass'); if (!passed) error = 'one_or_more_pressure_checks_failed'; phase = 'complete';
  } catch (failure) {
    error = failure instanceof ProbeError ? failure.code : 'pressure_probe_failed'; stages.push({ phase, status: 'fail', error });
  } finally {
    clearTimeout(timer); shutdown.abort(); try { await core?.close(); } catch { passed = false; error = 'core_cleanup_failed'; }
    globalThis.fetch = actualFetch; process.stdout.write = stdout; process.stderr.write = stderr; if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
    save('result.json', report()); if (!passed) process.exitCode = 1; console.log(JSON.stringify({ passed, error, requests, output: directory }));
  }
}
try { await main(); } catch (error) { console.error(JSON.stringify({ passed: false, error: error instanceof ProbeError ? error.code : 'pressure_setup_failed' })); process.exitCode = 1; }
