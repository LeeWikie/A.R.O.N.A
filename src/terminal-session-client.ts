import { createHash, randomUUID } from 'node:crypto';
import { AppError, contextIdSchema } from './domain.js';
import { coreLocation, dataDirectory } from './startup.js';
import { directoryIdentity, sameDirectoryIdentity, type TerminalSessionRequest, type TerminalSessionResult } from './terminal-sessions.js';
import type { Client } from './client.js';

export async function openTerminalSession(client: Client, options: {
  contextId?: string; workspaceId?: string; continue?: boolean; cwd?: string;
  env?: NodeJS.ProcessEnv; signal?: AbortSignal; operationId?: string;
} = {}) {
  if (options.contextId) {
    if (options.workspaceId || options.continue) throw new AppError('conflicting_session_options');
    return { contextId: contextIdSchema.parse(options.contextId), resume: false };
  }
  const env = options.env ?? process.env, handshake = await client.handshake(options.signal);
  const local = !options.workspaceId && !(env.SHITTIMCHEST_CORE_URL ?? env.ARONA_CORE_URL);
  if (!handshake.capabilities.includes('terminal-project-sessions')) {
    if (local || options.workspaceId || options.continue) throw new AppError('terminal_projects_unsupported', 409);
    return { contextId: 'main', resume: true };
  }
  const operationId = createHash('sha256').update('terminal-launch\0' + (options.operationId ?? randomUUID())).digest('hex');
  let target: TerminalSessionRequest['target'];
  if (local) {
    const locator = coreLocation(dataDirectory(env));
    if (!locator?.owner || locator.storageId !== handshake.storageId || locator.instanceId !== handshake.instanceId) throw new AppError('local_workspace_identity_required', 409);
    target = { kind: 'local', directory: directoryIdentity(options.cwd ?? process.cwd()), owner: locator.owner, storageId: handshake.storageId, instanceId: handshake.instanceId };
  } else target = { kind: 'workspace', workspaceId: options.workspaceId ?? 'default' };
  const body: TerminalSessionRequest = { mode: options.continue ? 'continue' : 'new', target };
  const activate = (result: TerminalSessionResult) => {
    if (result.status !== 'available') throw new AppError(`terminal_session_${result.status}`, 409);
    if (target.kind === 'local' && !sameDirectoryIdentity(result.receipt.directory, target.directory)
      || target.kind === 'workspace' && result.receipt.workspaceId !== target.workspaceId
      || result.receipt.mode !== body.mode) throw new AppError('operation_id_conflict', 409);
    return { contextId: result.receipt.contextId, resume: false, workspaceId: result.receipt.workspaceId };
  };
  // A lost response can be recovered without opening another empty session, including after Core restart.
  try { return activate(await client.request<TerminalSessionResult>(`/terminal/sessions/operations/${operationId}`, { signal: options.signal })); }
  catch (error) { if (!(error instanceof AppError) || error.status !== 404) throw error; }
  try {
    return activate(await client.request<TerminalSessionResult>('/terminal/sessions', { method: 'POST', signal: options.signal,
      headers: { 'content-type': 'application/json', 'Idempotency-Key': operationId, 'X-ShittimChest-Storage-Id': handshake.storageId, 'X-ShittimChest-Instance-Id': handshake.instanceId }, body: JSON.stringify(body) }));
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (!(error instanceof AppError) || !['connection_failed', 'request_timeout', 'core_instance_changed', 'core_storage_changed'].includes(error.code)) throw error;
    const current = await client.handshake(options.signal);
    if (current.storageId !== handshake.storageId) throw new AppError('core_storage_changed', 409);
    try { return activate(await client.request<TerminalSessionResult>(`/terminal/sessions/operations/${operationId}`, { signal: options.signal })); }
    catch (lookup) { if (lookup instanceof AppError && lookup.status === 404) throw error; throw lookup; }
  }
}
