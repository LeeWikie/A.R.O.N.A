import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../../domain.js';
import type { PreparedMemoryContextPolicy } from './binding.js';
import { projectRecentMemory } from './recent.js';
import type { RecentProjection, RecentRecordInput, RecentSelectedRecord } from './recent.js';

type RecentView = Omit<RecentProjection, 'selected' | 'parts'> & {
  selected: (Omit<RecentSelectedRecord, 'originalTextBytes' | 'attachments'> & {
    attachments: Omit<RecentSelectedRecord['attachments'][number], 'bytes'>[];
  })[];
};
import { measureMemoryText } from './tokens.js';
import type { TokenMeasurement } from './tokens.js';

export interface MemoryV1RunView {
  mode: 'shadow' | 'v1'; runId: string; contextId: string; boundAt: string; scopeId: string;
  policy: PreparedMemoryContextPolicy;
  resident: { kind: 'legacy' | 'v1'; version: string; text: string; finalText: string; measurement: TokenMeasurement };
  recent: RecentView;
  exclusions: { currentWorkingSet: string[]; excludedAncestors: string[] };
  modelProfile: string;
  /** 完整资料串；shadow 仅观察，v1 在非持久化 provider 投影中原样使用。 */
  observationText: string;
  measurement: TokenMeasurement;
  injected: boolean;
}

/** 持久化首请求时视图；读取返回独立副本，后台补源不能改动已绑定运行。 */
export class MemoryV1Views {
  constructor(private readonly db: DatabaseSync) {
    db.exec('CREATE TABLE IF NOT EXISTS memory_v1_run_views(run_id TEXT PRIMARY KEY,body TEXT NOT NULL)');
  }
  read(runId: string): MemoryV1RunView | null {
    const row = this.db.prepare('SELECT body FROM memory_v1_run_views WHERE run_id=?').get(runId);
    return row ? JSON.parse(String(row.body)) as MemoryV1RunView : null;
  }
  bind(input: {
    mode?: 'shadow' | 'v1'; residentKind?: 'legacy' | 'v1';
    runId: string; contextId: string; scopeId: string; boundAt: string; policy: PreparedMemoryContextPolicy;
    resident: { version: string; text: string }; records: RecentRecordInput[];
    allows: ReadonlySet<string>; currentWorkingSet: ReadonlySet<string>; excludedAncestors: ReadonlySet<string>; modelProfile: string;
  }): MemoryV1RunView {
    const previous = this.read(input.runId);
    if (previous) { if (previous.contextId !== input.contextId || previous.scopeId !== input.scopeId) throw new AppError('memory_view_binding_conflict', 409); return previous; }
    // 尚无媒体能力的严格宿主绑定，不把未知图片成本视为零或把 bytes 塞给不兼容模型。
    const recent = projectRecentMemory({ records: input.records, asOf: input.boundAt, policy: input.policy, scope: { id: input.scopeId, allows: input.allows }, exclusions: { currentWorkingSet: input.currentWorkingSet, excludedAncestors: input.excludedAncestors }, model: { id: null, supportedImageMediaTypes: new Set() } });
    const { selected, parts: _parts, ...projection } = recent;
    const recentView: RecentView = { ...projection, selected: selected.map(({ originalTextBytes: _bytes, attachments, ...record }) => ({ ...record, attachments: attachments.map(({ bytes: _attachmentBytes, ...attachment }) => attachment) })) };
    const residentText = input.residentKind === 'v1' ? input.resident.text : `常驻记忆（版本 ${input.resident.version}，是可纠正的历史认识，不覆盖新用户要求）：\n${input.resident.text}`;
    if (input.mode === 'v1' && measureMemoryText(residentText).textTokens > input.policy.resident.textTokens) throw new AppError('memory_resident_budget_exceeded', 409);
    const observationText = [residentText, recent.finalText].filter(Boolean).join('\n\n');
    const view: MemoryV1RunView = { mode: input.mode ?? 'shadow', runId: input.runId, contextId: input.contextId, boundAt: input.boundAt, scopeId: input.scopeId, policy: input.policy, resident: { kind: input.residentKind ?? 'legacy', ...input.resident, finalText: residentText, measurement: measureMemoryText(residentText) }, recent: recentView, exclusions: { currentWorkingSet: [...input.currentWorkingSet].sort(), excludedAncestors: [...input.excludedAncestors].sort() }, modelProfile: input.modelProfile, observationText, measurement: measureMemoryText(observationText), injected: input.mode === 'v1' };
    this.db.prepare('INSERT INTO memory_v1_run_views VALUES(?,?)').run(input.runId, JSON.stringify(view));
    return this.read(input.runId)!;
  }
}
