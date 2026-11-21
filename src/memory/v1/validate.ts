import { evidenceRecordSchema, memoryCandidateSchema } from './contracts.js';
import type { EvidenceRecord, EvidenceReference, MemoryScope } from './contracts.js';

export interface ContractIssue { code: string; path: string; message: string }
export interface ContractValidation {
  valid: boolean;
  // 结构合法不表示覆盖完成；未解决的来源或资格缺口不能作为已处理 no-op。
  coverageComplete: boolean;
  issues: ContractIssue[];
}
const refKey = (ref: EvidenceReference) => JSON.stringify([ref.evidenceId, ref.partKey]);
const sameScope = (a: MemoryScope, b: MemoryScope) => a.subjectId === b.subjectId && a.dimension === b.dimension && a.qualifier === b.qualifier;

/** 来源定位须先由宿主验证；正文相同不等于同源，不参与独立经历计数。 */
export function evidenceIdempotencyKey(input: EvidenceRecord): string {
  const record = evidenceRecordSchema.parse(input);
  return JSON.stringify([record.origin.system, record.origin.namespace, record.origin.sourceRef, record.origin.lineageRoot, record.origin.recordRef]);
}

/** 只检查可计算合同，不证明证据的语义、身份或模型判断正确。 */
export function validateMemoryCandidate(input: unknown): ContractValidation {
  const parsed = memoryCandidateSchema.safeParse(input);
  if (!parsed.success) return { valid: false, coverageComplete: false, issues: parsed.error.issues.map(issue => ({ code: 'schema', path: issue.path.join('.'), message: issue.message })) };
  const value = parsed.data;
  const issues: ContractIssue[] = [];
  const fail = (code: string, path: string, message: string) => { issues.push({ code, path, message }); };
  function index<T extends { id: string }>(rows: T[], name: string) {
    const result = new Map<string, T>();
    for (const row of rows) {
      if (result.has(row.id)) fail('duplicate-id', name, '身份不能重复');
      result.set(row.id, row);
    }
    return result;
  }
  const evidence = index(value.evidence, 'evidence');
  const entries = index(value.entries, 'entries');
  const previous = index(value.previousEntries, 'previousEntries');
  const entities = index(value.entities, 'entities');
  const nodes = index(value.organizations, 'organizations');
  index(value.observations, 'observations'); index(value.relations, 'relations');
  const canonical = new Set<string>();
  for (const record of value.evidence) {
    const key = evidenceIdempotencyKey(record);
    if (canonical.has(key)) fail('duplicate-source', 'evidence', '同源重试必须复用证据，不重复计数');
    canonical.add(key);
    if (Date.parse(record.visibleAfter) > Date.parse(value.auditedAt)) fail('future-evidence', 'evidence', '尚未可见的证据不能参与当前候选');
    for (const target of [...record.derivedFrom, ...record.attachments.flatMap(item => item.derivedEvidenceIds)]) {
      if (!evidence.has(target) || target === record.id) fail('evidence-reference', 'evidence', '派生证据必须存在且不能自引');
    }
  }
  function cite(ref: EvidenceReference, path: string, allowMissing = false) {
    const record = evidence.get(ref.evidenceId);
    const part = record?.coverage.parts.find(item => item.key === ref.partKey);
    if (!part || (!allowMissing && part.status !== 'available')) fail('evidence-reference', path, '证据部分不存在或不可用');
    return record;
  }
  function cited(refs: EvidenceReference[], path: string) { for (const ref of refs) cite(ref, path); }
  const operations = new Set<string>();
  for (const observation of value.observations) {
    const { system, namespace, sourceRef, contextRef, operationRef } = observation.identity;
    const key = JSON.stringify([system, namespace, sourceRef, contextRef, operationRef]);
    if (operations.has(key)) fail('duplicate-operation', 'observations', '同一操作的终态必须统一归并，不能分开报告成功与失败');
    operations.add(key);
    const groups = [observation.request.evidence, observation.authorization.evidence, observation.execution.evidence, observation.terminalEvidence.map(item => item.evidence), observation.businessOutcome.evidence];
    for (const ref of groups.flat()) {
      const record = cite(ref, 'observations');
      if (record && (record.origin.system !== observation.identity.system || record.origin.namespace !== observation.identity.namespace || record.origin.sourceRef !== observation.identity.sourceRef || record.origin.contextRef !== observation.identity.contextRef || record.operationRef !== observation.identity.operationRef)) fail('operation-scope', 'observations', '执行证据不能跨来源或操作合并');
    }
    for (const ref of observation.terminalEvidence.map(item => item.evidence)) {
      if (evidence.get(ref.evidenceId)?.kind !== 'tool-result') fail('terminal-evidence', 'observations', '工具终态必须引用结构化工具结果');
    }
    for (const ref of observation.businessOutcome.evidence) {
      if (!['business-outcome', 'user-statement', 'task-report'].includes(evidence.get(ref.evidenceId)?.kind ?? '')) fail('business-evidence', 'observations', '普通工具完成不确认业务结果');
    }
    for (const [refs, kinds] of [[observation.request.evidence, ['task-request', 'tool-action', 'user-statement']], [observation.authorization.evidence, ['authorization']]] as const) {
      for (const ref of refs) if (!(kinds as readonly string[]).includes(evidence.get(ref.evidenceId)?.kind ?? '')) fail('execution-evidence', 'observations', '执行阶段需要对应种类的证据');
    }
    for (const ref of observation.execution.evidence) {
      const hasExit = observation.terminalEvidence.some(event => event.kind === 'command-exit' && refKey(event.evidence) === refKey(ref));
      if (evidence.get(ref.evidenceId)?.kind !== 'execution-status' && !hasExit) fail('execution-evidence', 'observations', '调用请求或普通工具结束不证明实际执行，需要执行状态或进程退出证据');
    }
  }
  for (const entry of value.entries) {
    if (!nodes.has(entry.primaryNodeId) || entry.relatedNodeIds.some(id => !nodes.has(id))) fail('node-reference', 'entries', '组织节点不存在');
    if (entry.entityIds.some(id => !entities.has(id))) fail('entity-reference', 'entries', '实体不存在');
    if (entry.format === 'legacy-unreviewed') continue;
    if (!entry.entityIds.includes(entry.scope.subjectId)) fail('entry-scope', 'entries', '条目适用主体必须引用对应实体');
    const entryRefs = new Set(entry.evidence.map(item => refKey(item.ref)));
    for (const ref of [...entry.protectionAssessment.evidence, ...(entry.protection.mode === 'state' ? entry.protection.establishedBy : []), ...entry.followup.outcomeEvidence]) {
      if (!entryRefs.has(refKey(ref))) fail('entry-evidence', 'entries', '评估、状态及结果证据必须包含在条目来源中');
    }
    cited(entry.evidence.map(item => item.ref), 'entries');
    for (const target of [...entry.derivedFromEntryIds, ...entry.replacedBy]) {
      if ((!entries.has(target) && !previous.has(target)) || target === entry.id) fail('entry-reference', 'entries', '条目引用不存在或自引');
    }
    if (entry.followup.outcome !== 'unknown') {
      const matching = value.observations.some(observation => observation.businessOutcome.state === entry.followup.outcome && entry.followup.outcomeEvidence.every(ref => observation.businessOutcome.evidence.some(item => refKey(item) === refKey(ref))));
      if (!matching) fail('outcome-evidence', 'entries', '确认结果需要相应业务结果观察，不只提供任意引用');
    }
  }
  // 替代边与派生边分开：归纳项派生自旧项且旧项被归纳项替代，不构成环。
  const reviewedEntries = value.entries.filter(entry => entry.format === 'reviewed');
  const remainingReplacements = new Map<string, number>();
  const replacementParents = new Map<string, string[]>();
  for (const entry of reviewedEntries) {
    if (entry.lifecycle !== 'superseded' && entry.replacedBy.length) fail('replacement-lifecycle', 'entries', '只有已被替代条目可以声明替代边');
    let count = 0;
    for (const target of entry.replacedBy) {
      // previousEntries 只是旧快照，不是宿主核验后的归档解析结果。
      // 当前合同没有归档解析接口；不能以旧快照或未审正文补造有效终端。
      if (entries.get(target)?.format !== 'reviewed') {
        fail('replacement-reference', 'entries', '替代目标必须由本候选中的已评估条目承接；旧版本引用需要宿主提供真实归档解析');
        continue;
      }
      count++;
      const parents = replacementParents.get(target) ?? [];
      parents.push(entry.id); replacementParents.set(target, parents);
    }
    remainingReplacements.set(entry.id, count);
  }
  // 从真实终端反向消边；所有分支均须结束，且不使用递归遍历长链。
  const terminals = reviewedEntries.filter(entry => remainingReplacements.get(entry.id) === 0).map(entry => entry.id);
  for (let index = 0; index < terminals.length; index++) {
    for (const parent of replacementParents.get(terminals[index]!) ?? []) {
      const remaining = remainingReplacements.get(parent)! - 1;
      remainingReplacements.set(parent, remaining);
      if (remaining === 0) terminals.push(parent);
    }
  }
  if (terminals.length !== reviewedEntries.length) fail('replacement-cycle', 'entries', '替代图不能有环，每个分支都需要实际承接终端');

  // 仅对精确结构键和重叠有效期判冲突，不推断自然语言中的语义互斥。
  const currentStates = new Map<string, { value: string; start: number; end: number }[]>();
  for (const entry of reviewedEntries) {
    if (entry.protection.mode !== 'state' || entry.lifecycle !== 'current') continue;
    const key = JSON.stringify([entry.scope.subjectId, entry.scope.dimension, entry.scope.qualifier, entry.protection.stateKey]);
    const start = entry.validFrom === null ? -Infinity : Date.parse(entry.validFrom);
    const end = entry.validTo === null ? Infinity : Date.parse(entry.validTo);
    const states = currentStates.get(key) ?? [], stateValue = entry.protection.value;
    if (states.some(state => state.value !== stateValue && start < state.end && state.start < end)) fail('state-conflict', 'entries', '同主体、范围及状态键的重叠当前保护值不能不同，须显式覆盖');
    states.push({ value: stateValue, start, end }); currentStates.set(key, states);
  }
  for (const entity of value.entities) cited(entity.identityEvidence, 'entities');
  for (const relation of value.relations) {
    const entry = entries.get(relation.entryId);
    if (!entities.has(relation.subjectId) || !entities.has(relation.objectId) || !entry || entry.format !== 'reviewed') fail('relation-reference', 'relations', '关系必须引用实体与已评估条目');
    else if (!entry.entityIds.includes(relation.subjectId) || !entry.entityIds.includes(relation.objectId) || entry.validFrom !== relation.validFrom || entry.validTo !== relation.validTo) fail('relation-scope', 'relations', '关系必须与主要条目的实体和有效期一致');
  }
  const primaryCounts = new Map<string, number>();
  for (const node of value.organizations) {
    for (const entryId of node.entryIds) {
      primaryCounts.set(entryId, (primaryCounts.get(entryId) ?? 0) + 1);
      if (entries.get(entryId)?.primaryNodeId !== node.id) fail('primary-body', 'organizations', '正文只能出现在条目的主要节点');
    }
    const visited = new Set<string>([node.id]);
    let parent = node.parentId;
    while (parent !== null) {
      if (visited.has(parent)) { fail('organization-cycle', 'organizations', '组织树不能有环'); break; }
      visited.add(parent);
      const ancestor = nodes.get(parent);
      if (!ancestor) { fail('node-reference', 'organizations', '父节点不存在'); break; }
      parent = ancestor.parentId;
    }
  }
  for (const entry of value.entries) if (primaryCounts.get(entry.id) !== 1) fail('primary-body', 'organizations', '每个条目需要且只能有一份主正文');

  const coverage = new Map<string, typeof value.coverage[number]>();
  const checks = new Map<string, typeof value.protectionChecks[number]>();
  for (const row of value.coverage) {
    const key = refKey(row.ref);
    if (coverage.has(key)) fail('duplicate-coverage', 'coverage', '同一部分只能有一个覆盖决定');
    coverage.set(key, row);
    cite(row.ref, 'coverage', row.decision === 'pending-source');
    if (row.entryIds.some(id => !entries.has(id))) fail('entry-reference', 'coverage', '覆盖条目不存在');
    if (['retained', 'merged'].includes(row.decision) && row.entryIds.length === 0) fail('coverage-reference', 'coverage', '保留与合并需要条目引用');
  }
  for (const check of value.protectionChecks) {
    const key = refKey(check.ref);
    if (checks.has(key)) fail('duplicate-check', 'protectionChecks', '同一部分只能有一个保护检查');
    checks.set(key, check); cite(check.ref, 'protectionChecks', true);
    if (check.decision === 'no-protectable-state' && check.entryIds.length) fail('protection-check', 'protectionChecks', '无保护资格不能同时声明受保护条目');
    if (check.decision === 'mapped' && !check.entryIds.length) fail('protection-check', 'protectionChecks', '保护评估必须映射到条目');
    for (const entryId of check.entryIds) {
      const entry = entries.get(entryId);
      const expectedMode = check.decision === 'pending-review' ? 'pending-review' : 'state';
      if (!entry || entry.format !== 'reviewed' || entry.protection.mode !== expectedMode || !entry.protectionAssessment.evidence.some(ref => refKey(ref) === key)) fail('protection-check', 'protectionChecks', '资格映射需要对应证据、评估结论与保护条目');
    }
    if (check.decision === 'pending-review' && !['pending-review', 'pending-source'].includes(coverage.get(key)?.decision ?? '')) fail('pending-review', 'protectionChecks', '未决资格必须保持待复核覆盖，不能当作 no-op');
  }
  for (const entry of value.entries) if (entry.format === 'reviewed' && entry.protection.mode !== 'none') {
    for (const ref of entry.protectionAssessment.evidence) if (!checks.get(refKey(ref))?.entryIds.includes(entry.id)) fail('protection-check', 'protectionChecks', '保护条目必须出现在对应证据的资格检查中');
  }
  for (const record of value.evidence) for (const part of record.coverage.parts) {
    const key = refKey({ evidenceId: record.id, partKey: part.key });
    if (!coverage.has(key) || !checks.has(key)) fail('unchecked-part', 'coverage', '每部分证据包括 no-op 都需要覆盖与保护资格检查');
    if (part.status === 'unavailable' && coverage.get(key)?.decision !== 'pending-source') fail('source-gap', 'coverage', '来源缺口不能被 no-op 消除');
  }

  const overrides = new Map<string, typeof value.overrides[number]>();
  for (const override of value.overrides) {
    if (overrides.has(override.oldEntryId)) fail('duplicate-override', 'overrides', '旧状态不能被重复覆盖');
    overrides.set(override.oldEntryId, override); cited(override.evidence, 'overrides');
    const prior = previous.get(override.oldEntryId), ended = entries.get(override.oldEntryId), replacement = entries.get(override.newEntryId);
    const old = prior ?? ended;
    if (!old || old.format !== 'reviewed' || old.protection.mode !== 'state' || !ended || ended.format !== 'reviewed' || ended.protection.mode !== 'state' || ended.lifecycle !== 'superseded' || !replacement || replacement.format !== 'reviewed' || replacement.protection.mode !== 'state' || !['current', 'superseded'].includes(replacement.lifecycle) || old.id === replacement.id || ended.replacedBy.length !== 1 || ended.replacedBy[0] !== replacement.id) {
      fail('state-override', 'overrides', '覆盖必须保留受保护结束记录并引用同批的后续保护状态'); continue;
    }
    if (!['current', 'unresolved', 'superseded'].includes(old.lifecycle) || !sameScope(old.scope, ended.scope) || JSON.stringify(old.protection) !== JSON.stringify(ended.protection) || ended.validFrom !== old.validFrom || ended.validTo !== replacement.validFrom || (old.lifecycle === 'superseded' && (old.validTo !== ended.validTo || JSON.stringify(old.replacedBy) !== JSON.stringify(ended.replacedBy)))) fail('state-history', 'overrides', '旧状态结束记录必须保留状态身份并在新状态生效时结束');
    if (!sameScope(ended.scope, override.scope) || !sameScope(ended.scope, replacement.scope) || ended.protection.stateKey !== replacement.protection.stateKey || ended.protection.value === replacement.protection.value) fail('state-scope', 'overrides', '覆盖必须匹配主体、状态维度和范围并改变状态值');
    if (!replacement.validFrom || Date.parse(replacement.validFrom) > Date.parse(value.auditedAt) || (replacement.lifecycle === 'current' && replacement.validTo && Date.parse(replacement.validTo) <= Date.parse(value.auditedAt)) || (old.validFrom && Date.parse(replacement.validFrom) <= Date.parse(old.validFrom)) || (old.lifecycle !== 'superseded' && old.validTo && Date.parse(replacement.validFrom) >= Date.parse(old.validTo))) fail('state-time', 'overrides', '覆盖需要已生效且落在旧状态有效范围内的新状态时间');
    // 首次导入可用同一历史来源描述前后状态；已有当前状态仍需要新证据才能覆盖。
    const establishedBy = replacement.protection.establishedBy;
    if (override.evidence.some(ref => !establishedBy.some(item => refKey(item) === refKey(ref)) || (prior?.format === 'reviewed' && ['current', 'unresolved'].includes(prior.lifecycle) && prior.evidence.some(item => refKey(item.ref) === refKey(ref))))) fail('state-evidence', 'overrides', '覆盖需要对应新状态的依据，已有当前状态不能重用旧证据');
  }
  // 每个结束状态都携带覆盖记录；逐边检查并到达当前状态，不以非空引用代替完整链。
  const chainChecked = new Set<string>();
  for (const entry of value.entries) {
    if (entry.format !== 'reviewed' || entry.protection.mode !== 'state' || entry.lifecycle !== 'superseded') continue;
    if (!overrides.has(entry.id)) fail('state-override', 'entries', '受保护结束状态需要显式覆盖记录');
    const path = new Set<string>();
    let cursor: string | undefined = entry.id;
    while (cursor && !chainChecked.has(cursor)) {
      if (path.has(cursor)) { fail('state-cycle', 'entries', '保护状态覆盖链不能有环'); break; }
      path.add(cursor);
      const current = entries.get(cursor);
      cursor = current?.format === 'reviewed' && current.protection.mode === 'state' && current.lifecycle === 'superseded' ? current.replacedBy[0] : undefined;
    }
    for (const id of path) chainChecked.add(id);
  }

  const resolutions = new Set<string>();
  for (const resolution of value.protectionResolutions ?? []) {
    const count = issues.length;
    if (resolutions.has(resolution.entryId)) fail('protection-resolution', 'protectionResolutions', '同一待复核条目不能重复收敛');
    cited(resolution.evidence, 'protectionResolutions');
    const old = previous.get(resolution.entryId), next = entries.get(resolution.entryId);
    if (!old || old.format !== 'reviewed' || old.protection.mode !== 'pending-review' || !next || next.format !== 'reviewed' || old.revision !== resolution.expectedRevision || next.revision !== old.revision + 1 || next.protectionAssessment.decision !== resolution.decision || !sameScope(old.scope, resolution.scope) || !sameScope(old.scope, next.scope) || next.lifecycle !== old.lifecycle || next.validFrom !== old.validFrom || next.validTo !== old.validTo || next.placement !== 'resident') {
      fail('protection-resolution', 'protectionResolutions', '资格收敛必须对应同一待复核条目的修订、决定、范围和常驻生命周期'); continue;
    }
    const refs = new Set(next.protectionAssessment.evidence.map(refKey));
    if (refs.size !== resolution.evidence.length || resolution.evidence.some(ref => !refs.has(refKey(ref)))) fail('protection-resolution', 'protectionResolutions', '复核证据必须匹配实际新评估的全部来源');
    if (issues.length === count) resolutions.add(resolution.entryId);
  }
  for (const entry of value.entries) {
    if (entry.format !== 'reviewed' || entry.protection.mode !== 'none' || entry.placement !== 'retired' || previous.get(entry.id)?.placement === 'retired') continue;
    if (entry.evidence.some(item => {
      const row = coverage.get(refKey(item.ref));
      return row?.decision !== 'retired-with-reason' || !row.entryIds.includes(entry.id);
    })) fail('retirement-coverage', 'coverage', '淘汰需要对应条目及来源部分的明确覆盖理由');
  }
  const legacyMappings = new Map<string, typeof value.legacyCoverage[number]>();
  for (const mapping of value.legacyCoverage) {
    if (legacyMappings.has(mapping.legacyEntryId)) fail('legacy-coverage', 'legacyCoverage', '旧区块不能重复转换');
    legacyMappings.set(mapping.legacyEntryId, mapping); cited(mapping.evidence, 'legacyCoverage');
    if (previous.get(mapping.legacyEntryId)?.format !== 'legacy-unreviewed' || mapping.replacementEntryIds.some(id => entries.get(id)?.format !== 'reviewed' || entries.get(id)?.placement !== 'resident')) fail('legacy-coverage', 'legacyCoverage', '旧区块必须由已评估常驻条目完整承接');
  }
  for (const old of value.previousEntries) {
    const next = entries.get(old.id);
    if (old.format === 'legacy-unreviewed') {
      if ((!next || JSON.stringify(old) !== JSON.stringify(next)) && !legacyMappings.has(old.id)) fail('legacy-loss', 'entries', '未审旧正文不能静默修改或消失');
    } else if (old.protection.mode === 'state' && old.lifecycle === 'superseded') {
      // 结束身份跨版本保留；正文、评分和存放层可调整，覆盖边仍由本批完整链校验。
      const preserved = next?.format === 'reviewed' && next.protection.mode === 'state' && next.lifecycle === 'superseded' && next.nature === old.nature && next.certainty === old.certainty && sameScope(old.scope, next.scope) && JSON.stringify(next.protection) === JSON.stringify(old.protection) && next.validFrom === old.validFrom && next.validTo === old.validTo && JSON.stringify(next.replacedBy) === JSON.stringify(old.replacedBy);
      if (!preserved) fail('state-history', 'entries', '已结束保护状态必须延续同一结束身份和覆盖引用，不能静默删除或改性质');
    } else if (old.protection.mode !== 'none' && ['current', 'unresolved'].includes(old.lifecycle)) {
      const preserved = next?.format === 'reviewed' && next.protection.mode === old.protection.mode && next.lifecycle === old.lifecycle && next.validFrom === old.validFrom && next.validTo === old.validTo && sameScope(old.scope, next.scope) && JSON.stringify(next.protection) === JSON.stringify(old.protection);
      if (!preserved && !overrides.has(old.id) && !resolutions.has(old.id)) fail('protection-regression', 'entries', '当前保护不能静默退化、转档或消失');
    }
    if (next) {
      const unchanged = JSON.stringify({ ...old, revision: 0 }) === JSON.stringify({ ...next, revision: 0 });
      if (next.revision !== old.revision + (unchanged ? 0 : 1)) fail('revision', 'entries', '修改必须增加一个修订，不修改保持原修订');
    }
  }
  const valid = issues.length === 0;
  const coverageComplete = valid && value.coverage.every(row => row.decision !== 'pending-source' && row.decision !== 'pending-review');
  return { valid, coverageComplete, issues };
}
