import { createHash } from 'node:crypto';
import { z } from 'zod';
import { memoryEntrySchema, organizationNodeSchema, tokenMeasurementSchema, versionManifestSchema } from './contracts.js';
import type { MemoryEntry, OrganizationNode, VersionManifest } from './contracts.js';
import { resolveMemoryContextPolicy } from './binding.js';
import type { PreparedMemoryContextPolicy } from './binding.js';
import { memoryContextPolicySchema } from './policy.js';
import type { MemoryContextPolicy } from './policy.js';
import { measureMemoryText } from './tokens.js';
import type { TokenMeasurement } from './tokens.js';

export type MemoryResidentVersionIdentity = Pick<VersionManifest, 'id' | 'parentVersionId' | 'generation'>;

export interface MemoryResidentRenderInput {
  readonly version: Readonly<MemoryResidentVersionIdentity>;
  readonly entries: readonly MemoryEntry[];
  readonly organizations: readonly OrganizationNode[];
  readonly policy: MemoryContextPolicy | PreparedMemoryContextPolicy;
  readonly modelId?: string | null;
}

export interface MemoryResidentFile {
  readonly path: string;
  readonly layer: 'resident';
  readonly content: string;
  readonly sha256: string;
  readonly entryIds: readonly string[];
}

type EntryMetadata = MemoryEntry extends infer Entry ? Entry extends MemoryEntry ? Omit<Entry, 'text'> : never : never;
type Frozen<T> = T extends object ? { readonly [Key in keyof T]: Frozen<T[Key]> } : T;

export interface MemoryResidentDraft {
  /** 后续注入须原样使用；不再增加未计量的标题、路径或外层封装。 */
  readonly finalText: string;
  readonly sha256: string;
  readonly entryIds: readonly string[];
  readonly files: readonly MemoryResidentFile[];
  readonly measurement: Readonly<TokenMeasurement>;
  /** 配套定位信息不是常驻正文，也不是已经发布的 manifest。 */
  readonly metadata: Frozen<{
    version: MemoryResidentVersionIdentity;
    policy: PreparedMemoryContextPolicy;
    entries: EntryMetadata[];
    organizations: OrganizationNode[];
  }>;
  readonly diagnostics: {
    readonly budget: number;
    readonly excessTextTokens: number;
    readonly requiredEntryIds: readonly string[];
    /** 当前保护、待复核和未审旧文的现有表达；不是语义最短表达的证明。 */
    readonly requiredSubsetMeasurement: Readonly<TokenMeasurement>;
  };
}

export class MemoryResidentStructureError extends Error {
  constructor(readonly code: string, readonly identity: string | null = null) {
    super(code);
    this.name = 'MemoryResidentStructureError';
  }
}

export class MemoryResidentBudgetExceededError extends RangeError {
  readonly code = 'memory_resident_budget_exceeded';

  constructor(readonly draft: MemoryResidentDraft) {
    super(`memory_resident_budget_exceeded: ${draft.measurement.textTokens} > ${draft.diagnostics.budget}`);
    this.name = 'MemoryResidentBudgetExceededError';
  }
}

const inputSchema = z.strictObject({
  version: z.strictObject({
    id: versionManifestSchema.shape.id,
    parentVersionId: versionManifestSchema.shape.parentVersionId,
    generation: versionManifestSchema.shape.generation,
  }),
  entries: z.array(memoryEntrySchema),
  organizations: z.array(organizationNodeSchema),
  policy: memoryContextPolicySchema,
  modelId: z.string().min(1).nullable().optional(),
});
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const compareIds = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
function fail(code: string, identity: string): never {
  throw new MemoryResidentStructureError(code, identity);
}

function freeze<T>(value: T): Frozen<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as Frozen<T>;
}

function index<T extends { id: string }>(items: T[], code: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    if (result.has(item.id)) fail(code, item.id);
    result.set(item.id, item);
  }
  return result;
}

/** 防御局部结构绕过；不替代来源证明、完整候选、跨版本承接和语义复核。 */
function checkOrganization(entries: MemoryEntry[], organizations: OrganizationNode[]): Map<string, OrganizationNode> {
  const entryById = index(entries, 'memory_render_duplicate_entry');
  const nodes = index(organizations, 'memory_render_duplicate_node');
  const primarySeen = new Set<string>();
  for (const node of organizations) {
    if (node.parentId !== null && !nodes.has(node.parentId)) fail('memory_render_dangling_parent', node.id);
    for (const entryId of node.entryIds) {
      const entry = entryById.get(entryId);
      if (!entry) fail('memory_render_dangling_entry', entryId);
      if (primarySeen.has(entryId)) fail('memory_render_duplicate_body', entryId);
      if (entry.primaryNodeId !== node.id) fail('memory_render_wrong_primary_node', entryId);
      primarySeen.add(entryId);
    }
  }
  // 每条父链只确认一次，空节点上的环同样不能被跳过。迭代遍历不依赖递归深度。
  const finished = new Set<string>();
  for (const node of organizations) {
    const visiting = new Set<string>();
    let current: OrganizationNode | undefined = node;
    while (current && !finished.has(current.id)) {
      if (visiting.has(current.id)) fail('memory_render_organization_cycle', current.id);
      visiting.add(current.id);
      current = current.parentId === null ? undefined : nodes.get(current.parentId);
    }
    for (const nodeId of visiting) finished.add(nodeId);
  }
  for (const entry of entries) {
    if (!nodes.has(entry.primaryNodeId) || entry.relatedNodeIds.some(id => !nodes.has(id))) fail('memory_render_dangling_node', entry.id);
    if (!primarySeen.has(entry.id)) fail('memory_render_missing_body', entry.id);
  }
  return nodes;
}

const natureLabels = { fact: '事实', intent: '意图', preference: '偏好', commitment: '承诺', suggestion: '建议', inference: '推断', action: '行动', result: '结果' } as const;
const certaintyLabels = { reported: '陈述', observed: '观察', inferred: '推断', unknown: '未知' } as const;
const lifecycleLabels = { current: '当前', historical: '历史', superseded: '已被替代', unresolved: '未决' } as const;

function renderEntry(entry: MemoryEntry): string {
  // 旧文不添加评分或推断标注；正文的字符、空白、Markdown 和业务 JSON 均原样保留。
  if (entry.format === 'legacy-unreviewed') return entry.text;
  const context = [
    `主体：${JSON.stringify(entry.scope.subjectId)}`,
    `维度：${JSON.stringify(entry.scope.dimension)}`,
    `范围：${JSON.stringify(entry.scope.qualifier)}`,
    `性质：${natureLabels[entry.nature]}`,
    `确定性：${certaintyLabels[entry.certainty]}`,
    `时态：${lifecycleLabels[entry.lifecycle]}`,
  ];
  if (entry.validFrom !== null) context.push(`起始：${entry.validFrom}`);
  if (entry.validTo !== null) context.push(`截止：${entry.validTo}`);
  return `${context.join('；')}\n\n${entry.text}`;
}

function required(entry: MemoryEntry): boolean {
  return entry.format === 'legacy-unreviewed'
    || entry.protection.mode === 'pending-review'
    || (entry.protection.mode === 'state' && (entry.lifecycle === 'current' || entry.lifecycle === 'unresolved'));
}

function assemble(
  version: MemoryResidentVersionIdentity,
  resident: MemoryEntry[],
  nodes: Map<string, OrganizationNode>,
): { finalText: string; files: MemoryResidentFile[] } {
  if (resident.length === 0) return { finalText: '', files: [] };
  const byNode = new Map<string, MemoryEntry[]>();
  for (const entry of resident) {
    const rows = byNode.get(entry.primaryNodeId) ?? [];
    rows.push(entry);
    byNode.set(entry.primaryNodeId, rows);
  }
  const sections: string[] = [];
  // 只给有常驻正文的节点生成章节；祖先只作为路径线索，不重复主正文或相关正文。
  for (const node of [...nodes.values()].sort(compareIds)) {
    const rows = byNode.get(node.id);
    if (!rows) continue;
    const titles: string[] = [];
    let ancestor: OrganizationNode | undefined = node;
    while (ancestor) {
      titles.push(JSON.stringify(ancestor.title));
      ancestor = ancestor.parentId === null ? undefined : nodes.get(ancestor.parentId);
    }
    sections.push(`## ${titles.reverse().join(' / ')}\n\n${rows.map(renderEntry).join('\n\n')}`);
  }
  const content = sections.join('\n\n');
  // 文件粒度不与目录深度、保留分数或归纳层次绑定；标题永不参与文件路径。
  const path = `resident/${sha256(version.id)}.md`;
  const files: MemoryResidentFile[] = [{
    path, layer: 'resident', content, sha256: sha256(content), entryIds: resident.map(entry => entry.id),
  }];
  const finalText = `# 归纳记忆\n版本：${JSON.stringify(version.id)}\n父版本：${JSON.stringify(version.parentVersionId)}\n代次：${version.generation}\n\n文件：${path}\n\n${content}`;
  return { finalText, files };
}

/** 纯数据渲染，允许超预算草稿；不读取资料、不改写正文、不创建任务或发布版本。 */
export function renderMemoryResidentDraft(input: MemoryResidentRenderInput): MemoryResidentDraft {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new MemoryResidentStructureError('memory_render_schema');
  const { version, entries, organizations, policy: configuration, modelId } = parsed.data;
  const policy = resolveMemoryContextPolicy(configuration);
  const nodes = checkOrganization(entries, organizations);
  entries.sort(compareIds);
  organizations.sort(compareIds);
  // 引用集合规范排序只影响配套元数据；输入经过 schema 复制，不变更宿主记录。
  for (const entry of entries) {
    entry.relatedNodeIds.sort();
    entry.entityIds.sort();
  }
  for (const node of organizations) node.entryIds.sort();
  const resident = entries.filter(entry => entry.placement === 'resident');
  const rendered = assemble(version, resident, nodes);
  const options = { modelId };
  const measurement = measureMemoryText(rendered.finalText, options);
  tokenMeasurementSchema.parse(measurement);
  const requiredEntries = resident.filter(required);
  const requiredSubsetMeasurement = measureMemoryText(assemble(version, requiredEntries, nodes).finalText, options);
  tokenMeasurementSchema.parse(requiredSubsetMeasurement);
  return freeze({
    ...rendered,
    sha256: measurement.inputHash,
    entryIds: resident.map(entry => entry.id),
    measurement,
    metadata: {
      version, policy,
      entries: entries.map(({ text: _text, ...metadata }) => metadata),
      organizations,
    },
    diagnostics: {
      budget: policy.resident.textTokens,
      excessTextTokens: Math.max(0, measurement.textTokens - policy.resident.textTokens),
      requiredEntryIds: requiredEntries.map(entry => entry.id),
      requiredSubsetMeasurement,
    },
  });
}

/** 从原始输入重新渲染并断言实际预算；通过也不表示候选语义或发布条件已通过。 */
export function assertMemoryResidentBudget(input: MemoryResidentRenderInput): MemoryResidentDraft {
  const draft = renderMemoryResidentDraft(input);
  if (draft.diagnostics.excessTextTokens > 0) throw new MemoryResidentBudgetExceededError(draft);
  return draft;
}
