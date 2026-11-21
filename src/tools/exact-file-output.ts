import { createHash } from 'node:crypto';
import type { ProcessLLMRequestArgs } from '@mastra/core/processors';

type Prompt = ProcessLLMRequestArgs['prompt'];
export interface ExactFileText { path: string; text: string; utf8Bytes: number; sha256: string; lineEndings: 'lf' | 'crlf' | 'cr' | 'mixed' | 'none'; finalLineEnding: 'lf' | 'crlf' | 'cr' | 'none' }

/** Inverts the SDK's text presentation only when its declared full-file byte count agrees. */
export function exactWorkspaceRead(input: unknown, output: string): ExactFileText | undefined {
  if (!input || typeof input !== 'object' || !('path' in input) || typeof input.path !== 'string' || /[\r\n]/.test(input.path)) return;
  if ('offset' in input && input.offset !== undefined || 'limit' in input && input.limit !== undefined) return;
  if ('encoding' in input && input.encoding !== undefined && !['utf8', 'utf-8'].includes(String(input.encoding))) return;
  const end = output.indexOf('\n'); if (end < 0) return;
  const header = output.slice(0, end), match = / \((\d+) bytes\)$/.exec(header); if (!match || !header.startsWith(input.path + ' (')) return;
  const expectedBytes = Number(match[1]); if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) return;
  let text = output.slice(end + 1);
  if (!('showLineNumbers' in input) || input.showLineNumbers !== false) {
    const lines = text.split('\n'), width = Math.max(6, String(lines.length).length + 1), raw: string[] = [];
    for (let index = 0; index < lines.length; index++) {
      const prefix = String(index + 1).padStart(width) + '→'; const line = lines[index]!;
      if (!line.startsWith(prefix)) return; raw.push(line.slice(prefix.length));
    }
    text = raw.join('\n');
  }
  if (Buffer.byteLength(text, 'utf8') !== expectedBytes) return;
  const endings = new Set((text.match(/\r\n|\r|\n/g) ?? []).map(value => value === '\r\n' ? 'crlf' : value === '\n' ? 'lf' : 'cr'));
  const lineEndings = endings.size === 0 ? 'none' : endings.size > 1 ? 'mixed' : [...endings][0]!;
  const finalLineEnding = text.endsWith('\r\n') ? 'crlf' : text.endsWith('\n') ? 'lf' : text.endsWith('\r') ? 'cr' : 'none';
  return { path: input.path, text, utf8Bytes: expectedBytes, sha256: createHash('sha256').update(text, 'utf8').digest('hex'), lineEndings, finalLineEnding };
}

/** Request-only presentation: native execution, read tracking and saved source results are untouched. */
export function projectExactFileReads(prompt: Prompt): Prompt {
  const calls = new Map<string, { toolName: string; input: unknown }>();
  return prompt.map(message => {
    if (message.role === 'assistant') {
      for (const part of message.content) if (part.type === 'tool-call') calls.set(part.toolCallId, { toolName: part.toolName, input: part.input });
      return message;
    }
    if (message.role !== 'tool') return message;
    const content = message.content.map(part => {
      const call = calls.get(part.toolCallId); calls.delete(part.toolCallId);
      if (!call || call.toolName !== 'mastra_workspace_read_file' || part.toolName !== call.toolName || !['text', 'json'].includes(part.output.type) || !('value' in part.output) || typeof part.output.value !== 'string') return part;
      const exact = exactWorkspaceRead(call.input, part.output.value);
      return exact ? { ...part, output: { type: 'json' as const, value: { ...exact, source: 'workspace-file-content', authority: 'external-file-data', complete: true } } } : part;
    });
    return { ...message, content };
  });
}
