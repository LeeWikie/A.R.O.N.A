import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MemoryFiles } from '../files.js';
import { memoryCandidateSchema, memoryEntrySchema, versionManifestSchema } from './contracts.js';
import type { MemoryEntry, VersionManifest } from './contracts.js';
import { memoryWorkspaceExportSchema } from './workspace.js';
import type { MemoryWorkspaceExport } from './workspace.js';
import { memoryContextPolicySchema } from './policy.js';
import type { MemoryContextPolicy } from './policy.js';
import { assertMemoryResidentBudget } from './render.js';
import type { MemoryResidentDraft, MemoryResidentVersionIdentity } from './render.js';
import { validateMemoryCandidate } from './validate.js';

const format = 'shittimchest-memory-v1' as const;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => `${JSON.stringify(value)}\n`;
const idSchema = memoryEntrySchema.options[0].shape.id;
const identitySchema = z.strictObject({ id: idSchema, parentVersionId: idSchema.nullable(), generation: z.number().int().positive() });
const detailSchema = z.strictObject({ id: idSchema, content: z.string() });
const metadataSchema = memoryWorkspaceExportSchema.omit({ candidate: true }).extend({
  candidate: memoryCandidateSchema.omit({ previousEntries: true }),
  previousEntryHashes: z.array(z.strictObject({ id: idSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) })),
  policy: memoryContextPolicySchema, modelId: z.string().min(1).nullable(),
  details: z.array(z.strictObject({ id: idSchema, path: z.string().min(1) })),
});
const envelopeSchema = z.strictObject({ format: z.literal(format), manifest: versionManifestSchema });
const writeSchema = z.strictObject({
  workspace: memoryWorkspaceExportSchema, version: identitySchema, policy: memoryContextPolicySchema,
  modelId: z.string().min(1).nullable().optional(), details: z.array(detailSchema).optional(),
});
const anchorSchema = z.strictObject({ manifestHash: z.string().regex(/^[a-f0-9]{64}$/), version: identitySchema });
export interface MemoryVersionWriteInput {
  workspace: MemoryWorkspaceExport;
  version: MemoryResidentVersionIdentity;
  policy: MemoryContextPolicy;
  modelId?: string | null;
  /** 只接受逻辑 ID；实际路径由宿主计算，且必须被条目的 detailRefs 引用。 */
  details?: { id: string; content: string }[];
}
export interface MemoryVersionAnchor { manifestHash: string; version: MemoryResidentVersionIdentity }
export interface MemoryVersionRead {
  manifestHash: string;
  manifest: VersionManifest;
  workspace: MemoryWorkspaceExport;
  details: { id: string; content: string }[];
  draft: MemoryResidentDraft;
  finalText: string;
}
export class MemoryVersionFilesError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'MemoryVersionFilesError'; }
}
interface PlannedFile { path: string; layer: VersionManifest['files'][number]['layer']; entryIds: string[]; content: string }
function fail(code: string): never { throw new MemoryVersionFilesError(code); }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function validateWorkspace(workspace: MemoryWorkspaceExport) {
  if (!validateMemoryCandidate(workspace.candidate).valid) fail('memory_version_candidate_invalid');
  const groups = new Map(workspace.supportGroups.map(row => [JSON.stringify(row.ref), row.group]));
  if (groups.size !== workspace.supportGroups.length) fail('memory_version_groups_invalid');
  const refs = new Set<string>();
  for (const record of workspace.candidate.evidence) for (const part of record.coverage.parts) {
    const ref = JSON.stringify({ evidenceId: record.id, partKey: part.key }); refs.add(ref);
    if (part.status === 'available' && !groups.has(ref)) fail('memory_version_groups_invalid');
  }
  if ([...groups.keys()].some(ref => !refs.has(ref))) fail('memory_version_groups_invalid');
  for (const entry of workspace.candidate.entries) if (entry.format === 'reviewed') for (const item of entry.evidence) {
    if (groups.get(JSON.stringify(item.ref)) !== item.supportGroup) fail('memory_version_groups_invalid');
  }
  if (workspace.audit.length !== workspace.draftRevision) fail('memory_version_audit_invalid');
  for (const [index, audit] of workspace.audit.entries()) {
    if (audit.draftRevision !== index + 1 || (index && workspace.audit[index - 1]!.afterHash !== audit.beforeHash)) fail('memory_version_audit_invalid');
  }
  if (workspace.audit.length && workspace.audit.at(-1)!.afterHash !== hash(JSON.stringify(workspace.candidate))) fail('memory_version_audit_invalid');
}

/** 每个实例绑定一个独立版本目录；不识别旧目录、不更新 current 指针。 */
export class MemoryVersionFiles {
  readonly #files: MemoryFiles;
  constructor(readonly root: string) { this.#files = new MemoryFiles(root); }

  /** 根身份、跨平台路径与目录遍历沿用 MemoryFiles；描述符再次核对链接及文件身份。 */
  #readText(relative: string): string {
    const target = this.#files.resolve(relative), before = fs.lstatSync(target, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) fail('memory_version_file_type');
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== before.dev || opened.ino !== before.ino) fail('memory_version_file_changed');
      const bytes = fs.readFileSync(fd), text = bytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(bytes)) fail('memory_version_invalid_utf8');
      const after = fs.lstatSync(this.#files.resolve(relative), { bigint: true });
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1n || after.size !== BigInt(bytes.length)) fail('memory_version_file_changed');
      return text;
    } finally { fs.closeSync(fd); }
  }
  #plan(input: MemoryVersionWriteInput): { files: PlannedFile[]; manifest: VersionManifest; draft: MemoryResidentDraft } {
    const { workspace, version, policy, modelId = null, details = [] } = writeSchema.parse(input);
    validateWorkspace(workspace);
    if (workspace.baseVersion !== version.parentVersionId) fail('memory_version_parent_mismatch');
    const draft = assertMemoryResidentBudget({ version, policy, entries: workspace.candidate.entries, organizations: workspace.candidate.organizations, modelId });
    const { previousEntries, ...candidate } = workspace.candidate;
    const detailById = new Map(details.map(row => [row.id, row]));
    if (detailById.size !== details.length) fail('memory_version_duplicate_detail');
    const references = new Set(candidate.entries.flatMap(entry => entry.format === 'reviewed' ? entry.detailRefs : []));
    if (references.size !== detailById.size || [...references].some(id => !detailById.has(id))) fail('memory_version_detail_reference');
    const detailRows = [...detailById.values()].sort((a, b) => a.id.localeCompare(b.id));
    const metadata = metadataSchema.parse({
      baseVersion: workspace.baseVersion, draftRevision: workspace.draftRevision, audit: workspace.audit,
      supportGroups: workspace.supportGroups, candidate,
      previousEntryHashes: previousEntries.map(entry => ({ id: entry.id, sha256: hash(JSON.stringify(entry)) })),
      policy: draft.metadata.policy, modelId,
      details: detailRows.map(row => ({ id: row.id, path: `detail/documents/${hash(row.id)}.md` })),
    });
    const files: PlannedFile[] = [
      { path: 'metadata/state.json', layer: 'metadata', entryIds: [], content: json(metadata) },
      // raw 仅存定位与指纹。内容由外部不可覆盖来源保管，不复制正文快照。
      { path: 'raw/references.json', layer: 'raw', entryIds: [], content: json(candidate.evidence.map(record => ({ id: record.id, origin: record.origin, contentRef: record.contentRef, contentHash: record.contentHash, attachments: record.attachments }))) },
      ...draft.files.map(file => ({ ...file, entryIds: [...file.entryIds] })),
      ...candidate.entries.filter(entry => entry.placement === 'detail').map(entry => ({ path: `detail/entries/${hash(entry.id)}.md`, layer: 'detail' as const, entryIds: [entry.id], content: entry.text })),
      ...detailRows.map(row => ({ path: `detail/documents/${hash(row.id)}.md`, layer: 'detail' as const, entryIds: candidate.entries.filter(entry => entry.format === 'reviewed' && entry.detailRefs.includes(row.id)).map(entry => entry.id), content: row.content })),
    ];
    // 元数据中的条目正文是规范内容，resident/detail 是可重建投影，读取时逐字比对。
    const manifest = versionManifestSchema.parse({
      schemaVersion: 1, ...version, auditedAt: candidate.auditedAt, policyRevision: draft.metadata.policy.revision,
      residentInjection: 'all', measurement: draft.measurement,
      files: files.map(file => ({ path: file.path, layer: file.layer, entryIds: file.entryIds, sha256: hash(file.content) })),
    });
    return { files, manifest, draft };
  }

  /** 只写全新的候选目录，manifest 最后落盘；返回哈希必须由发布事务在目录外锚定。 */
  write(input: MemoryVersionWriteInput): MemoryVersionRead {
    const planned = this.#plan(input);
    if (this.#files.list().length) fail('memory_version_not_empty');
    const lockPath = this.#files.resolve('writing.lock');
    const lock = fs.openSync(lockPath, 'wx', 0o600);
    const identity = fs.fstatSync(lock, { bigint: true });
    try {
      for (const file of planned.files) {
        const target = this.#files.resolve(file.path);
        if (fs.existsSync(target)) fail('memory_version_already_exists');
        this.#files.write(file.path, file.content);
        if (this.#readText(file.path) !== file.content) fail('memory_version_write_mismatch');
      }
      const manifestText = json({ format, manifest: planned.manifest });
      this.#files.write('manifest.json', manifestText);
      const current = fs.lstatSync(this.#files.resolve('writing.lock'), { bigint: true });
      if (current.dev !== identity.dev || current.ino !== identity.ino || current.nlink !== 1n) fail('memory_version_lock_changed');
      fs.unlinkSync(lockPath);
      return this.read({ manifestHash: hash(manifestText), version: input.version }, input.workspace.candidate.previousEntries);
    } finally {
      fs.closeSync(lock);
      // 不追随或删除被替换的锁；失败目录保留为不可发布的诊断材料。
      const target = this.#files.resolve('writing.lock');
      try {
        const current = fs.lstatSync(target, { bigint: true });
        if (current.dev === identity.dev && current.ino === identity.ino && current.nlink === 1n) fs.unlinkSync(target);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }

  /** expected 必须来自宿主持久指针；不根据磁盘自报版本或计数建立信任。 */
  read(expected: MemoryVersionAnchor, previousEntries: readonly MemoryEntry[]): MemoryVersionRead {
    const anchor = anchorSchema.parse(expected);
    const manifestText = this.#readText('manifest.json');
    if (hash(manifestText) !== anchor.manifestHash) fail('memory_version_anchor_mismatch');
    const { manifest } = envelopeSchema.parse(JSON.parse(manifestText));
    if (manifest.id !== anchor.version.id || manifest.parentVersionId !== anchor.version.parentVersionId || manifest.generation !== anchor.version.generation) fail('memory_version_identity_mismatch');
    const expectedPaths = ['manifest.json', ...manifest.files.map(file => file.path)].sort();
    if (JSON.stringify(this.#files.list().map(file => file.path).sort()) !== JSON.stringify(expectedPaths)) fail('memory_version_file_set_mismatch');
    const contents = new Map<string, string>();
    for (const file of manifest.files) {
      if (file.path === 'manifest.json') fail('memory_version_manifest_recursion');
      const content = this.#readText(file.path);
      if (hash(content) !== file.sha256) fail('memory_version_hash_mismatch');
      contents.set(file.path, content);
    }
    const metadataText = contents.get('metadata/state.json');
    if (metadataText === undefined) fail('memory_version_metadata_missing');
    const metadata = metadataSchema.parse(JSON.parse(metadataText));
    const baseline = z.array(memoryEntrySchema).parse(previousEntries);
    const baselineHashes = baseline.map(entry => ({ id: entry.id, sha256: hash(JSON.stringify(entry)) }));
    if (JSON.stringify(baselineHashes) !== JSON.stringify(metadata.previousEntryHashes)) fail('memory_version_baseline_mismatch');
    const workspace = memoryWorkspaceExportSchema.parse({
      baseVersion: metadata.baseVersion, draftRevision: metadata.draftRevision, audit: metadata.audit,
      supportGroups: metadata.supportGroups, candidate: { ...metadata.candidate, previousEntries: baseline },
    });
    const details = metadata.details.map(row => {
      if (row.path !== `detail/documents/${hash(row.id)}.md`) fail('memory_version_detail_path');
      const content = contents.get(row.path);
      if (content === undefined) fail('memory_version_detail_missing');
      return { id: row.id, content };
    });
    // 用实际编码资源、规范正文及封装重新生成，不能只相信 measurement 的 schema。
    const regenerated = this.#plan({ workspace, version: anchor.version, policy: metadata.policy, modelId: metadata.modelId, details });
    if (JSON.stringify(regenerated.manifest) !== JSON.stringify(manifest)) fail('memory_version_manifest_mismatch');
    for (const file of regenerated.files) if (contents.get(file.path) !== file.content) fail('memory_version_projection_mismatch');
    // 再核根、文件集合与 manifest，拒绝检查过程中的目录替换或增删。
    if (this.#readText('manifest.json') !== manifestText || JSON.stringify(this.#files.list().map(file => file.path).sort()) !== JSON.stringify(expectedPaths)) fail('memory_version_file_changed');
    return freeze({ manifestHash: anchor.manifestHash, manifest, workspace, details, draft: regenerated.draft, finalText: regenerated.draft.finalText });
  }
}
