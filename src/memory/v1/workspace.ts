import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  coverageDecisionSchema, entitySchema, entityRelationSchema, organizationNodeSchema,
  evidenceReferenceSchema, memoryCandidateSchema, memoryEntrySchema, protectionCheckSchema,
} from './contracts.js';
import type {
  CoverageDecision, Entity, EntityRelation, EvidenceReference, MemoryCandidate, MemoryEntry,
  OrganizationNode, ProtectionCheck,
} from './contracts.js';
import { validateMemoryCandidate } from './validate.js';
import type { ContractValidation } from './validate.js';

type Reviewed = Extract<MemoryEntry, { format: 'reviewed' }>;
export type MemoryEntryInput = Omit<Reviewed, 'id' | 'revision' | 'format' | 'createdInBatch' | 'updatedInBatch' | 'evidence'> & {
  evidence: { ref: EvidenceReference; role: Reviewed['evidence'][number]['role'] }[];
};
export type WorkspaceIdKind = 'entry' | 'entity' | 'organization' | 'relation';
export const memoryWorkspaceAuditSchema = z.strictObject({
  draftRevision: z.number().int().positive(), at: z.iso.datetime({ offset: true }),
  operation: z.string().min(1), rationale: z.string().min(1),
  beforeHash: z.string().regex(/^[a-f0-9]{64}$/), afterHash: z.string().regex(/^[a-f0-9]{64}$/),
  changes: z.array(z.strictObject({
    collection: z.enum(['entries', 'entities', 'relations', 'organizations', 'coverage', 'protectionChecks', 'overrides', 'protectionResolutions', 'legacyCoverage']),
    identity: z.string().min(1), fields: z.array(z.string().min(1)),
    beforeHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), afterHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  })),
});
export const memoryWorkspaceExportSchema = z.strictObject({
  baseVersion: z.string().min(1).nullable(), draftRevision: z.number().int().nonnegative(),
  candidate: memoryCandidateSchema,
  audit: z.array(memoryWorkspaceAuditSchema),
  supportGroups: z.array(z.strictObject({ ref: evidenceReferenceSchema, group: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/) })),
});
export type MemoryWorkspaceExport = z.infer<typeof memoryWorkspaceExportSchema>;
export interface MemoryWorkspaceOptions {
  baseVersion: string | null;
  batchId: string;
  auditedAt: string;
  previousEntries: MemoryEntry[];
  evidence: MemoryCandidate['evidence'];
  observations: MemoryCandidate['observations'];
  entities: Entity[];
  organizations: OrganizationNode[];
  relations?: EntityRelation[];
  overrides?: MemoryCandidate['overrides'];
  /** 每个可用证据部分的真实同源分组，由来源适配器提供，不接受工具端覆盖。 */
  supportGroups: MemoryWorkspaceExport['supportGroups'];
  clock: () => string;
  createId: (kind: WorkspaceIdKind) => string;
  /** 仅供已验真的宿主基线初始化，不经由模型操作或新增审计。 */
  inherited?: Pick<MemoryCandidate, 'coverage' | 'protectionChecks'> & Partial<Pick<MemoryCandidate, 'legacyCoverage' | 'protectionResolutions'>>;
  /** 在所有显式及派生变更完成、安装快照之前执行；拒绝不改变修订或审计。 */
  assertMutation?: (before: MemoryCandidate, after: MemoryCandidate) => void;
}
export class MemoryWorkspaceError extends Error {
  constructor(readonly code: string, readonly validation?: ContractValidation) { super(code); this.name = 'MemoryWorkspaceError'; }
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (ref: EvidenceReference) => JSON.stringify([ref.evidenceId, ref.partKey]);
function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}
const copy = <T>(value: T): T => structuredClone(value);
const requireReason = (value: string) => z.string().trim().min(1).parse(value);
function changes(before: MemoryCandidate, after: MemoryCandidate): MemoryWorkspaceExport['audit'][number]['changes'] {
  const result: MemoryWorkspaceExport['audit'][number]['changes'] = [];
  const identity = (row: object): string => {
    if ('id' in row) return String(row.id);
    if ('ref' in row) return JSON.stringify(row.ref);
    if ('oldEntryId' in row) return String(row.oldEntryId);
    if ('legacyEntryId' in row) return String(row.legacyEntryId);
    if ('entryId' in row) return String(row.entryId);
    throw new MemoryWorkspaceError('memory_workspace_audit_identity');
  };
  for (const collection of ['entries', 'entities', 'relations', 'organizations', 'coverage', 'protectionChecks', 'overrides', 'protectionResolutions', 'legacyCoverage'] as const) {
    const previous = new Map((before[collection] ?? []).map(row => [identity(row), row]));
    const next = new Map((after[collection] ?? []).map(row => [identity(row), row]));
    for (const id of new Set([...previous.keys(), ...next.keys()])) {
      const old = previous.get(id), current = next.get(id);
      if (JSON.stringify(old) === JSON.stringify(current)) continue;
      const oldFields = new Map(Object.entries(old ?? {})), newFields = new Map(Object.entries(current ?? {}));
      const fields = [...new Set([...oldFields.keys(), ...newFields.keys()])].filter(field => JSON.stringify(oldFields.get(field)) !== JSON.stringify(newFields.get(field))).sort();
      result.push({ collection, identity: id, fields, beforeHash: old ? hash(old) : null, afterHash: current ? hash(current) : null });
    }
  }
  return result;
}

/** 只维护候选；结构检查和覆盖检查均不是语义复核或发布授权。 */
export class MemoryWorkspace {
  #candidate: MemoryCandidate;
  readonly #baseline: readonly MemoryEntry[];
  readonly #baseVersion: string | null;
  readonly #groups: Map<string, string>;
  readonly #supportGroups: MemoryWorkspaceExport['supportGroups'];
  readonly #clock: () => string;
  readonly #createId: MemoryWorkspaceOptions['createId'];
  readonly #assertMutation?: MemoryWorkspaceOptions['assertMutation'];
  readonly #issued = new Set<string>();
  #draftRevision = 0;
  #audit: MemoryWorkspaceExport['audit'] = [];

  constructor(options: MemoryWorkspaceOptions) {
    this.#clock = options.clock; this.#createId = options.createId; this.#assertMutation = options.assertMutation;
    this.#baseVersion = z.string().min(1).nullable().parse(options.baseVersion);
    this.#supportGroups = memoryWorkspaceExportSchema.shape.supportGroups.parse(options.supportGroups);
    this.#groups = new Map(this.#supportGroups.map(row => [key(row.ref), row.group]));
    if (this.#groups.size !== this.#supportGroups.length) throw new MemoryWorkspaceError('memory_workspace_duplicate_group');
    this.#baseline = frozen(copy(options.previousEntries));
    const refs = options.evidence.flatMap(record => record.coverage.parts.map(part => ({ evidenceId: record.id, partKey: part.key })));
    this.#candidate = memoryCandidateSchema.parse({
      batchId: options.batchId, auditedAt: options.auditedAt,
      evidence: options.evidence, observations: options.observations,
      previousEntries: this.#baseline, entries: this.#baseline,
      entities: options.entities, organizations: options.organizations, relations: options.relations ?? [],
      overrides: options.overrides ?? [], legacyCoverage: options.inherited?.legacyCoverage ?? [], protectionResolutions: options.inherited?.protectionResolutions ?? [],
      coverage: refs.map(ref => ({ ref, decision: options.evidence.find(row => row.id === ref.evidenceId)!.coverage.parts.find(part => part.key === ref.partKey)!.status === 'unavailable' ? 'pending-source' : 'pending-review', entryIds: [], rationale: '来源尚待逐项复核' })),
      protectionChecks: refs.map(ref => ({ ref, decision: 'pending-review', entryIds: [], rationale: '保护资格尚待复核' })),
    });
    for (const row of this.#supportGroups) {
      if (!refs.some(ref => key(ref) === key(row.ref))) throw new MemoryWorkspaceError('memory_workspace_unknown_group');
    }
    if (options.inherited) {
      const inherited = {
        coverage: options.inherited.coverage.map(row => coverageDecisionSchema.parse(row)),
        protectionChecks: options.inherited.protectionChecks.map(row => protectionCheckSchema.parse(row)),
      };
      for (const name of ['coverage', 'protectionChecks'] as const) {
        const known = new Set(this.#candidate[name].map(row => key(row.ref)));
        const seen = new Set<string>();
        for (const row of inherited[name]) {
          const id = key(row.ref);
          if (!known.has(id) || seen.has(id)) throw new MemoryWorkspaceError('memory_workspace_invalid_seed');
          seen.add(id);
        }
      }
      this.#candidate = memoryCandidateSchema.parse({ ...this.#candidate,
        coverage: this.#candidate.coverage.map(row => inherited.coverage.find(old => key(old.ref) === key(row.ref)) ?? row),
        protectionChecks: this.#candidate.protectionChecks.map(row => inherited.protectionChecks.find(old => key(old.ref) === key(row.ref)) ?? row),
      });
    }
    this.#checkGroups(this.#candidate);
    if (!options.inherited) this.#syncProtection(this.#candidate);
    this.#assertValid(this.#candidate);
    for (const rows of [this.#candidate.entries, this.#candidate.entities, this.#candidate.organizations, this.#candidate.relations, this.#candidate.evidence, this.#candidate.observations]) for (const row of rows) this.#issued.add(row.id);
  }

  get draftRevision(): number { return this.#draftRevision; }
  export(): MemoryWorkspaceExport {
    return frozen(copy({ baseVersion: this.#baseVersion, draftRevision: this.#draftRevision, candidate: this.#candidate, audit: this.#audit, supportGroups: this.#supportGroups }));
  }
  check(): ContractValidation { return copy(validateMemoryCandidate(this.#candidate)); }

  #allocate(kind: WorkspaceIdKind): string {
    const id = memoryEntrySchema.options[0].shape.id.parse(this.#createId(kind));
    if (this.#issued.has(id)) throw new MemoryWorkspaceError('memory_workspace_id_collision');
    // 失败事务已领取的身份也不重用；不会把它写进候选或审计。
    this.#issued.add(id); return id;
  }
  #assertValid(candidate: MemoryCandidate) {
    const result = validateMemoryCandidate(candidate);
    if (!result.valid) throw new MemoryWorkspaceError('memory_workspace_invalid', result);
  }
  #checkGroups(candidate: MemoryCandidate) {
    for (const record of candidate.evidence) for (const part of record.coverage.parts) {
      if (part.status === 'available' && !this.#groups.has(key({ evidenceId: record.id, partKey: part.key }))) throw new MemoryWorkspaceError('memory_workspace_missing_group');
    }
    for (const entry of candidate.entries) if (entry.format === 'reviewed') for (const item of entry.evidence) {
      if (this.#groups.get(key(item.ref)) !== item.supportGroup) throw new MemoryWorkspaceError('memory_workspace_group_mismatch');
    }
  }
  #syncProtection(candidate: MemoryCandidate, affected?: ReadonlySet<string>) {
    for (const check of candidate.protectionChecks) {
      if (affected && !affected.has(key(check.ref))) continue;
      const protectedEntries = candidate.entries.filter((entry): entry is Reviewed => entry.format === 'reviewed' && entry.protection.mode !== 'none' && entry.protectionAssessment.evidence.some(ref => key(ref) === key(check.ref)));
      if (!protectedEntries.length) {
        const assessed = candidate.entries.filter((entry): entry is Reviewed => entry.format === 'reviewed' && entry.protectionAssessment.decision === 'ineligible' && entry.protectionAssessment.evidence.some(ref => key(ref) === key(check.ref)));
        if (assessed.length) {
          check.decision = 'no-protectable-state'; check.entryIds = [];
          check.rationale = assessed.map(entry => entry.protectionAssessment.rationale).join('；');
        }
        continue;
      }
      const pending = protectedEntries.filter(entry => entry.protection.mode === 'pending-review');
      // 同一来源尚有未决资格时保留 pending；混合资格需要调用方拆分证据部分。
      const selected = pending.length ? pending : protectedEntries;
      check.decision = pending.length ? 'pending-review' : 'mapped';
      check.entryIds = selected.map(entry => entry.id);
      check.rationale = selected.map(entry => entry.protectionAssessment.rationale).join('；');
    }
  }
  #mutate<T>(expectedDraftRevision: number, operation: string, rationale: string, edit: (candidate: MemoryCandidate) => T, assertInstall?: (candidate: MemoryCandidate) => void): { result: T; draftRevision: number } {
    if (!z.number().int().nonnegative().safeParse(expectedDraftRevision).success || expectedDraftRevision !== this.#draftRevision) throw new MemoryWorkspaceError('memory_workspace_stale_draft');
    requireReason(rationale);
    const edited = copy(this.#candidate);
    const result = edit(edited);
    const affected = this.#assertMutation ? new Set<string>() : undefined;
    if (affected) {
      for (const entry of [...this.#candidate.entries, ...edited.entries]) {
        const previous = this.#candidate.entries.find(row => row.id === entry.id), next = edited.entries.find(row => row.id === entry.id);
        if (JSON.stringify(previous) === JSON.stringify(next) || entry.format !== 'reviewed') continue;
        for (const ref of [...entry.evidence.map(row => row.ref), ...entry.protectionAssessment.evidence]) affected.add(key(ref));
      }
      for (const check of edited.protectionChecks) if (JSON.stringify(check) !== JSON.stringify(this.#candidate.protectionChecks.find(row => key(row.ref) === key(check.ref)))) affected.add(key(check.ref));
    }
    this.#syncProtection(edited, affected);
    // 再解析切断操作参数中的对象别名；失败操作从不安装此快照。
    const candidate = memoryCandidateSchema.parse(edited);
    this.#checkGroups(candidate);
    this.#assertValid(candidate);
    this.#assertMutation?.(copy(this.#candidate), copy(candidate));
    assertInstall?.(copy(candidate));
    const at = z.iso.datetime({ offset: true }).parse(this.#clock());
    const audit = memoryWorkspaceAuditSchema.parse({ draftRevision: this.#draftRevision + 1, at, operation, rationale, beforeHash: hash(this.#candidate), afterHash: hash(candidate), changes: changes(this.#candidate, candidate) });
    this.#candidate = candidate; this.#draftRevision++; this.#audit.push(audit);
    return frozen(copy({ result, draftRevision: this.#draftRevision }));
  }
  #reviewed(candidate: MemoryCandidate, id: string, expectedRevision: number): Reviewed {
    if (!z.number().int().positive().safeParse(expectedRevision).success) throw new MemoryWorkspaceError('memory_workspace_stale_entry');
    const entry = candidate.entries.find(row => row.id === id);
    if (!entry || entry.format !== 'reviewed') throw new MemoryWorkspaceError('memory_workspace_entry_not_reviewed');
    if (entry.revision !== expectedRevision) throw new MemoryWorkspaceError('memory_workspace_stale_entry');
    return entry;
  }
  #build(input: MemoryEntryInput, identity: Pick<Reviewed, 'id' | 'revision' | 'createdInBatch'>, candidate: MemoryCandidate): Reviewed {
    const forbidden = ['id', 'revision', 'format', 'createdInBatch', 'updatedInBatch'];
    if (forbidden.some(field => Object.hasOwn(input, field))) throw new MemoryWorkspaceError('memory_workspace_host_field');
    requireReason(input.retention.rationale); requireReason(input.protectionAssessment.rationale);
    if (input.protection.mode === 'pending-review') requireReason(input.protection.reason);
    if (input.protection.mode === 'state') requireReason(input.protection.overrideRule);
    const evidence = input.evidence.map(item => {
      const parsed = z.strictObject({ ref: evidenceReferenceSchema, role: z.enum(['supports', 'corrects', 'contradicts', 'context']) }).parse(item);
      const supportGroup = this.#groups.get(key(parsed.ref));
      if (!supportGroup) throw new MemoryWorkspaceError('memory_workspace_unknown_evidence');
      return { ...parsed, supportGroup };
    });
    const entry = memoryEntrySchema.parse({ ...input, evidence, id: identity.id, revision: identity.revision, createdInBatch: identity.createdInBatch, format: 'reviewed', updatedInBatch: candidate.batchId });
    if (entry.format !== 'reviewed') throw new MemoryWorkspaceError('memory_workspace_entry_not_reviewed');
    if (entry.protection.mode === 'state' && entry.lifecycle === 'superseded' && entry.placement === 'resident') throw new MemoryWorkspaceError('memory_workspace_ended_state_resident');
    return entry;
  }
  #revise(entry: Reviewed, candidate: MemoryCandidate) {
    const old = this.#baseline.find(row => row.id === entry.id);
    entry.revision = old ? old.revision + 1 : 1;
    entry.updatedInBatch = candidate.batchId;
  }
  #organize(candidate: MemoryCandidate) {
    for (const node of candidate.organizations) node.entryIds = candidate.entries.filter(entry => entry.primaryNodeId === node.id).map(entry => entry.id);
  }
  #duplicate(candidate: MemoryCandidate, entry: Reviewed) {
    // 相同命题应更新已有身份；已结束的审计正文不是第二个当前事实。
    if (entry.lifecycle !== 'superseded' && entry.placement !== 'retired' && candidate.entries.some(row => row.id !== entry.id && row.text === entry.text && row.format === 'reviewed' && JSON.stringify(row.scope) === JSON.stringify(entry.scope) && row.lifecycle !== 'superseded' && row.placement !== 'retired')) throw new MemoryWorkspaceError('memory_workspace_duplicate_proposition');
  }
  #syncRelations(candidate: MemoryCandidate, entry: Reviewed) {
    // 关系是主要事实的索引，不另外维护一份可能失配的有效期。
    for (const relation of candidate.relations) if (relation.entryId === entry.id) {
      relation.validFrom = entry.validFrom; relation.validTo = entry.validTo;
    }
  }
  #add(candidate: MemoryCandidate, value: MemoryEntryInput): Reviewed {
    const entry = this.#build(value, { id: this.#allocate('entry'), revision: 1, createdInBatch: candidate.batchId }, candidate);
    this.#duplicate(candidate, entry);
    candidate.entries.push(entry); this.#organize(candidate); return entry;
  }

  createEntry(expected: number, value: MemoryEntryInput, rationale: string) {
    return this.#mutate(expected, 'create-entry', rationale, candidate => this.#add(candidate, value));
  }
  updateEntry(expected: number, id: string, expectedRevision: number, value: MemoryEntryInput, rationale: string, assertInstall?: (candidate: MemoryCandidate) => void) {
    return this.#mutate(expected, 'update-entry', rationale, candidate => {
      const old = this.#reviewed(candidate, id, expectedRevision);
      // 改分、改正文不隐含覆盖、淘汰或资格收敛。
      const entry = this.#build(value, old, candidate);
      if (entry.placement === 'retired' && old.placement !== 'retired') throw new MemoryWorkspaceError('memory_workspace_use_retire');
      if (JSON.stringify(entry.protection) !== JSON.stringify(old.protection) || JSON.stringify(entry.scope) !== JSON.stringify(old.scope) || JSON.stringify(entry.replacedBy) !== JSON.stringify(old.replacedBy)) throw new MemoryWorkspaceError('memory_workspace_use_transition');
      this.#duplicate(candidate, entry); this.#revise(entry, candidate);
      candidate.entries[candidate.entries.indexOf(old)] = entry;
      this.#syncRelations(candidate, entry);
      this.#organize(candidate); return entry;
    }, assertInstall);
  }
  retireEntry(expected: number, id: string, expectedRevision: number, rationale: string) {
    return this.#mutate(expected, 'retire-entry', rationale, candidate => {
      const entry = this.#reviewed(candidate, id, expectedRevision);
      if (entry.protection.mode !== 'none') throw new MemoryWorkspaceError('memory_workspace_protected');
      entry.placement = 'retired'; this.#revise(entry, candidate);
      for (const item of entry.evidence) {
        const retiredIds = candidate.entries.filter((row): row is Reviewed => row.format === 'reviewed' && row.placement === 'retired' && row.evidence.some(other => key(other.ref) === key(item.ref))).map(row => row.id);
        const previous = candidate.coverage.find(row => key(row.ref) === key(item.ref));
        this.#cover(candidate, { ref: item.ref, decision: 'retired-with-reason', entryIds: retiredIds, rationale: previous?.decision === 'retired-with-reason' ? `${previous.rationale}；${rationale}` : rationale });
      }
      return entry;
    });
  }
  #cover(candidate: MemoryCandidate, input: CoverageDecision) {
    const row = coverageDecisionSchema.parse(input), index = candidate.coverage.findIndex(item => key(item.ref) === key(row.ref));
    if (index < 0) throw new MemoryWorkspaceError('memory_workspace_unknown_evidence');
    candidate.coverage[index] = row;
  }
  decideCoverage(expected: number, coverage: CoverageDecision, protection: ProtectionCheck) {
    return this.#mutate(expected, 'decide-coverage', coverage.rationale, candidate => {
      const check = protectionCheckSchema.parse(protection);
      if (key(check.ref) !== key(coverage.ref)) throw new MemoryWorkspaceError('memory_workspace_check_scope');
      requireReason(check.rationale);
      this.#cover(candidate, coverage);
      const index = candidate.protectionChecks.findIndex(item => key(item.ref) === key(check.ref));
      if (index < 0) throw new MemoryWorkspaceError('memory_workspace_unknown_evidence');
      candidate.protectionChecks[index] = copy(check);
      this.#syncProtection(candidate, this.#assertMutation ? new Set([key(check.ref)]) : undefined);
      const actual = candidate.protectionChecks[index]!;
      if (actual.decision !== check.decision || JSON.stringify([...actual.entryIds].sort()) !== JSON.stringify([...check.entryIds].sort())) throw new MemoryWorkspaceError('memory_workspace_check_conflict');
      return coverage;
    });
  }
  createEntity(expected: number, value: Omit<Entity, 'id'>, rationale: string) {
    return this.#mutate(expected, 'create-entity', rationale, candidate => {
      if (Object.hasOwn(value, 'id')) throw new MemoryWorkspaceError('memory_workspace_host_field');
      const row = entitySchema.parse({ ...value, id: this.#allocate('entity') }); candidate.entities.push(row); return row;
    });
  }
  updateEntity(expected: number, id: string, value: Omit<Entity, 'id'>, rationale: string) {
    return this.#mutate(expected, 'update-entity', rationale, candidate => {
      if (Object.hasOwn(value, 'id')) throw new MemoryWorkspaceError('memory_workspace_host_field');
      const index = candidate.entities.findIndex(row => row.id === id);
      if (index < 0) throw new MemoryWorkspaceError('memory_workspace_unknown_entity');
      const row = entitySchema.parse({ ...value, id });
      // 身份证据不可静默换人；新人物应创建新实体，关系通过新条目表达。
      if (JSON.stringify(row.identityEvidence) !== JSON.stringify(candidate.entities[index]!.identityEvidence) || row.kind !== candidate.entities[index]!.kind) throw new MemoryWorkspaceError('memory_workspace_entity_identity');
      candidate.entities[index] = row; return row;
    });
  }
  createOrganization(expected: number, value: Pick<OrganizationNode, 'title' | 'parentId'>, rationale: string) {
    return this.#mutate(expected, 'create-organization', rationale, candidate => {
      const input = z.strictObject({ title: z.string().min(1), parentId: organizationNodeSchema.shape.parentId }).parse(value);
      const node = organizationNodeSchema.parse({ ...input, id: this.#allocate('organization'), entryIds: [] }); candidate.organizations.push(node); return node;
    });
  }
  updateOrganization(expected: number, id: string, value: Pick<OrganizationNode, 'title' | 'parentId'>, rationale: string) {
    return this.#mutate(expected, 'update-organization', rationale, candidate => {
      const input = z.strictObject({ title: z.string().min(1), parentId: organizationNodeSchema.shape.parentId }).parse(value);
      const node = candidate.organizations.find(row => row.id === id);
      if (!node) throw new MemoryWorkspaceError('memory_workspace_unknown_node');
      Object.assign(node, input); return node;
    });
  }
  removeOrganization(expected: number, id: string, rationale: string) {
    return this.#mutate(expected, 'remove-organization', rationale, candidate => {
      if (!candidate.organizations.some(row => row.id === id)) throw new MemoryWorkspaceError('memory_workspace_unknown_node');
      candidate.organizations = candidate.organizations.filter(row => row.id !== id); return id;
    });
  }
  setRelation(expected: number, id: string | null, value: Omit<EntityRelation, 'id'>, rationale: string) {
    return this.#mutate(expected, 'set-relation', rationale, candidate => {
      if (Object.hasOwn(value, 'id')) throw new MemoryWorkspaceError('memory_workspace_host_field');
      const row = entityRelationSchema.parse({ ...value, id: id ?? this.#allocate('relation') });
      const index = candidate.relations.findIndex(item => item.id === row.id);
      if (id !== null && index < 0) throw new MemoryWorkspaceError('memory_workspace_unknown_relation');
      if (index < 0) candidate.relations.push(row);
      else {
        const old = candidate.relations[index]!;
        if (row.subjectId !== old.subjectId || row.objectId !== old.objectId || row.kind !== old.kind || row.entryId !== old.entryId) throw new MemoryWorkspaceError('memory_workspace_relation_identity');
        candidate.relations[index] = row;
      }
      return row;
    });
  }

  /** 普通条目的拆分/合并保留结束身份、来源、替代边与逐部分理由，不用删除模拟淘汰。 */
  reorganizeEntries(expected: number, oldEntries: { id: string; revision: number }[], replacements: MemoryEntryInput[], rationale: string) {
    return this.#mutate(expected, 'reorganize-entries', rationale, candidate => {
      const requested = z.array(z.strictObject({ id: memoryEntrySchema.options[0].shape.id, revision: z.number().int().positive() })).parse(oldEntries);
      if (!requested.length || !replacements.length || new Set(requested.map(row => row.id)).size !== requested.length) throw new MemoryWorkspaceError('memory_workspace_reorganization');
      const old = requested.map(row => this.#reviewed(candidate, row.id, row.revision));
      if (old.some(entry => entry.protection.mode !== 'none' || entry.lifecycle === 'superseded')) throw new MemoryWorkspaceError('memory_workspace_protected');
      if (replacements.some(value => value.lifecycle === 'superseded' || value.replacedBy.length !== 0 || value.placement === 'retired')) throw new MemoryWorkspaceError('memory_workspace_incomplete_replacement');
      const next = replacements.map(value => this.#add(candidate, { ...value, derivedFromEntryIds: [...new Set([...value.derivedFromEntryIds, ...old.map(entry => entry.id)])] }));
      for (const entry of old) {
        entry.lifecycle = 'superseded'; entry.placement = 'detail'; entry.replacedBy = next.map(row => row.id); this.#revise(entry, candidate);
        for (const item of entry.evidence) {
          const retained = next.filter(row => row.evidence.some(other => key(other.ref) === key(item.ref)));
          if (!retained.length) throw new MemoryWorkspaceError('memory_workspace_incomplete_replacement');
          this.#cover(candidate, { ref: item.ref, decision: 'merged', entryIds: retained.map(row => row.id), rationale });
        }
      }
      return next;
    });
  }
  replaceState(expected: number, id: string, expectedRevision: number, value: MemoryEntryInput, evidence: EvidenceReference[], rationale: string) {
    return this.#mutate(expected, 'replace-state', rationale, candidate => {
      const old = this.#reviewed(candidate, id, expectedRevision);
      if (old.protection.mode !== 'state' || !['current', 'unresolved'].includes(old.lifecycle)) throw new MemoryWorkspaceError('memory_workspace_protected');
      const next = this.#add(candidate, value);
      old.lifecycle = 'superseded'; old.placement = 'detail'; old.validTo = next.validFrom; old.replacedBy = [next.id]; this.#revise(old, candidate);
      this.#syncRelations(candidate, old);
      candidate.overrides.push({ oldEntryId: id, newEntryId: next.id, scope: old.scope, evidence, rationale });
      return next;
    });
  }
  resolveProtection(expected: number, id: string, expectedRevision: number, value: MemoryEntryInput, rationale: string) {
    return this.#mutate(expected, 'resolve-protection', rationale, candidate => {
      const old = this.#reviewed(candidate, id, expectedRevision), prior = this.#baseline.find(row => row.id === id);
      if (old.protection.mode !== 'pending-review' || (prior && (prior.format !== 'reviewed' || prior.protection.mode !== 'pending-review')) || value.protectionAssessment.decision === 'pending-review') throw new MemoryWorkspaceError('memory_workspace_resolution');
      const next = this.#build(value, old, candidate); this.#revise(next, candidate);
      // 同批新条目也须保持同一命题、时间与常驻位置；跨版本收敛另外携带合同记录。
      if (JSON.stringify(old.scope) !== JSON.stringify(next.scope) || old.lifecycle !== next.lifecycle || old.validFrom !== next.validFrom || old.validTo !== next.validTo || next.placement !== 'resident') throw new MemoryWorkspaceError('memory_workspace_resolution_scope');
      candidate.entries[candidate.entries.indexOf(old)] = next;
      if (prior) candidate.protectionResolutions!.push({ entryId: id, expectedRevision: prior.revision, scope: old.scope, decision: value.protectionAssessment.decision, evidence: value.protectionAssessment.evidence, rationale });
      // 旧 pending 映射不能在收敛后残留。覆盖仍待显式决定。
      for (const check of candidate.protectionChecks) if (check.entryIds.includes(id)) { check.entryIds = []; check.decision = 'pending-review'; check.rationale = rationale; }
      this.#organize(candidate); return next;
    });
  }
  reviewLegacy(expected: number, id: string, replacements: MemoryEntryInput[], evidence: EvidenceReference[], rationale: string) {
    return this.#mutate(expected, 'review-legacy', rationale, candidate => {
      const old = candidate.entries.find(row => row.id === id);
      if (old?.format !== 'legacy-unreviewed' || !this.#baseline.some(row => row.id === id) || !replacements.length || replacements.some(row => row.placement !== 'resident')) throw new MemoryWorkspaceError('memory_workspace_legacy_mapping');
      const next = replacements.map(value => this.#add(candidate, value));
      candidate.entries = candidate.entries.filter(row => row.id !== id);
      candidate.legacyCoverage.push({ legacyEntryId: id, replacementEntryIds: next.map(row => row.id), evidence, rationale });
      this.#organize(candidate); return next;
    });
  }
}
