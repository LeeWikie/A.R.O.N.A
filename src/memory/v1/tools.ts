import { randomUUID } from 'node:crypto';
import { AppError } from '../../domain.js';
import { assertMemoryModelObject } from './request-budget.js';
import type { MemoryCandidate } from './contracts.js';
import type { MemoryWorkingSet } from './working-set.js';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { coverageDecisionSchema, entitySchema, evidenceReferenceSchema, memoryEntrySchema, organizationNodeSchema, protectionCheckSchema } from './contracts.js';
import { MemoryWorkspace, MemoryWorkspaceError } from './workspace.js';
import type { MemoryEntryInput } from './workspace.js';

const { id: _id, revision: _revision, format: _format, createdInBatch: _created, updatedInBatch: _updated, evidence: _evidence, ...entryFields } = memoryEntrySchema.options[0].shape;
export const memoryEntryInputSchema = z.strictObject({
  ...entryFields,
  evidence: z.array(z.strictObject({ ref: evidenceReferenceSchema, role: z.enum(['supports', 'corrects', 'contradicts', 'context']) })).min(1),
});
const expected = { expectedDraftRevision: z.number().int().nonnegative() };
const reason = { rationale: z.string().trim().min(1).max(8000) };
const identity = { entryId: _id, expectedEntryRevision: _revision };
const entityInput = entitySchema.omit({ id: true });
const organizationInput = organizationNodeSchema.pick({ title: true, parentId: true });
const relationInput = z.strictObject({ subjectId: _id, objectId: _id, kind: z.string().min(1), entryId: _id, validFrom: z.iso.datetime({ offset: true }).nullable(), validTo: z.iso.datetime({ offset: true }).nullable() });

function makeTool<S extends z.ZodType>(id: string, description: string, inputSchema: S, apply: (input: z.output<S>) => unknown, project: (result: unknown) => unknown) {
  return createTool({ id, description, inputSchema, execute: async input => {
    try { return project({ ok: true, value: apply(input as z.output<S>) }); }
    catch (error) {
      if (error instanceof MemoryWorkspaceError) return project({ ok: false, error: error.code, validation: error.validation });
      if (error instanceof AppError) {
        const measured = error as AppError & { textTokens?: unknown; budget?: unknown };
        return project({ ok: false, error: error.code, ...(error.code === 'memory_model_object_capacity' && Number.isSafeInteger(measured.textTokens) && Number.isSafeInteger(measured.budget)
          ? { capacity: { textTokens: measured.textTokens, budget: measured.budget } } : {}) });
      }
      if (error instanceof z.ZodError) return project({ ok: false, error: 'memory_tool_input_invalid' });
      throw error;
    }
  } });
}
function editable(entry: Extract<ReturnType<MemoryWorkspace['export']>['candidate']['entries'][number], { format: 'reviewed' }>): MemoryEntryInput {
  const { id: _id, revision: _revision, format: _format, createdInBatch: _created, updatedInBatch: _updated, evidence, ...rest } = entry;
  return { ...rest, evidence: evidence.map(({ ref, role }) => ({ ref, role })) };
}

/** 工具只封装逻辑操作；身份、来源分组、时钟、基线和文件路径不在模型写入面内。 */
export function createMemoryV1Tools(workspace: MemoryWorkspace, inheritedDetails: readonly { id: string; content: string }[] = [], guards: {
  assertDetails?: (before: readonly { id: string; content: string }[], after: readonly { id: string; content: string }[], candidate: MemoryCandidate) => void;
  assertReady?: (candidate: MemoryCandidate, details: { id: string; content: string }[]) => void;
  workingSet?: MemoryWorkingSet;
} = {}) {
  const details = new Map(inheritedDetails.map(row => [row.id, { ...row }]));
  let readyRevision: number | null = null;
  const projectResult = (result: unknown): unknown => {
    if (!guards.workingSet) return result;
    const response = result as { ok: boolean; value?: { draftRevision?: number; result?: unknown } };
    if (response.ok && response.value && Object.hasOwn(response.value, 'result')) {
      const identity = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(identity);
        if (!value || typeof value !== 'object') return value;
        const row = value as Record<string, unknown>;
        return Object.fromEntries(['id', 'revision', 'detailId'].filter(key => row[key] !== undefined).map(key => [key, row[key]]));
      };
      result = { ok: true, value: { ...response.value, result: identity(response.value.result), stateInCurrentTask: true } };
    }
    try { assertMemoryModelObject(result, 1600); return result; }
    catch (error) {
      if (!(error instanceof AppError) || error.code !== 'memory_model_object_capacity') throw error;
      const row = result as { ok: boolean; error?: string; value?: { ready?: boolean } };
      // 操作已完成的回执不能谎称失败；较大的对象由有界 inspect/句柄继续读取。
      return row.ok ? { ok: true, value: { draftRevision: workspace.draftRevision, ready: row.value?.ready, requiresInspection: true } }
        : { ok: false, error: row.error, draftRevision: workspace.draftRevision, requiresInspection: true };
    }
  };
  const define = <S extends z.ZodType>(id: string, description: string, schema: S, apply: (input: z.output<S>) => unknown) => makeTool(id, description, schema, apply, projectResult);
  const tools = {
    ...(guards.workingSet ? {
      memory_working_set_page: define('memory_working_set_page', '分页读取可定位对象的宿主句柄；不读取路径或额外来源。', z.strictObject({ ...expected, cursor: z.string().optional(), collection: z.enum(['entries', 'entities', 'relations', 'organizations', 'coverage', 'protectionChecks', 'overrides', 'protectionResolutions', 'legacyCoverage', 'observations']).optional() }), x => guards.workingSet!.pageHandles({ revision: x.expectedDraftRevision, cursor: x.cursor, collection: x.collection })),
      memory_working_set_open: define('memory_working_set_open', '将宿主句柄对应的完整旧依赖加入下一次资料包；排队不表示已送达。', z.strictObject({ ...expected, handle: z.string().min(1), mode: z.enum(['edit', 'reference']).optional() }), x => {
        if (x.expectedDraftRevision !== workspace.draftRevision) throw new MemoryWorkspaceError('memory_workspace_stale_draft');
        readyRevision = null;
        return guards.workingSet!.open(x.handle, x.mode === 'reference');
      }),
    } : {}),
    memory_inspect: define('memory_inspect', '读取当前可见候选及修订；旧域通过分页句柄加载，不表示完整历史。', z.strictObject({}), () => {
      const state = workspace.export();
      if (guards.workingSet) {
        // 完整可见快照在每次实际请求的当前任务中刷新，回执不再重复堆积同一快照。
        guards.workingSet.project(state.candidate, state.draftRevision);
        return { draftRevision: state.draftRevision, projectionVersion: 2, completeCandidate: false, stateInCurrentTask: true,
          packetHash: guards.workingSet.packet().packetHash, availableByHandle: true };
      }
      const { previousEntries: _baseline, auditedAt: _at, evidence, observations, ...candidate } = state.candidate;
      return { draft: { draftRevision: state.draftRevision, candidate: { ...candidate,
        evidence: evidence.map(record => ({ id: record.id, kind: record.kind, actor: record.actor, origin: record.origin.system, occurredAt: record.occurredAt, timeBasis: record.timeBasis, coverage: record.coverage })),
        observations: observations.map(({ identity, ...observation }) => ({ ...observation, origin: identity.system })),
      } }, details: [...details.values()] };
    }),
    memory_entry_create: define('memory_entry_create', '创建按信息评估的归纳条目；主体、性质、保留分数、保护资格和证据必须明确。', z.strictObject({ ...expected, ...reason, entry: memoryEntryInputSchema }), x => workspace.createEntry(x.expectedDraftRevision, x.entry, x.rationale)),
    memory_entry_update: define('memory_entry_update', '修改正文、保留分数、关联和分层。scope、protection、replacedBy 保持原样。新证据明确结束普通事项时，可更新正文、证据、lifecycle=historical 及 validTo；保护状态覆盖须用对应转换工具。', z.strictObject({ ...expected, ...identity, ...reason, entry: memoryEntryInputSchema }), x => workspace.updateEntry(x.expectedDraftRevision, x.entryId, x.expectedEntryRevision, x.entry, x.rationale)),
    memory_entry_retire: define('memory_entry_retire', '显式淘汰非保护条目并保留身份和覆盖理由；只改变记忆保留层，不表示业务已结束、取消或完成。业务变化须另用 entry_update 按证据更新正文、生命周期和有效期。', z.strictObject({ ...expected, ...identity, ...reason }), x => workspace.retireEntry(x.expectedDraftRevision, x.entryId, x.expectedEntryRevision, x.rationale)),
    memory_entries_reorganize: define('memory_entries_reorganize', '原子合并或拆分普通条目；替代项完整承接来源，旧身份不删除。', z.strictObject({ ...expected, ...reason, oldEntries: z.array(z.strictObject({ id: _id, revision: _revision })).min(1), replacements: z.array(memoryEntryInputSchema).min(1) }), x => workspace.reorganizeEntries(x.expectedDraftRevision, x.oldEntries, x.replacements, x.rationale)),
    memory_state_replace: define('memory_state_replace', '以新证据覆盖同一主体、维度和范围内的保护状态，保留旧结束链。必须同时填写顶层 evidence（这次覆盖的新证据）和 entry.evidence（新条目内容的依据），validFrom 使用已知有效时间。', z.strictObject({ ...expected, ...identity, ...reason, entry: memoryEntryInputSchema, evidence: z.array(evidenceReferenceSchema).min(1).describe('本次覆盖所依据的新证据引用；与 entry.evidence 分别填写。') }), x => workspace.replaceState(x.expectedDraftRevision, x.entryId, x.expectedEntryRevision, x.entry, x.evidence, x.rationale)),
    memory_protection_resolve: define('memory_protection_resolve', '复核待定保护资格，保持同一命题、有效期和常驻位置。', z.strictObject({ ...expected, ...identity, ...reason, entry: memoryEntryInputSchema }), x => workspace.resolveProtection(x.expectedDraftRevision, x.entryId, x.expectedEntryRevision, x.entry, x.rationale)),
    memory_legacy_review: define('memory_legacy_review', '有充分证据时完整承接未审旧正文；无法证明的认识保持未核对，不删除或移入详情。', z.strictObject({ ...expected, ...identity, ...reason, replacements: z.array(memoryEntryInputSchema).min(1), evidence: z.array(evidenceReferenceSchema).min(1) }), x => {
      const old = workspace.export().candidate.entries.find(row => row.id === x.entryId);
      if (!old || old.revision !== x.expectedEntryRevision) throw new MemoryWorkspaceError('memory_workspace_stale_entry');
      return workspace.reviewLegacy(x.expectedDraftRevision, x.entryId, x.replacements, x.evidence, x.rationale);
    }),
    memory_coverage: define('memory_coverage', '逐部分决定覆盖和保护资格；无新增信息也必须复核，不把缺来源当完成。', z.strictObject({ ...expected, coverage: coverageDecisionSchema, protection: protectionCheckSchema }), x => workspace.decideCoverage(x.expectedDraftRevision, x.coverage, x.protection)),
    memory_entity_create: define('memory_entity_create', '创建有身份证据的人物、组织或主题实体。', z.strictObject({ ...expected, ...reason, entity: entityInput }), x => workspace.createEntity(x.expectedDraftRevision, x.entity, x.rationale)),
    memory_entity_update: define('memory_entity_update', '维护实体名称和别名，不静默替换身份依据。', z.strictObject({ ...expected, ...reason, entityId: _id, entity: entityInput }), x => workspace.updateEntity(x.expectedDraftRevision, x.entityId, x.entity, x.rationale)),
    memory_organization_create: define('memory_organization_create', '创建自组织主题节点；节点身份由宿主分配。', z.strictObject({ ...expected, ...reason, organization: organizationInput }), x => workspace.createOrganization(x.expectedDraftRevision, x.organization, x.rationale)),
    memory_organization_update: define('memory_organization_update', '修改主题标题或父节点，不直接改写条目列表。', z.strictObject({ ...expected, ...reason, organizationId: _id, organization: organizationInput }), x => workspace.updateOrganization(x.expectedDraftRevision, x.organizationId, x.organization, x.rationale)),
    memory_organization_remove: define('memory_organization_remove', '删除不再承载条目或子节点的空主题。', z.strictObject({ ...expected, ...reason, organizationId: _id }), x => workspace.removeOrganization(x.expectedDraftRevision, x.organizationId, x.rationale)),
    memory_relation: define('memory_relation', '关联实体与事实条目；有效期必须与事实一致，已有关系不换身份。', z.strictObject({ ...expected, ...reason, expectedEntryRevision: _revision, relationId: _id.nullable(), relation: relationInput }), x => {
      const entry = workspace.export().candidate.entries.find(entry => entry.id === x.relation.entryId);
      if (!entry || entry.revision !== x.expectedEntryRevision) throw new MemoryWorkspaceError('memory_workspace_stale_entry');
      return workspace.setRelation(x.expectedDraftRevision, x.relationId, x.relation, x.rationale);
    }),
    memory_detail_put: define('memory_detail_put', '写入条目引用的详细档案。仅逻辑 ID，不接受路径；常驻条目仍须完整表达需要注入的认识。', z.strictObject({ ...expected, ...identity, ...reason, detailId: _id.nullable(), content: z.string().min(1).max(200000) }), x => {
      const entry = workspace.export().candidate.entries.find(row => row.id === x.entryId);
      if (!entry || entry.format !== 'reviewed') throw new MemoryWorkspaceError('memory_workspace_entry_not_reviewed');
      if (x.detailId !== null && (!entry.detailRefs.includes(x.detailId) || !details.has(x.detailId))) throw new MemoryWorkspaceError('memory_workspace_unknown_detail');
      if (x.detailId !== null && workspace.export().candidate.entries.some(other => other.id !== entry.id && other.format === 'reviewed' && other.detailRefs.includes(x.detailId!))) throw new MemoryWorkspaceError('memory_workspace_shared_detail');
      const id = x.detailId ?? `detail:${randomUUID()}`;
      const nextDetail = { id, content: x.content };
      const result = workspace.updateEntry(x.expectedDraftRevision, entry.id, x.expectedEntryRevision, { ...editable(entry), detailRefs: [...new Set([...entry.detailRefs, id])] }, x.rationale, candidate => {
        // 候选、修订和审计安装前完成详情预检，失败时两份状态都保持原样。
        assertMemoryModelObject([nextDetail], 4096);
        const next = new Map(details); next.set(id, nextDetail);
        guards.assertDetails?.([...details.values()], [...next.values()], candidate);
      });
      details.set(id, nextDetail); return { ...result, detailId: id };
    }),
    memory_ready: define('memory_ready', '完成本批维护并声明当前草稿可交独立复核；不直接发布。', z.strictObject({ ...expected }), x => {
      readyRevision = null;
      if (x.expectedDraftRevision !== workspace.draftRevision) throw new MemoryWorkspaceError('memory_workspace_stale_draft');
      const candidate = workspace.export().candidate;
      const refs = new Set(candidate.entries.flatMap(entry => entry.format === 'reviewed' ? entry.detailRefs : []));
      if ([...refs].some(id => !details.has(id))) throw new MemoryWorkspaceError('memory_workspace_unknown_detail');
      guards.assertReady?.(candidate, [...details.values()].filter(row => refs.has(row.id)).map(row => ({ ...row })));
      readyRevision = x.expectedDraftRevision; return { ready: true, draftRevision: readyRevision, validation: workspace.check() };
    }),
  };
  return {
    tools,
    resetReady: () => { readyRevision = null; },
    isReady: () => readyRevision === workspace.draftRevision,
    details: () => {
      const refs = new Set(workspace.export().candidate.entries.flatMap(entry => entry.format === 'reviewed' ? entry.detailRefs : []));
      if ([...refs].some(id => !details.has(id))) throw new MemoryWorkspaceError('memory_workspace_unknown_detail');
      return [...details.values()].filter(row => refs.has(row.id)).map(row => ({ ...row }));
    },
  };
}
