import type { MemoryEntry } from './contracts.js';
import type { MemoryVersionRead } from './version-files.js';
import type { MemoryV1RunView } from './view.js';

/** 控制面只呈现产品资料；来源证明、原生身份和存储布局不作为 DTO 发送。 */
export function publicMemoryEntry(entry: MemoryEntry) {
  const common = { id: entry.id, revision: entry.revision, format: entry.format, text: entry.text, placement: entry.placement, primaryNodeId: entry.primaryNodeId, relatedNodeIds: entry.relatedNodeIds, entityIds: entry.entityIds };
  return entry.format === 'legacy-unreviewed' ? common : {
    ...common, nature: entry.nature, certainty: entry.certainty, lifecycle: entry.lifecycle,
    scope: entry.scope, validFrom: entry.validFrom, validTo: entry.validTo, retention: entry.retention,
    protectionAssessment: { decision: entry.protectionAssessment.decision, rationale: entry.protectionAssessment.rationale },
    protection: entry.protection.mode === 'state' ? { mode: entry.protection.mode, stateKey: entry.protection.stateKey, value: entry.protection.value, overrideRule: entry.protection.overrideRule } : entry.protection,
    followup: { attention: entry.followup.attention, outcome: entry.followup.outcome },
    abstraction: entry.abstraction, detailRefs: entry.detailRefs,
  };
}
export function publicMemoryVersion(version: MemoryVersionRead) {
  return { id: version.manifest.id, generation: version.manifest.generation, parentVersionId: version.manifest.parentVersionId,
    auditedAt: version.manifest.auditedAt, measurement: version.draft.measurement,
    entries: version.workspace.candidate.entries.map(publicMemoryEntry),
    organizations: version.workspace.candidate.organizations,
    entities: version.workspace.candidate.entities.map(({ id, kind, name, aliases }) => ({ id, kind, name, aliases })),
    relations: version.workspace.candidate.relations,
    details: version.details,
  };
}
export function publicMemoryRunView(view: MemoryV1RunView | null) {
  if (!view) return null;
  return { mode: view.mode, runId: view.runId, contextId: view.contextId, boundAt: view.boundAt, injected: view.injected,
    policy: view.policy, measurement: view.measurement,
    resident: { version: view.resident.version, kind: view.resident.kind, text: view.resident.text, measurement: view.resident.measurement },
    recent: { measurement: view.recent.measurement, selected: view.recent.selected.map(row => ({ originalText: row.originalText, time: row.time, coverage: row.coverage.status,
      attachments: row.attachments.map(item => ({ mediaType: item.mediaType, status: item.status, reason: item.reason })) })),
      omissions: view.recent.omissions.map(item => ({ reason: item.reason })) },
  };
}

export function publicMemoryVersionDiff(from: MemoryVersionRead, to: MemoryVersionRead) {
  const before = publicMemoryVersion(from), after = publicMemoryVersion(to);
  const changes: { collection: string; id: string; before: unknown; after: unknown }[] = [];
  for (const collection of ['entries', 'entities', 'relations', 'organizations', 'details'] as const) {
    const old = new Map<string, unknown>(before[collection].map(row => [row.id, row]));
    const next = new Map<string, unknown>(after[collection].map(row => [row.id, row]));
    for (const id of new Set([...old.keys(), ...next.keys()])) if (JSON.stringify(old.get(id)) !== JSON.stringify(next.get(id))) changes.push({ collection, id, before: old.get(id) ?? null, after: next.get(id) ?? null });
  }
  return { from: before.id, to: after.id, changes };
}
