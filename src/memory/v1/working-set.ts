import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { EvidenceReference, MemoryCandidate } from './contracts.js';
import { MemoryWorkspaceError } from './workspace.js';
import { assertMemoryModelObject } from './request-budget.js';
import { parseScopedMemorySemanticReview } from './review.js';
import type { ScopedMemorySemanticReview } from './review.js';
import { validateMemoryCandidate } from './validate.js';

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refKey = (ref: EvidenceReference): string => JSON.stringify([ref.evidenceId, ref.partKey]);
const collections = ['entries', 'entities', 'relations', 'organizations', 'coverage', 'protectionChecks', 'overrides', 'protectionResolutions', 'legacyCoverage', 'observations'] as const;
type Collection = typeof collections[number];
type Row = Record<string, unknown>;
export interface MemoryWorkingSetAnchor {
  published: { id: string; manifestHash: string };
  processing: { id: string; resultHash: string; versionId: string; manifestHash: string; scopeId: string } | null;
  scopeId: string;
  cutoff: string;
  policyDigest: string;
}
export interface MemoryWorkingSetPacket {
  evidenceIds: readonly string[];
  objectHandles: readonly string[];
  details: readonly { id: string; content: string }[];
  packetHash: string;
}
interface HostObject { collection: Collection; identity: string; row: Row; handle: string }
export interface MemoryWorkingSetReview {
  schemaVersion: 2;
  scopeHash: string;
  candidateHash: string;
  diffHash: string;
  packetHash: string;
  obligationHash: string;
  inheritedHash: string;
  changes: { collection: Collection; identity: string; before: unknown; after: unknown }[];
  obligations: EvidenceReference[];
}

function identity(row: Row): string {
  if (typeof row.id === 'string') return row.id;
  if (row.ref) return JSON.stringify(row.ref);
  for (const name of ['oldEntryId', 'legacyEntryId', 'entryId']) if (typeof row[name] === 'string') return String(row[name]);
  throw new MemoryWorkspaceError('memory_working_set_identity');
}
function rows(candidate: MemoryCandidate, name: Collection): Row[] { return (candidate[name] ?? []) as unknown as Row[]; }
function strings(value: unknown): Set<string> {
  if (typeof value === 'string') return new Set([value]);
  if (!value || typeof value !== 'object') return new Set();
  return new Set(Object.values(value).flatMap(child => [...strings(child)]));
}
function references(value: unknown): EvidenceReference[] {
  if (!value || typeof value !== 'object') return [];
  const row = value as Row;
  if (typeof row.evidenceId === 'string' && typeof row.partKey === 'string') return [{ evidenceId: row.evidenceId, partKey: row.partKey }];
  return Object.values(value).flatMap(references);
}
function withoutEntryIndex(row: Row): Row { const { entryIds: _index, ...semantic } = row; return semantic; }
function derivedOrganizationChange(before: Row, after: Row, candidate: MemoryCandidate): boolean {
  return isDeepStrictEqual(withoutEntryIndex(before), withoutEntryIndex(after)) &&
    isDeepStrictEqual(after.entryIds, candidate.entries.filter(entry => entry.primaryNodeId === after.id).map(entry => entry.id));
}

/** 宿主持有完整候选；句柄、依赖与曝光都不由工具参数或模型回显签发。 */
export class MemoryWorkingSet {
  readonly #id = randomUUID();
  readonly #anchor: MemoryWorkingSetAnchor;
  readonly #cursors = new Map<string, { revision: number; packetHash: string; collection?: Collection; index: number }>();
  readonly #baseline: MemoryCandidate;
  readonly #details: readonly { id: string; content: string }[];
  readonly #objects = new Map<string, HostObject>();
  readonly #byIdentity = new Map<string, HostObject[]>();
  readonly #selected: Set<string>;
  readonly #packetEvidence: Set<string>;
  readonly #opened = new Set<string>();
  readonly #writerEvidence = new Set<string>();
  readonly #writerObjects = new Set<string>();
  readonly #writerDetails = new Set<string>();
  readonly #reviewPackets = new Set<string>();
  readonly #preflight: (packet: MemoryWorkingSetPacket) => void;
  readonly #metadataTokens: number;
  #review: MemoryWorkingSetReview | null = null;
  #acceptedScope: string | null = null;

  constructor(input: {
    anchor: MemoryWorkingSetAnchor;
    baseline: MemoryCandidate;
    details: readonly { id: string; content: string }[];
    selectedEvidenceIds: readonly string[];
    preflight: (packet: MemoryWorkingSetPacket) => void;
    metadataTokens?: number;
  }) {
    this.#anchor = structuredClone(input.anchor); this.#baseline = structuredClone(input.baseline);
    this.#details = structuredClone(input.details); this.#metadataTokens = input.metadataTokens ?? 4096;
    this.#selected = new Set(input.selectedEvidenceIds); this.#packetEvidence = new Set(this.#selected);
    this.#preflight = input.preflight;
    for (const id of this.#selected) if (!this.#baseline.evidence.some(record => record.id === id)) throw new MemoryWorkspaceError('memory_working_set_unknown_evidence');
    for (const collection of collections) for (const row of rows(this.#baseline, collection)) {
      const id = identity(row), handle = `object:${digest([this.#id, this.#anchor, collection, id, row])}`;
      const object = { collection, identity: id, row, handle };
      this.#objects.set(handle, object);
      this.#byIdentity.set(id, [...(this.#byIdentity.get(id) ?? []), object]);
      // 只有新记录自身的覆盖义务初始可写；反向关联的旧对象仍须完整打开。
      if ((collection === 'coverage' || collection === 'protectionChecks') && references(row).every(ref => this.#selected.has(ref.evidenceId))) this.#opened.add(handle);
    }
    this.#expandEvidence(this.#packetEvidence);
    this.#preflight(this.packet());
  }

  #expandEvidence(evidence: Set<string>): void {
    if (!Number.isFinite(Date.parse(this.#anchor.cutoff))) throw new MemoryWorkspaceError('memory_working_set_cutoff_invalid');
    for (const id of evidence) {
      const record = this.#baseline.evidence.find(row => row.id === id);
      if (!record || record.coverage.status !== 'complete' || Date.parse(record.visibleAfter) > Date.parse(this.#anchor.cutoff)) throw new MemoryWorkspaceError('memory_working_set_missing_evidence');
      for (const dependency of [...record.derivedFrom, ...record.attachments.flatMap(row => row.derivedEvidenceIds)]) evidence.add(dependency);
      if (record.operationRef) for (const related of this.#baseline.evidence) {
        if (related.operationRef === record.operationRef && related.origin.system === record.origin.system && related.origin.namespace === record.origin.namespace && related.origin.sourceRef === record.origin.sourceRef && related.origin.contextRef === record.origin.contextRef) evidence.add(related.id);
      }
    }
  }

  #buildPacket(evidence: ReadonlySet<string>, opened: ReadonlySet<string>): MemoryWorkingSetPacket {
    const objectHandles = [...opened].sort(), evidenceIds = [...evidence].sort();
    const detailIds = new Set(objectHandles.flatMap(handle => this.#objects.get(handle)!.collection === 'entries' ? [...strings(this.#objects.get(handle)!.row.detailRefs)] : []));
    const details = this.#details.filter(row => detailIds.has(row.id)).map(row => ({ ...row }));
    if ([...detailIds].some(id => !details.some(row => row.id === id))) throw new MemoryWorkspaceError('memory_working_set_missing_detail');
    return { evidenceIds, objectHandles, details, packetHash: digest([this.#id, this.#anchor, evidenceIds.map(id => this.#baseline.evidence.find(row => row.id === id)), objectHandles.map(handle => this.#objects.get(handle)), details]) };
  }
  packet(): MemoryWorkingSetPacket { return structuredClone(this.#buildPacket(this.#packetEvidence, this.#opened)); }

  handles(): { handle: string; collection: Collection; identity: string }[] {
    return [...this.#objects.values()].map(({ handle, collection, identity }) => ({ handle, collection, identity }));
  }

  pageHandles(input: { revision: number; collection?: Collection; cursor?: string }): {
    complete: boolean; items: (ReturnType<MemoryWorkingSet['handles']>[number] & { included: boolean; received: boolean })[]; nextCursor: string | null;
  } {
    if (!Number.isSafeInteger(input.revision) || input.revision < 0 || (input.collection !== undefined && !collections.includes(input.collection))) throw new MemoryWorkspaceError('memory_working_set_cursor_invalid');
    const packetHash = this.packet().packetHash;
    const cursor = input.cursor ? this.#cursors.get(input.cursor) : { revision: input.revision, packetHash, collection: input.collection, index: 0 };
    if (!cursor || cursor.revision !== input.revision || cursor.packetHash !== packetHash || cursor.collection !== input.collection) throw new MemoryWorkspaceError('memory_working_set_cursor_invalid');
    const available = this.handles().filter(row => !input.collection || row.collection === input.collection);
    const items = available.slice(cursor.index, cursor.index + 8).map(row => ({ ...row, included: this.#opened.has(row.handle), received: this.#writerObjects.has(row.handle) })), index = cursor.index + items.length;
    const nextCursor = index < available.length ? `cursor:${digest([this.#id, cursor, index])}` : null;
    if (nextCursor) this.#cursors.set(nextCursor, { ...cursor, index });
    const page = { complete: nextCursor === null, items, nextCursor };
    assertMemoryModelObject(page, 2048);
    return page;
  }

  /** 返回的是依赖待送达回执，不是“模型已读”证明。预检失败完全不扩大权限。 */
  open(handle: string, referenceOnly = false): { status: 'queued'; packetHash: string; evidenceRecords: number; objects: number } {
    if (!this.#objects.has(handle)) throw new MemoryWorkspaceError('memory_working_set_unknown_handle');
    const opened = new Set(this.#opened), evidence = new Set(this.#packetEvidence), queue = [{ handle, referenceOnly }], visited = new Set<string>();
    while (queue.length) {
      const next = queue.pop()!, key = `${next.handle}:${next.referenceOnly}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const object = this.#objects.get(next.handle)!;
      opened.add(next.handle);
      for (const ref of references(object.row)) {
        const record = this.#baseline.evidence.find(record => record.id === ref.evidenceId);
        if (!record || !record.coverage.parts.some(part => part.key === ref.partKey && part.status === 'available')) throw new MemoryWorkspaceError('memory_working_set_missing_evidence');
        evidence.add(record.id);
      }
      const ids = strings(object.collection === 'organizations' ? withoutEntryIndex(object.row) : object.row);
      for (const id of ids) for (const linked of this.#byIdentity.get(id) ?? []) {
        // 主题承载列表只是派生索引，不将同一主题下的所有事实强制合并成一个工作单元。
        if (linked.collection !== 'organizations') queue.push({ handle: linked.handle, referenceOnly: next.referenceOnly || (linked.collection === 'entities' && object.collection !== 'entities') });
      }
      // 反向覆盖、保护、结束链、共享详情、派生和关系均可能改变旧认识。
      if (object.collection === 'entries' || (object.collection === 'entities' && !next.referenceOnly)) for (const linked of this.#objects.values()) {
        if (linked.collection === 'organizations') continue;
        if (strings(linked.row).has(object.identity)) queue.push({ handle: linked.handle, referenceOnly: next.referenceOnly });
        if (object.collection === 'entries' && linked.collection === 'entries' && [...strings(object.row.detailRefs)].some(id => strings(linked.row.detailRefs).has(id))) queue.push({ handle: linked.handle, referenceOnly: false });
      }
      // 同一精确操作的全部记录及附件派生构成闭包，不能只挑成功终态。
      this.#expandEvidence(evidence);
      // 每条记录全部 parts 一起开放，对应的 coverage/protection 同样进入审查。
      for (const linked of this.#objects.values()) if ((linked.collection === 'observations' || (!next.referenceOnly && (linked.collection === 'coverage' || linked.collection === 'protectionChecks'))) && references(linked.row).some(ref => evidence.has(ref.evidenceId))) queue.push({ handle: linked.handle, referenceOnly: false });
    }
    const packet = this.#buildPacket(evidence, opened);
    const objects = packet.objectHandles.map(handle => this.#objects.get(handle));
    assertMemoryModelObject({ objects, details: packet.details }, this.#metadataTokens);
    this.#preflight(packet);
    this.#opened.clear(); for (const id of opened) this.#opened.add(id);
    this.#packetEvidence.clear(); for (const id of evidence) this.#packetEvidence.add(id);
    this.#review = null; this.#acceptedScope = null;
    return { status: 'queued', packetHash: packet.packetHash, evidenceRecords: evidence.size, objects: opened.size };
  }

  /** 只在最后请求入口实际采集到当前完整包时登记；工具 open 不调用此方法。 */
  writerSent(packetHash: string): void {
    const packet = this.packet();
    if (packet.packetHash !== packetHash) throw new MemoryWorkspaceError('memory_working_set_packet_conflict');
    this.#preflight(packet);
    for (const id of packet.evidenceIds) this.#writerEvidence.add(id);
    for (const id of packet.objectHandles) this.#writerObjects.add(id);
    for (const detail of packet.details) this.#writerDetails.add(detail.id);
  }

  #requireObject(object: HostObject, visited = new Set<string>(), referenceOnly = false): void {
    const key = `${object.handle}:${referenceOnly}`;
    if (visited.has(key)) return;
    visited.add(key);
    if (!this.#writerObjects.has(object.handle)) throw new MemoryWorkspaceError('memory_working_set_needs_evidence');
    this.#requireReferences(object.row);
    if (object.collection === 'entries' && [...strings(object.row.detailRefs)].some(id => !this.#writerDetails.has(id))) throw new MemoryWorkspaceError('memory_working_set_needs_detail');
    // 删除引用也会改变原有判断，依赖必须按旧值核对，不能只检查修改后的空列表。
    const ids = strings(object.collection === 'organizations' ? withoutEntryIndex(object.row) : object.row);
    for (const id of ids) for (const linked of this.#byIdentity.get(id) ?? []) {
      if (linked.collection !== 'organizations') this.#requireObject(linked, visited, referenceOnly || (linked.collection === 'entities' && object.collection !== 'entities'));
    }
    if (object.collection === 'entries' || (object.collection === 'entities' && !referenceOnly)) for (const linked of this.#objects.values()) {
      if (linked.collection === 'organizations') continue;
      if (strings(linked.row).has(object.identity) || (object.collection === 'entries' && linked.collection === 'entries' &&
        [...strings(object.row.detailRefs)].some(id => strings(linked.row.detailRefs).has(id)))) this.#requireObject(linked, visited, referenceOnly);
    }
  }
  #requireReferences(value: unknown): void {
    for (const ref of references(value)) {
      const record = this.#baseline.evidence.find(row => row.id === ref.evidenceId);
      if (!record || !record.coverage.parts.some(part => part.key === ref.partKey && part.status === 'available') || !this.#writerEvidence.has(ref.evidenceId)) throw new MemoryWorkspaceError('memory_working_set_needs_evidence');
    }
  }

  /** 必须在 workspace 的 clone→校验→安装之间调用，包括所有工具隐式产生的变化。 */
  assertMutation(before: MemoryCandidate, after: MemoryCandidate, draftRevision = Number.MAX_SAFE_INTEGER): void {
    if (!isDeepStrictEqual(before.evidence, after.evidence) || !isDeepStrictEqual(before.observations, after.observations) ||
      !isDeepStrictEqual(before.previousEntries, after.previousEntries) || before.batchId !== after.batchId || before.auditedAt !== after.auditedAt) throw new MemoryWorkspaceError('memory_working_set_frozen_source');
    for (const collection of collections) {
      const prior = new Map(rows(before, collection).map(row => [identity(row), row]));
      const next = new Map(rows(after, collection).map(row => [identity(row), row]));
      for (const id of new Set([...prior.keys(), ...next.keys()])) {
        const old = prior.get(id), current = next.get(id);
        if (isDeepStrictEqual(old, current)) continue;
        if (collection === 'organizations' && old && current && derivedOrganizationChange(old, current, after)) continue;
        const original = (this.#byIdentity.get(id) ?? []).find(row => row.collection === collection);
        if (original) this.#requireObject(original);
        if (!current) continue;
        this.#requireReferences(current);
        for (const linked of this.#objects.values()) {
          if (linked.collection === 'organizations') continue;
          // 新覆盖指向旧条目、替代边及实体/关系引用不能反向取得修改资格。
          if (strings(current).has(linked.identity) && linked.identity !== id) this.#requireObject(linked, undefined, linked.collection === 'entities');
        }
      }
    }
    this.project(after, draftRevision);
    this.#review = null; this.#acceptedScope = null; this.#cursors.clear();
  }

  assertDetails(before: readonly { id: string; content: string }[], after: readonly { id: string; content: string }[], candidate: MemoryCandidate): void {
    for (const id of new Set([...before, ...after].map(row => row.id))) {
      if (isDeepStrictEqual(before.find(row => row.id === id), after.find(row => row.id === id))) continue;
      if (before.some(row => row.id === id) && !this.#writerDetails.has(id)) throw new MemoryWorkspaceError('memory_working_set_needs_detail');
      for (const entry of candidate.entries) if (entry.format === 'reviewed' && entry.detailRefs.includes(id)) {
        const old = (this.#byIdentity.get(entry.id) ?? []).find(row => row.collection === 'entries');
        if (old) this.#requireObject(old);
      }
    }
    assertMemoryModelObject(after.filter(row => !isDeepStrictEqual(before.find(old => old.id === row.id), row)), this.#metadataTokens);
    this.#review = null; this.#acceptedScope = null;
  }

  project(candidate: MemoryCandidate, draftRevision: number, visibleObjects: ReadonlySet<string> = this.#opened, visibleEvidence: ReadonlySet<string> = this.#packetEvidence): unknown {
    const visible = (collection: Collection, row: Row): boolean => {
      const original = (this.#byIdentity.get(identity(row)) ?? []).find(item => item.collection === collection);
      return !original || visibleObjects.has(original.handle);
    };
    const view = { projectionVersion: 2, completeCandidate: false, draftRevision,
      candidate: { ...Object.fromEntries(collections.map(name => [name, rows(candidate, name).filter(row => visible(name, row))])),
        evidence: candidate.evidence.filter(record => visibleEvidence.has(record.id)).map(record => ({
          id: record.id, kind: record.kind, actor: record.actor, origin: record.origin.system,
          occurredAt: record.occurredAt, receivedAt: record.receivedAt, visibleAfter: record.visibleAfter, timeBasis: record.timeBasis, coverage: record.coverage,
        })),
      },
      inheritedCounts: Object.fromEntries(collections.map(name => [name, rows(candidate, name).filter(row => !visible(name, row)).length])),
    };
    assertMemoryModelObject(view, this.#metadataTokens);
    return structuredClone(view);
  }

  freeze(candidate: MemoryCandidate, details: readonly { id: string; content: string }[]): MemoryWorkingSetReview {
    this.assertMutation(this.#baseline, candidate); this.assertDetails(this.#details, details, candidate);
    const changes: MemoryWorkingSetReview['changes'] = [], inherited: unknown[] = [];
    for (const collection of collections) {
      const before = new Map(rows(this.#baseline, collection).map(row => [identity(row), row]));
      const after = new Map(rows(candidate, collection).map(row => [identity(row), row]));
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        if (isDeepStrictEqual(before.get(id), after.get(id))) inherited.push([collection, id, before.get(id)]);
        else changes.push({ collection, identity: id, before: before.get(id) ?? null, after: after.get(id) ?? null });
      }
    }
    // 覆盖义务来自实际变化的前后行；未变实体的身份依据只是引用依赖，不代表重分类旧覆盖。
    // 间接修改权限仍由 assertMutation 的旧值闭包核对，复核范围同时绑定完整 diff。
    const changedRefs = new Set(changes.flatMap(change => [...references(change.before), ...references(change.after)].map(refKey)));
    const obligations = candidate.coverage.filter(row => this.#selected.has(row.ref.evidenceId) || changedRefs.has(refKey(row.ref))).map(row => row.ref);
    const packet = this.packet();
    if (packet.evidenceIds.some(id => !this.#writerEvidence.has(id)) || packet.objectHandles.some(id => !this.#writerObjects.has(id))) throw new MemoryWorkspaceError('memory_working_set_writer_incomplete');
    for (const ref of obligations) {
      this.#requireReferences(ref);
      // 重审未改动的旧映射也必须看见其原有认识和详情，不能仅凭继承值记账。
      for (const object of this.#byIdentity.get(JSON.stringify(ref)) ?? []) this.#requireObject(object);
    }
    // 完整双侧差异用于宿主哈希绑定；实际 baseline/proposal 的容量由统一送审构造分别检查。
    const binding = { schemaVersion: 2 as const, candidateHash: digest([candidate, details]), diffHash: digest(changes), packetHash: packet.packetHash, obligationHash: digest(obligations), inheritedHash: digest(inherited) };
    this.#review = { ...binding, scopeHash: digest([this.#anchor, binding]), changes, obligations };
    return structuredClone(this.#review);
  }
  reviewerSent(scopeHash: string, packetHash: string): void {
    if (!this.#review || this.#review.scopeHash !== scopeHash || this.#review.packetHash !== packetHash || this.packet().packetHash !== packetHash) throw new MemoryWorkspaceError('memory_working_set_review_conflict');
    this.#reviewPackets.add(scopeHash);
  }
  acceptReview(text: string, candidate: MemoryCandidate, details: readonly { id: string; content: string }[]): ScopedMemorySemanticReview {
    if (!this.#review || !this.#reviewPackets.has(this.#review.scopeHash) || this.#review.candidateHash !== digest([candidate, details])) throw new MemoryWorkspaceError('memory_working_set_review_conflict');
    const entryIds = candidate.entries.filter(entry => {
      const old = (this.#byIdentity.get(entry.id) ?? []).find(row => row.collection === 'entries');
      return !old || this.#writerObjects.has(old.handle);
    }).map(entry => entry.id);
    for (const change of this.#review.changes) if (change.collection === 'entries' && !entryIds.includes(change.identity)) entryIds.push(change.identity);
    const review = parseScopedMemorySemanticReview(text, candidate, { scopeHash: this.#review.scopeHash, entryIds, evidenceIds: this.packet().evidenceIds });
    this.#acceptedScope = review.verdict === 'pass' ? review.scopeHash : null;
    return review;
  }
  auditedDecisions(candidate: MemoryCandidate, details: readonly { id: string; content: string }[], scopeHash: string): MemoryCandidate['coverage'] {
    if (!this.#review || this.#review.scopeHash !== scopeHash || this.#review.candidateHash !== digest([candidate, details]) || !this.#reviewPackets.has(scopeHash) || this.#acceptedScope !== scopeHash) throw new MemoryWorkspaceError('memory_working_set_review_conflict');
    const validation = validateMemoryCandidate(candidate);
    if (!validation.valid || !validation.coverageComplete) throw new MemoryWorkspaceError('memory_working_set_review_incomplete');
    const required = new Set(this.#review.obligations.map(refKey));
    const decisions = candidate.coverage.filter(row => required.has(refKey(row.ref)));
    if (decisions.some(row => row.decision.startsWith('pending-') || candidate.protectionChecks.some(check => refKey(check.ref) === refKey(row.ref) && check.decision === 'pending-review'))) throw new MemoryWorkspaceError('memory_working_set_review_incomplete');
    return structuredClone(decisions);
  }
}
