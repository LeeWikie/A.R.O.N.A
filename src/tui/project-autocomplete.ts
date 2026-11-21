import { CombinedAutocompleteProvider, type AutocompleteProvider, type AutocompleteItem } from '@earendil-works/pi-tui';
import type { Client } from '../client.js';
import type { ProjectDirectory, ProjectPathSuggestions } from '../project-paths.js';
import { editorDisplayText } from './terminal-editor.js';

export interface CompletionScope { contextId: string; storageId?: string; instanceId?: string; generation: number; revision: number; projectCompletions: boolean; ready: boolean }
interface CompletionHost { client: Pick<Client, 'request'>; scope(): CompletionScope }
const sameScope = (left: CompletionScope, right: CompletionScope) => left.contextId === right.contextId && left.storageId === right.storageId && left.instanceId === right.instanceId && left.generation === right.generation && left.revision === right.revision && left.projectCompletions === right.projectCompletions && left.ready === right.ready;

/** Local commands and transfers keep the client's directory; project references use the Core's lease. */
export class ProjectAutocomplete implements AutocompleteProvider {
  constructor(private readonly native: CombinedAutocompleteProvider, private readonly local: AutocompleteProvider, private readonly host: CompletionHost) {}
  async getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal; force?: boolean }) {
    const before = (lines[cursorLine] ?? '').slice(0, cursorCol), trimmed = before.trimStart();
    if (trimmed.startsWith('!')) return this.local.getSuggestions(lines, cursorLine, cursorCol, options);
    const fileCommand = /^\/(?:attach|import|export)\s+/.exec(trimmed);
    if (fileCommand) {
      const line = `x ${trimmed.slice(fileCommand[0].length)}`;
      return this.local.getSuggestions([line], 0, line.length, options);
    }
    const context = this.native.getFileCompletionContext(lines, cursorLine, cursorCol, options.force);
    const scope = this.host.scope();
    if (!context || !scope.projectCompletions) return this.local.getSuggestions(lines, cursorLine, cursorCol, options);
    if (!scope.ready || !scope.storageId || context.prefix.length > 131072 || options.signal.aborted) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const scopeHeaders = { 'X-ShittimChest-Storage-Id': scope.storageId, ...(scope.instanceId ? { 'X-ShittimChest-Instance-Id': scope.instanceId } : {}) };
        const project = await this.host.client.request<ProjectDirectory>(`/contexts/${encodeURIComponent(scope.contextId)}/project-directory`, { signal: options.signal, headers: scopeHeaders });
        if (!sameScope(scope, this.host.scope()) || options.signal.aborted) return null;
        if (project.contextId !== scope.contextId || typeof project.workspaceId !== 'string' || !/^[a-f0-9]{64}$/.test(project.revision)) return null;
        const response = await this.host.client.request<ProjectPathSuggestions>(`/contexts/${encodeURIComponent(scope.contextId)}/path-completions`, {
          method: 'POST', signal: options.signal, headers: { 'content-type': 'application/json', ...scopeHeaders },
          body: JSON.stringify({ prefix: context.prefix, force: options.force ?? false, workspaceId: project.workspaceId, revision: project.revision }),
        });
        if (!sameScope(scope, this.host.scope()) || options.signal.aborted) return null;
        if (response.project.contextId !== scope.contextId || response.project.workspaceId !== project.workspaceId || response.project.revision !== project.revision) return null;
        const result = response.suggestions;
        if (!result || result.prefix !== context.prefix || !Array.isArray(result.items)) return null;
        const items = result.items.filter(item => typeof item.value === 'string' && typeof item.label === 'string' && (item.description === undefined || typeof item.description === 'string'));
        return items.length ? { prefix: result.prefix, items: items.map(item => ({ ...item, label: editorDisplayText(item.label), ...(item.description === undefined ? {} : { description: editorDisplayText(item.description) }) })) } : null;
      } catch (error) {
        if (options.signal.aborted || !sameScope(scope, this.host.scope()) || !(error instanceof Error) || error.message !== 'project_directory_changed' || attempt > 0) return null;
      }
    }
    return null;
  }
  applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) { return this.native.applyCompletion(lines, cursorLine, cursorCol, item, prefix); }
  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number) { return this.native.shouldTriggerFileCompletion(lines, cursorLine, cursorCol); }
}
