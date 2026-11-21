import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { evidenceRecordSchema } from './contracts.js';
import type { EvidenceRecord } from './contracts.js';
import { MemoryEvidenceLedger } from './ledger.js';
import type { PreparedMemorySource } from './source.js';
import type { RecentRecordInput } from './recent.js';
import { evidenceIdempotencyKey } from './validate.js';
import { compareMemoryV1Time } from './version-index.js';
import { MemoryImportError, parseChatExportJson, readChatExportZipMember, readChatExportZipAssets } from './import-zip.js';
import type { ChatExportZipOptions } from './import-zip.js';
export { MemoryImportError, readChatExportZipMember, readChatExportZipAssets, parseChatExportJson } from './import-zip.js';

export interface ChatExportPrefixOptions {
  namespace: string;
  sourceRef: string;
  /** Conversation ID is preferred for repeatable selection; index is local to the selected shard. */
  conversation: { id: string } | { index: number };
  /** Select a branch explicitly; omitted uses the export's current_node. */
  branchLeafId?: string;
  maxNodes: number;
  receivedAt: string;
  /** Historical event cutoff; does not replace the host's actual receipt clock. */
  replayUntil?: string;
  /** Explicit host-supplied local asset bytes; locators alone never establish content identity. */
  assets?: readonly { locator: string; mediaType: string; bytes: Uint8Array }[];
}
interface HistoricalMessage {
  nodeId: string;
  messageId: string;
  raw: Record<string, unknown>;
  role: string;
  occurredAt: string | null;
  contentType: string;
  parts: unknown[];
  fingerprint: string;
}
export interface ChatExportPrefix {
  contextId: string;
  messages: readonly HistoricalMessage[];
  releasedNodes: number;
  stopped: 'node-limit' | 'time-cutoff' | 'unknown-time' | 'end';
}
export interface ChatExportImportResult {
  preparedSource: PreparedMemorySource;
  recentRecords: RecentRecordInput[];
  supportGroups: { ref: { evidenceId: string; partKey: string }; group: string }[];
  counts: { releasedNodes: number; archivedMessages: number; evidenceRecords: number; excludedMessages: number; unavailableParts: number; duplicateMessages: number };
  stopped: ChatExportPrefix['stopped'];
  scopeId: string;
}
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const timeFunctionsRegistered = new WeakSet<DatabaseSync>();
function preciseTimeParts(value: unknown): { seconds: number; fraction: string } {
  if (typeof value !== 'string' || !evidenceRecordSchema.shape.receivedAt.safeParse(value).success) throw new MemoryImportError('identity');
  return { seconds: Math.floor(Date.parse(value) / 1000), fraction: (/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] ?? '').replace(/0+$/, '') };
}
const hostId = (prefix: string, value: unknown) => `${prefix}:${digest(canonical(value))}`;
const importBatchSchema = z.strictObject({
  schemaVersion: z.literal(1), namespace: z.string(), sourceRef: z.string(), contextRef: z.string(),
  source: z.strictObject({ contextId: z.string(), runId: z.string(), sequence: z.number().int().nonnegative() }),
  messages: z.array(z.strictObject({ messageId: z.string(), messageRef: z.string(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), receivedAt: evidenceRecordSchema.shape.receivedAt })).max(512),
  requiredEvidenceIds: z.array(z.string()).max(131072),
});
type ImportBatch = z.infer<typeof importBatchSchema>;
function validateJson(value: unknown): void {
  const queue: { value: unknown; depth: number }[] = [{ value, depth: 0 }]; const seen = new Set<object>(); let count = 0;
  while (queue.length) {
    const item = queue.pop()!;
    if (++count > 100_000 || item.depth > 64) throw new MemoryImportError('limit');
    const current = item.value;
    if (current === null || typeof current === 'boolean') continue;
    if (typeof current === 'string') { if (utf8(current).length > 4 * 1024 * 1024) throw new MemoryImportError('limit'); continue; }
    if (typeof current === 'number') { if (!Number.isFinite(current)) throw new MemoryImportError('format'); continue; }
    if (typeof current !== 'object' || seen.has(current)) throw new MemoryImportError('format');
    seen.add(current);
    for (const child of Object.values(current)) queue.push({ value: child, depth: item.depth + 1 });
  }
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const item = value as Record<string, unknown>;
  return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key])}`).join(',')}}`;
}
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function utf8(text: string): Buffer {
  const bytes = Buffer.from(text);
  if (bytes.toString('utf8') !== text) throw new MemoryImportError('format');
  return bytes;
}
function time(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Decimal arithmetic preserves the source Number's canonical decimal value, including sub-millisecond and negative epochs.
    const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(value));
    if (!match) throw new MemoryImportError('format');
    const fraction = match[3] ?? '';
    const exponent = Number(match[4] ?? 0);
    const scale = fraction.length - exponent;
    let magnitude = BigInt(match[2]! + fraction);
    const denominator = scale > 0 ? 10n ** BigInt(scale) : 1n;
    if (scale < 0) magnitude *= 10n ** BigInt(-scale);
    let seconds = magnitude / denominator;
    let remainder = magnitude % denominator;
    if (match[1] === '-') {
      seconds = -seconds;
      if (remainder !== 0n) { seconds--; remainder = denominator - remainder; }
    }
    if (seconds < -8_640_000_000_000n || seconds > 8_640_000_000_000n) throw new MemoryImportError('format');
    const base = new Date(Number(seconds) * 1000).toISOString();
    const decimals = remainder === 0n ? '000' : remainder.toString().padStart(Math.max(scale, 0), '0').replace(/0+$/, '');
    const result = base.replace(/\.000Z$/, `.${decimals}Z`);
    if (!evidenceRecordSchema.shape.receivedAt.safeParse(result).success) throw new MemoryImportError('format');
    return result;
  }
  if (typeof value === 'string' && evidenceRecordSchema.shape.receivedAt.safeParse(value).success) return value;
  throw new MemoryImportError('format');
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && utf8(value).length <= 1024;
}
function hostOptions(options: ChatExportPrefixOptions): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(options.namespace) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(options.sourceRef)
    || !Number.isSafeInteger(options.maxNodes) || options.maxNodes < 1 || options.maxNodes > 512
    || !evidenceRecordSchema.shape.receivedAt.safeParse(options.receivedAt).success
    || options.replayUntil !== undefined && !evidenceRecordSchema.shape.receivedAt.safeParse(options.replayUntil).success) throw new MemoryImportError('input');
}
/** Projects a contiguous historical path. Hidden sibling/future message contents never enter the result. */
export function prepareChatExportPrefix(document: unknown, options: ChatExportPrefixOptions): ChatExportPrefix {
  hostOptions(options);
  if (!Array.isArray(document) || document.length > 10_000) throw new MemoryImportError('format');
  let conversation: unknown;
  if ('id' in options.conversation) {
    const id = options.conversation.id;
    const matches = document.filter(item => isObject(item) && (item.conversation_id ?? item.id) === id);
    if (matches.length !== 1) throw new MemoryImportError('identity');
    conversation = matches[0];
  } else {
    const index = options.conversation.index;
    if (!Number.isSafeInteger(index) || index < 0) throw new MemoryImportError('input');
    conversation = document[index];
  }
  if (!isObject(conversation) || !validId(conversation.conversation_id ?? conversation.id) || !isObject(conversation.mapping)) throw new MemoryImportError('format');
  if (conversation.conversation_id !== undefined && conversation.id !== undefined && conversation.conversation_id !== conversation.id) throw new MemoryImportError('identity');
  const mapping = conversation.mapping;
  const entries = Object.entries(mapping);
  const parentChildren = new Map<string, Set<unknown>>();
  if (!entries.length || entries.length > 100_000) throw new MemoryImportError('limit');
  // Validate the graph before releasing it. Hidden structural damage may reject preparation.
  for (const [id, node] of entries) {
    if (!validId(id) || !isObject(node) || node.id !== id || !(node.parent === null || validId(node.parent)) || node.children !== undefined && (!Array.isArray(node.children)
      || node.children.length > 100_000 || new Set(node.children).size !== node.children.length)) throw new MemoryImportError('graph');
    if (node.parent !== null && !Object.hasOwn(mapping, node.parent as string)) throw new MemoryImportError('graph');
    for (const child of node.children as unknown[] ?? []) {
      if (!validId(child) || !isObject(mapping[child]) || mapping[child].parent !== id) throw new MemoryImportError('graph');
    }
    if (node.parent !== null) {
      const parent = mapping[node.parent as string];
      if (!isObject(parent) || parent.children !== undefined && !Array.isArray(parent.children)) throw new MemoryImportError('graph');
      if (Array.isArray(parent.children)) {
        let children = parentChildren.get(node.parent as string);
        if (!children) { children = new Set(parent.children); parentChildren.set(node.parent as string, children); }
        if (!children.has(id)) throw new MemoryImportError('graph');
      }
    }
  }
  const leaf = options.branchLeafId ?? conversation.current_node;
  if (!validId(leaf) || !Object.hasOwn(mapping, leaf)) throw new MemoryImportError('graph');
  const path: string[] = []; const seen = new Set<string>(); let cursor: string | null = leaf;
  while (cursor !== null) {
    if (seen.has(cursor)) throw new MemoryImportError('graph');
    seen.add(cursor); path.push(cursor); cursor = (mapping[cursor] as Record<string, unknown>).parent as string | null;
  }
  path.reverse();
  const messages: HistoricalMessage[] = []; const identities = new Map<string, string>();
  let releasedNodes = 0; let stopped: ChatExportPrefix['stopped'] = 'end'; let totalBytes = 0;
  for (const nodeId of path) {
    if (releasedNodes >= options.maxNodes) { stopped = 'node-limit'; break; }
    const node = mapping[nodeId] as Record<string, unknown>; const raw = node.message;
    if (raw === null) { releasedNodes++; continue; }
    if (!isObject(raw) || !validId(raw.id) || !isObject(raw.author) || typeof raw.author.role !== 'string' || !isObject(raw.content) || typeof raw.content.content_type !== 'string') throw new MemoryImportError('format');
    const occurredAt = time(raw.create_time);
    if (options.replayUntil !== undefined) {
      if (occurredAt === null) { stopped = 'unknown-time'; break; }
      if (compareMemoryV1Time(occurredAt, options.replayUntil) > 0) { stopped = 'time-cutoff'; break; }
    }
    validateJson(raw);
    const serialized = canonical(raw); totalBytes += utf8(serialized).length;
    if (totalBytes > 8 * 1024 * 1024) throw new MemoryImportError('limit');
    const fingerprint = digest(serialized);
    const prior = identities.get(raw.id);
    if (prior && prior !== fingerprint) throw new MemoryImportError('identity');
    identities.set(raw.id, fingerprint);
    const parts = raw.content.parts;
    if (parts !== undefined && (!Array.isArray(parts) || parts.length > 256)) throw new MemoryImportError('format');
    // Snapshot the released values so a caller cannot mutate an already prepared prefix through its source object.
    messages.push({ nodeId, messageId: raw.id, raw: JSON.parse(serialized) as Record<string, unknown>, role: raw.author.role,
      occurredAt, contentType: raw.content.content_type, parts: structuredClone(Array.isArray(parts) ? parts : typeof raw.content.text === 'string' ? [raw.content.text] : [raw.content]), fingerprint });
    releasedNodes++;
  }
  return { contextId: conversation.conversation_id as string ?? conversation.id as string, messages, releasedNodes, stopped };
}

/** Historical import registry and ledger share the caller's SQLite transaction; no native receipt is created. */
export class MemoryChatExportImporter {
  readonly #ledger: MemoryEvidenceLedger;
  constructor(readonly db: DatabaseSync) {
    if (!timeFunctionsRegistered.has(db)) {
      db.function('memory_import_epoch_second', { deterministic: true }, value => preciseTimeParts(value).seconds);
      db.function('memory_import_second_fraction', { deterministic: true }, value => preciseTimeParts(value).fraction);
      timeFunctionsRegistered.add(db);
    }
    this.#ledger = new MemoryEvidenceLedger(db);
    db.exec(`CREATE TABLE IF NOT EXISTS memory_v1_import_messages (
      namespace TEXT NOT NULL, source_ref TEXT NOT NULL, context_ref TEXT NOT NULL, message_ref TEXT NOT NULL,
      message_hash TEXT NOT NULL, raw_json TEXT NOT NULL, received_at TEXT NOT NULL,
      PRIMARY KEY(namespace,source_ref,context_ref,message_ref)
    ); CREATE TABLE IF NOT EXISTS memory_v1_import_evidence (
      namespace TEXT NOT NULL, source_ref TEXT NOT NULL, context_ref TEXT NOT NULL, message_ref TEXT NOT NULL,
      part_index INTEGER NOT NULL, evidence_id TEXT NOT NULL UNIQUE,
      PRIMARY KEY(namespace,source_ref,context_ref,message_ref,part_index)
    ); CREATE TABLE IF NOT EXISTS memory_v1_import_batches (
      run_id TEXT PRIMARY KEY, batch_json TEXT NOT NULL, batch_hash TEXT NOT NULL
    )`);
  }
  async importZip(options: ChatExportZipOptions & ChatExportPrefixOptions): Promise<ChatExportImportResult> {
    const selected = await readChatExportZipMember(options);
    const document = parseChatExportJson(selected.bytes);
    const prefix = prepareChatExportPrefix(document, options);
    const existing = new Set(options.assets?.map(asset => asset.locator));
    const requests = prefix.messages.filter(message => ['user', 'assistant', 'tool'].includes(message.role) && ['text', 'multimodal_text'].includes(message.contentType)).flatMap(message => message.parts.flatMap(part => {
      if (!isObject(part) || part.content_type !== 'image_asset_pointer' || typeof part.asset_pointer !== 'string' || typeof part.mime_type !== 'string' || existing.has(part.asset_pointer)) return [];
      return [{ locator: part.asset_pointer, mediaType: part.mime_type, ...(typeof part.size_bytes === 'number' ? { expectedBytes: part.size_bytes } : {}) }];
    }));
    const local = requests.length ? await readChatExportZipAssets({ ...options, expectedArchiveIdentity: selected.archiveIdentity }, requests) : { assets: [], gaps: [] };
    return this.importDocument(document, { ...options, assets: [...options.assets ?? [], ...local.assets] });
  }
  importDocument(document: unknown, options: ChatExportPrefixOptions): ChatExportImportResult {
    const prefix = prepareChatExportPrefix(document, options);
    const savepoint = `import_${randomUUID().replaceAll('-', '')}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = this.admit(prefix, options);
      this.rememberBatch(prefix, options, result);
      this.db.exec(`RELEASE ${savepoint}`); return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${savepoint}`); this.db.exec(`RELEASE ${savepoint}`); throw error;
    }
  }
  scopes(): string[] {
    return [...new Set(this.db.prepare('SELECT DISTINCT namespace,source_ref FROM memory_v1_import_messages').all().map(row => hostId('import-scope', [row.namespace, row.source_ref])))];
  }
  runs(): string[] {
    return this.db.prepare('SELECT run_id FROM memory_v1_import_batches ORDER BY rowid').all().map(row => String(row.run_id));
  }
  private batch(runId: string): ImportBatch | null {
    const row = this.db.prepare('SELECT * FROM memory_v1_import_batches WHERE run_id=?').get(runId);
    if (!row) return null;
    if (typeof row.batch_json !== 'string' || row.batch_json.length > 32 * 1024 * 1024 || digest(row.batch_json) !== row.batch_hash) throw new MemoryImportError('identity');
    let batch: ImportBatch;
    try { batch = importBatchSchema.parse(JSON.parse(row.batch_json)); } catch { throw new MemoryImportError('identity'); }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(batch.namespace) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(batch.sourceRef)
      || batch.source.runId !== runId || batch.contextRef !== batch.source.contextId || batch.source.sequence < batch.messages.length
      || batch.messages.some(message => !validId(message.messageId) || message.messageRef !== hostId('import-message', message.messageId))
      || runId !== hostId('import-prefix', [batch.namespace, batch.sourceRef, batch.contextRef, batch.messages.map(message => message.messageId)])) throw new MemoryImportError('identity');
    return batch;
  }
  private rememberBatch(prefix: ChatExportPrefix, options: ChatExportPrefixOptions, result: ChatExportImportResult): void {
    const source = result.preparedSource;
    const batch: ImportBatch = { schemaVersion: 1, namespace: options.namespace, sourceRef: options.sourceRef, contextRef: source.source.contextId,
      source: { ...source.source, runId: source.source.runId! }, messages: prefix.messages.map(message => {
        const messageRef = hostId('import-message', message.messageId);
        const row = this.db.prepare('SELECT received_at FROM memory_v1_import_messages WHERE namespace=? AND source_ref=? AND context_ref=? AND message_ref=?')
          .get(options.namespace, options.sourceRef, source.source.contextId, messageRef);
        if (typeof row?.received_at !== 'string') throw new MemoryImportError('identity');
        return { messageId: message.messageId, messageRef, fingerprint: message.fingerprint, receivedAt: row.received_at };
      }), requiredEvidenceIds: source.records.map(record => record.id).sort() };
    const previous = this.batch(batch.source.runId);
    if (previous) {
      if (canonical({ ...previous, requiredEvidenceIds: [] }) !== canonical({ ...batch, requiredEvidenceIds: [] })) throw new MemoryImportError('identity');
      batch.requiredEvidenceIds = [...new Set([...previous.requiredEvidenceIds, ...batch.requiredEvidenceIds])].sort();
    }
    const payload = canonical(importBatchSchema.parse(batch));
    const changed = this.db.prepare('INSERT INTO memory_v1_import_batches VALUES (?,?,?) ON CONFLICT(run_id) DO UPDATE SET batch_json=excluded.batch_json,batch_hash=excluded.batch_hash')
      .run(batch.source.runId, payload, digest(payload));
    if (Number(changed.changes) !== 1 || canonical(this.batch(batch.source.runId)) !== payload) throw new MemoryImportError('identity');
  }
  /** Rebuild only a host-registered prefix from independently retained raw records, indices and ledger slots. */
  readSource(runId: string): { preparedSource: PreparedMemorySource; scopeId: string } | null {
    const batch = this.batch(runId);
    if (!batch) return null;
    const scopeId = hostId('import-scope', [batch.namespace, batch.sourceRef]);
    const source: PreparedMemorySource = { source: { ...batch.source }, records: [], observations: [], contents: new Map(), gaps: [], canonicalRefs: new Map(), attachmentRefs: new Map() };
    const seen = new Set<string>(), found = new Set<string>(), required = new Set(batch.requiredEvidenceIds);
    for (const message of batch.messages) {
      const row = this.db.prepare('SELECT * FROM memory_v1_import_messages WHERE namespace=? AND source_ref=? AND context_ref=? AND message_ref=?')
        .get(batch.namespace, batch.sourceRef, batch.contextRef, message.messageRef);
      if (!row || typeof row.raw_json !== 'string' || row.message_hash !== message.fingerprint || digest(row.raw_json) !== message.fingerprint || row.received_at !== message.receivedAt) throw new MemoryImportError('identity');
      let raw: Record<string, unknown>;
      try { raw = JSON.parse(row.raw_json) as Record<string, unknown>; } catch { throw new MemoryImportError('identity'); }
      if (!isObject(raw) || raw.id !== message.messageId || !isObject(raw.author) || typeof raw.author.role !== 'string' || !isObject(raw.content) || typeof raw.content.content_type !== 'string') throw new MemoryImportError('identity');
      const role = raw.author.role, contentType = raw.content.content_type, occurredAt = time(raw.create_time);
      if (seen.has(message.messageRef)) continue; seen.add(message.messageRef);
      if (!['user', 'assistant', 'tool'].includes(role)) continue;
      if (!['text', 'multimodal_text', 'code', 'execution_output', 'audio_transcription'].includes(contentType)) {
        if (!['thoughts', 'reasoning_recap'].includes(contentType)) source.gaps.push({ contextId: batch.contextRef, messageId: message.messageRef, reason: 'missing-source' });
        continue;
      }
      const parts = Array.isArray(raw.content.parts) ? raw.content.parts : typeof raw.content.text === 'string' ? [raw.content.text] : [raw.content];
      for (const [index, part] of parts.entries()) {
        const id = hostId('import-evidence', [batch.namespace, batch.sourceRef, batch.contextRef, message.messageRef, index]);
        const indexed = this.db.prepare('SELECT * FROM memory_v1_import_evidence WHERE namespace=? AND source_ref=? AND context_ref=? AND message_ref=? AND part_index=?')
          .get(batch.namespace, batch.sourceRef, batch.contextRef, message.messageRef, index);
        const transcriptionText = isObject(part) && part.content_type === 'audio_transcription' && typeof part.text === 'string' ? part.text : contentType === 'audio_transcription' && typeof part === 'string' ? part : null;
        const transcription = transcriptionText !== null && transcriptionText.trim().length > 0;
        const textPart = contentType !== 'audio_transcription' && (typeof part === 'string' || isObject(part) && part.content_type === 'text' && typeof part.text === 'string');
        const locator = isObject(part) && part.content_type === 'image_asset_pointer' && typeof part.asset_pointer === 'string' ? part.asset_pointer : null;
        if (!indexed) {
          if (textPart || transcription || required.has(id)) throw new MemoryImportError('identity');
          source.gaps.push({ contextId: batch.contextRef, messageId: id, reason: 'missing-source' }); continue;
        }
        if (indexed.evidence_id !== id || !textPart && !transcription && !locator) throw new MemoryImportError('identity');
        const record = this.#ledger.readEvidence(id);
        const kind = role === 'user' ? 'user-statement' : role === 'assistant' ? 'assistant-statement' : 'tool-result';
        if (!record || record.origin.system !== 'import' || record.origin.namespace !== batch.namespace || record.origin.sourceRef !== batch.sourceRef
          || record.origin.contextRef !== batch.contextRef || record.origin.lineageRoot !== message.messageRef || record.origin.recordRef !== hostId('import-record', [message.messageRef, index])
          || record.origin.capture !== 'historical-record' || record.kind !== kind || record.actor !== role || record.receivedAt !== message.receivedAt || record.visibleAfter !== message.receivedAt
          || record.occurredAt !== occurredAt || record.timeBasis !== (occurredAt === null ? 'unknown' : 'source-metadata') || record.contentRef !== hostId('import-content', id)
          || record.operationRef !== null || record.derivedFrom.length) throw new MemoryImportError('identity');
        const originalText = transcription ? null : typeof part === 'string' ? part : textPart ? (part as { text: string }).text : null;
        const expectedBody = originalText !== null ? utf8(originalText) : utf8(canonical(transcription ? { type: 'historical-transcription', text: transcriptionText, confirmation: 'unconfirmed', originalAudio: 'unavailable' } : part));
        const body = this.#ledger.readContent(id), bytes = typeof body === 'string' ? utf8(body) : body;
        if (digest(expectedBody) !== record.contentHash || !Buffer.from(bytes).equals(expectedBody)) throw new MemoryImportError('identity');
        const attachments: { sourceId: string; bytes: Uint8Array }[] = [];
        if (locator) {
          const attachment = record.attachments[0], sourceId = hostId('import-asset', [batch.namespace, batch.sourceRef, locator]);
          if (!attachment || record.attachments.length !== 1 || attachment.sourceId !== sourceId || attachment.derivedEvidenceIds.length
            || !isObject(part) || part.mime_type !== undefined && part.mime_type !== attachment.mediaType || part.size_bytes !== undefined && part.size_bytes !== attachment.bytes) throw new MemoryImportError('identity');
          const stored = this.#ledger.readContent(id, sourceId), asset = typeof stored === 'string' ? utf8(stored) : stored;
          if (digest(asset) !== attachment.sha256 || asset.length !== attachment.bytes) throw new MemoryImportError('identity');
          attachments.push({ sourceId, bytes: new Uint8Array(asset) }); source.attachmentRefs.set(sourceId, { assetId: sourceId, name: null });
        } else if (record.attachments.length) throw new MemoryImportError('identity');
        const bindings = [{ partKey: 'body', slots: [{ kind: 'body' as const, ref: record.contentRef }, ...attachments.map(attachment => ({ kind: 'attachment' as const, ref: attachment.sourceId }))] }];
        const receipt = this.db.prepare('SELECT receipt_json FROM memory_v1_receipts WHERE id=?').get(hostId('import-receipt', [batch.namespace, batch.sourceRef, batch.contextRef, id]));
        let received: Record<string, unknown>;
        try { received = JSON.parse(String(receipt?.receipt_json)) as Record<string, unknown>; } catch { throw new MemoryImportError('identity'); }
        const normalizedBindings = bindings.map(binding => ({ ...binding, slots: [...binding.slots].sort((a, b) => canonical(a).localeCompare(canonical(b))) }));
        if (received.scopeId !== scopeId || canonical(received.partBindings) !== canonical(normalizedBindings)) throw new MemoryImportError('identity');
        source.records.push(record); found.add(id);
        source.contents.set(record.contentRef, { codec: originalText !== null ? 'utf8' : 'json-utf8', body: new Uint8Array(bytes), attachments, attachmentOrder: attachments.map(attachment => attachment.sourceId), partBindings: bindings });
        source.canonicalRefs.set(id, { contextId: batch.contextRef, runId: null, recordId: message.messageRef, receivedAt: message.receivedAt, visibleAfter: message.receivedAt, canonicalIdentity: evidenceIdempotencyKey(record) });
        if (transcription) source.gaps.push({ contextId: batch.contextRef, messageId: id, reason: 'missing-source' });
      }
    }
    if (batch.requiredEvidenceIds.some(id => !found.has(id))) throw new MemoryImportError('identity');
    return { preparedSource: source, scopeId };
  }
  recentRecords(options: { asOf: string; scopeIds: ReadonlySet<string>; limit?: number }): RecentRecordInput[] {
    const limit = options.limit ?? 1000;
    if (!evidenceRecordSchema.shape.receivedAt.safeParse(options.asOf).success || !options.scopeIds || typeof options.scopeIds.has !== 'function'
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new MemoryImportError('input');
    // Sort only identities and time metadata; historical message bodies are loaded individually after scope/cutoff filtering.
    const rows = this.db.prepare(`SELECT e.*, m.received_at,
      json_extract(v.record_json,'$.occurredAt') AS occurred_at,
      json_extract(v.record_json,'$.visibleAfter') AS visible_after
      FROM memory_v1_import_evidence e
      JOIN memory_v1_import_messages m USING(namespace,source_ref,context_ref,message_ref)
      JOIN memory_v1_evidence v ON v.id=e.evidence_id
      WHERE json_extract(v.record_json,'$.kind')='user-statement' AND json_extract(v.record_json,'$.actor')='user'
      ORDER BY memory_import_epoch_second(COALESCE(json_extract(v.record_json,'$.occurredAt'),m.received_at)) DESC,
        memory_import_second_fraction(COALESCE(json_extract(v.record_json,'$.occurredAt'),m.received_at)) DESC,e.evidence_id`).iterate();
    const result: RecentRecordInput[] = [];
    for (const row of rows) {
      if (!options.scopeIds.has(hostId('import-scope', [row.namespace, row.source_ref]))) continue;
      if (typeof row.received_at !== 'string' || !evidenceRecordSchema.shape.receivedAt.safeParse(row.received_at).success) throw new MemoryImportError('identity');
      if (compareMemoryV1Time(row.received_at, options.asOf) > 0) continue;
      if (typeof row.visible_after !== 'string' || !evidenceRecordSchema.shape.visibleAfter.safeParse(row.visible_after).success
        || row.occurred_at !== null && (typeof row.occurred_at !== 'string' || !evidenceRecordSchema.shape.occurredAt.safeParse(row.occurred_at).success)) throw new MemoryImportError('identity');
      if (compareMemoryV1Time(row.visible_after, options.asOf) > 0 || compareMemoryV1Time(row.occurred_at as string ?? row.received_at, options.asOf) > 0) continue;
      const rawRow = this.db.prepare(`SELECT raw_json,message_hash FROM memory_v1_import_messages WHERE namespace=? AND source_ref=? AND context_ref=? AND message_ref=?`)
        .get(String(row.namespace), String(row.source_ref), String(row.context_ref), String(row.message_ref));
      if (!rawRow || typeof rawRow.raw_json !== 'string' || digest(rawRow.raw_json) !== rawRow.message_hash) throw new MemoryImportError('identity');
      const evidence = this.#ledger.readEvidence(String(row.evidence_id));
      if (!evidence || evidence.origin.system !== 'import' || evidence.origin.namespace !== row.namespace || evidence.origin.sourceRef !== row.source_ref
        || evidence.origin.contextRef !== row.context_ref || evidence.origin.lineageRoot !== row.message_ref || evidence.receivedAt !== row.received_at
        || evidence.origin.recordRef !== hostId('import-record', [row.message_ref, row.part_index])) throw new MemoryImportError('identity');
      const raw = JSON.parse(rawRow.raw_json) as Record<string, unknown>;
      if (!isObject(raw.content) || !Number.isSafeInteger(row.part_index)) throw new MemoryImportError('identity');
      const parts = Array.isArray(raw.content.parts) ? raw.content.parts : typeof raw.content.text === 'string' ? [raw.content.text] : [raw.content];
      const part = parts[Number(row.part_index)];
      const original = raw.content.content_type === 'audio_transcription' ? null : typeof part === 'string' ? part : isObject(part) && part.content_type === 'text' && typeof part.text === 'string' ? part.text : null;
      const body = this.#ledger.readContent(evidence.id);
      if (original !== null && digest(utf8(original)) !== evidence.contentHash) throw new MemoryImportError('identity');
      const bytes = typeof body === 'string' ? utf8(body) : body;
      result.push({ evidence, originalTextBytes: original === null ? null : new Uint8Array(bytes), attachments: evidence.attachments.map(attachment => {
        const loaded = this.#ledger.readContent(evidence.id, attachment.sourceId);
        return { sourceId: attachment.sourceId, mediaType: attachment.mediaType, bytes: typeof loaded === 'string' ? utf8(loaded) : loaded };
      }) });
      if (result.length >= limit) break;
    }
    return result;
  }
  private admit(prefix: ChatExportPrefix, options: ChatExportPrefixOptions): ChatExportImportResult {
    const contextRef = hostId('import-context', prefix.contextId);
    const sourceRun = hostId('import-prefix', [options.namespace, options.sourceRef, contextRef, prefix.messages.map(message => message.messageId)]);
    const source: PreparedMemorySource = { source: { contextId: contextRef, runId: sourceRun, sequence: prefix.releasedNodes }, records: [], observations: [], contents: new Map(), gaps: [], canonicalRefs: new Map(), attachmentRefs: new Map() };
    const recentRecords: RecentRecordInput[] = [];
    const groups: ChatExportImportResult['supportGroups'] = [];
    const group = hostId('support', ['import', options.namespace, options.sourceRef]);
    const counts = { releasedNodes: prefix.releasedNodes, archivedMessages: 0, evidenceRecords: 0, excludedMessages: 0, unavailableParts: 0, duplicateMessages: 0 };
    const seen = new Set<string>(); const assetMap = new Map<string, { locator: string; mediaType: string; bytes: Uint8Array }>();
    let assetBytes = 0;
    for (const asset of options.assets ?? []) {
      if (!validId(asset.locator) || !asset.mediaType || !(asset.bytes instanceof Uint8Array) || asset.bytes.length > 32 * 1024 * 1024 || assetMap.has(asset.locator)) throw new MemoryImportError('input');
      assetBytes += asset.bytes.length; if (assetBytes > 64 * 1024 * 1024) throw new MemoryImportError('limit');
      assetMap.set(asset.locator, { ...asset, bytes: new Uint8Array(asset.bytes) });
    }
    for (const message of prefix.messages) {
      const messageRef = hostId('import-message', message.messageId);
      const old = this.db.prepare('SELECT * FROM memory_v1_import_messages WHERE namespace=? AND source_ref=? AND context_ref=? AND message_ref=?')
        .get(options.namespace, options.sourceRef, contextRef, messageRef);
      let receivedAt = options.receivedAt;
      if (old) {
        if (typeof old.raw_json !== 'string' || digest(old.raw_json) !== old.message_hash || old.message_hash !== message.fingerprint
          || typeof old.received_at !== 'string' || !evidenceRecordSchema.shape.receivedAt.safeParse(old.received_at).success) throw new MemoryImportError('identity');
        receivedAt = old.received_at; counts.duplicateMessages++;
      } else {
        const raw = canonical(message.raw);
        const written = this.db.prepare('INSERT INTO memory_v1_import_messages VALUES (?,?,?,?,?,?,?)').run(options.namespace, options.sourceRef, contextRef, messageRef, message.fingerprint, raw, receivedAt);
        if (Number(written.changes) !== 1) throw new MemoryImportError('identity');
      }
      counts.archivedMessages++;
      if (seen.has(messageRef)) { counts.duplicateMessages++; continue; }
      seen.add(messageRef);
      if (!['user', 'assistant', 'tool'].includes(message.role)) { counts.excludedMessages++; continue; }
      if (!['text', 'multimodal_text', 'code', 'execution_output', 'audio_transcription'].includes(message.contentType)) {
        counts.excludedMessages++;
        if (!['thoughts', 'reasoning_recap'].includes(message.contentType)) {
          counts.unavailableParts++; source.gaps.push({ contextId: contextRef, messageId: messageRef, reason: 'missing-source' });
        }
        continue;
      }
      const kind: EvidenceRecord['kind'] = message.role === 'user' ? 'user-statement' : message.role === 'assistant' ? 'assistant-statement' : 'tool-result';
      const actor = message.role as 'user' | 'assistant' | 'tool';
      for (const [index, part] of message.parts.entries()) {
        const id = hostId('import-evidence', [options.namespace, options.sourceRef, contextRef, messageRef, index]);
        const contentRef = hostId('import-content', id);
        const transcriptionText = isObject(part) && part.content_type === 'audio_transcription' && typeof part.text === 'string' ? part.text
          : message.contentType === 'audio_transcription' && typeof part === 'string' ? part : null;
        const transcription = transcriptionText !== null && transcriptionText.trim().length > 0;
        const textPart = message.contentType !== 'audio_transcription' && (typeof part === 'string' || isObject(part) && part.content_type === 'text' && typeof part.text === 'string');
        const locator = isObject(part) && part.content_type === 'image_asset_pointer' && typeof part.asset_pointer === 'string' ? part.asset_pointer : null;
        const asset = locator ? assetMap.get(locator) : undefined;
        const knownMedia = !!asset && isObject(part) && (part.mime_type === undefined || part.mime_type === asset.mediaType)
          && (part.size_bytes === undefined || part.size_bytes === asset.bytes.length);
        if (!textPart && !knownMedia && !transcription) {
          counts.unavailableParts++; source.gaps.push({ contextId: contextRef, messageId: id, reason: 'missing-source' });
          continue;
        }
        const originalText = transcription ? null : typeof part === 'string' ? part : textPart ? (part as { text: string }).text : null;
        const body = originalText !== null ? utf8(originalText) : utf8(canonical(transcription
          ? { type: 'historical-transcription', text: transcriptionText, confirmation: 'unconfirmed', originalAudio: 'unavailable' } : part));
        if (body.length > 4 * 1024 * 1024) throw new MemoryImportError('limit');
        const available = textPart || knownMedia || transcription;
        if (transcription) { counts.unavailableParts++; source.gaps.push({ contextId: contextRef, messageId: id, reason: 'missing-source' }); }
        // A transcription is preserved with its missing original audio; it cannot become typed user original text.
        const partKey = 'body'; const sourceId = hostId('import-asset', [options.namespace, options.sourceRef, locator]);
        const record = evidenceRecordSchema.parse({ schemaVersion: 1, id, kind, actor,
          origin: { system: 'import', namespace: options.namespace, sourceRef: options.sourceRef, contextRef, recordRef: hostId('import-record', [messageRef, index]), lineageRoot: messageRef, capture: 'historical-record' },
          occurredAt: message.occurredAt, receivedAt, visibleAfter: receivedAt, timeBasis: message.occurredAt === null ? 'unknown' : 'source-metadata',
          contentRef, contentHash: digest(body), operationRef: null, derivedFrom: [],
          attachments: knownMedia ? [{ sourceId, sha256: digest(asset!.bytes), mediaType: asset!.mediaType, bytes: asset!.bytes.length, derivedEvidenceIds: [] }] : [],
          coverage: { status: available ? 'complete' : 'unavailable', parts: [{ key: partKey, status: available ? 'available' : 'unavailable', reason: available ? null : transcription ? 'historical-audio-unavailable' : 'historical-part-unavailable' }] },
        });
        const bindings = [{ partKey, slots: [{ kind: 'body' as const, ref: contentRef }, ...(knownMedia ? [{ kind: 'attachment' as const, ref: sourceId }] : [])] }];
        const attachments = knownMedia ? [{ sourceId, bytes: new Uint8Array(asset!.bytes) }] : [];
        const actual = this.#ledger.putEvidence(record, { body: originalText !== null ? originalText : body, attachments, partBindings: bindings });
        if (actual.id !== id) throw new MemoryImportError('identity');
        this.#ledger.registerReceipt({ id: hostId('import-receipt', [options.namespace, options.sourceRef, contextRef, id]), scopeId: hostId('import-scope', [options.namespace, options.sourceRef]), evidence: actual, partBindings: bindings });
        const indexRow = this.db.prepare('SELECT * FROM memory_v1_import_evidence WHERE evidence_id=?').get(id);
        const expected = { namespace: options.namespace, source_ref: options.sourceRef, context_ref: contextRef, message_ref: messageRef, part_index: index, evidence_id: id };
        if (indexRow) {
          if (canonical(indexRow) !== canonical(expected)) throw new MemoryImportError('identity');
        } else {
          const write = this.db.prepare('INSERT INTO memory_v1_import_evidence VALUES (?,?,?,?,?,?)').run(options.namespace, options.sourceRef, contextRef, messageRef, index, id);
          if (Number(write.changes) !== 1) throw new MemoryImportError('identity');
        }
        source.records.push(actual);
        source.contents.set(contentRef, { codec: originalText !== null ? 'utf8' : 'json-utf8', body, attachments, attachmentOrder: knownMedia ? [sourceId] : [], partBindings: bindings });
        source.canonicalRefs.set(id, { contextId: contextRef, runId: null, recordId: messageRef, receivedAt, visibleAfter: receivedAt, canonicalIdentity: evidenceIdempotencyKey(actual) });
        if (knownMedia) source.attachmentRefs.set(sourceId, { assetId: sourceId, name: null });
        if (!available) { counts.unavailableParts++; source.gaps.push({ contextId: contextRef, messageId: id, reason: 'missing-source' }); }
        recentRecords.push({ evidence: actual, originalTextBytes: originalText !== null ? new Uint8Array(body) : null,
          ...(knownMedia ? { attachments: [{ sourceId, mediaType: asset!.mediaType, bytes: new Uint8Array(asset!.bytes) }] } : {}) });
        groups.push({ ref: { evidenceId: id, partKey }, group });
      }
    }
    counts.evidenceRecords = source.records.length;
    return { preparedSource: source, recentRecords, supportGroups: groups, counts, stopped: prefix.stopped, scopeId: hostId('import-scope', [options.namespace, options.sourceRef]) };
  }
}
