import { createHash } from 'node:crypto';
import type { Core } from './core.js';
import { AppError } from './domain.js';
import type { InteractionReference } from './interactions.js';
import type { TaskRecord } from './runtime-store.js';

/** Read-only provenance for a new user input; never answers or resumes the old interaction. */
export function interactionReference(core: Core, id: string, expectedRunId: string): InteractionReference {
  const interaction = core.interactions().find(row => row.id === id);
  if (!interaction) throw new AppError('interaction_not_found', 404);
  if (interaction.runId !== expectedRunId) throw new AppError('run_changed', 409);
  const run = core.store.getRun(expectedRunId);
  const original = core.runtime.context(interaction.contextId);
  const identity = 'interaction.' + createHash('sha256').update(JSON.stringify([interaction.contextId, interaction.runId, interaction.toolCallId])).digest('hex');
  if (!run || run.contextId !== interaction.contextId || interaction.id !== identity || !original) throw new AppError('interaction_reference_changed', 409);
  const reference: InteractionReference = { interaction, taskIds: [] };
  const main = (contextId: string) => {
    const destination = core.runtime.context(contextId);
    if (!destination || destination.archived || destination.role !== 'main') return false;
    reference.target = { contextId: destination.id, name: destination.name, workspaceId: destination.workspaceId }; return true;
  };
  if (original.role === 'main') {
    if (!main(original.id)) reference.unavailable = 'interaction_destination_unavailable';
    return reference;
  }
  const owners = core.runtime.tasks({ contextId: original.id }).filter(task => task.runIds.includes(expectedRunId));
  if (owners.length !== 1) return { ...reference, unavailable: 'interaction_origin_unavailable' };
  let task: TaskRecord | undefined = owners[0];
  const seen = new Set<string>();
  while (task) {
    if (seen.has(task.id)) return { ...reference, unavailable: 'interaction_origin_unavailable' };
    seen.add(task.id);
    // Routing is immutable in the original creation event, unlike run/attempt/status fields.
    const event = core.runtime.taskOwnEvents(task.id, 0, 1000).find(row => row.kind === 'task_created');
    const created = event?.data as Partial<TaskRecord> | undefined;
    if (!created || created.id !== task.id || created.contextId !== task.contextId || created.parentId !== task.parentId || created.returnContextId !== task.returnContextId) return { ...reference, unavailable: 'interaction_origin_unavailable' };
    reference.taskIds.push(task.id);
    const destination = core.runtime.context(task.returnContextId);
    if (destination?.role === 'main') {
      if (!main(destination.id)) reference.unavailable = 'interaction_destination_unavailable';
      return reference;
    }
    if (!task.parentId || !destination || destination.role !== 'work') return { ...reference, unavailable: 'interaction_origin_unavailable' };
    const parent: TaskRecord | undefined = core.runtime.tasks().find(row => row.id === task!.parentId);
    if (!parent || parent.contextId !== destination.id) return { ...reference, unavailable: 'interaction_origin_unavailable' };
    task = parent;
  }
  return { ...reference, unavailable: 'interaction_origin_unavailable' };
}
