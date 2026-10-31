import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import type { Core } from '../src/core.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function removeTemp(directory: string) {
  const resolved = path.resolve(directory);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('arona-')) throw new Error('Unexpected temporary path');
  // Closed libSQL mappings can remain pinned until native finalizers run on Windows.
  if (process.platform === 'win32') global.gc?.();
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

export async function until<T>(read: () => T | Promise<T>, ready: (value: T) => boolean, timeout = 15_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for observable state');
}

export function finished(core: Core, runId: string) {
  return until(() => core.store.getRun(runId), run => !!run && run.status !== 'running');
}

export function scriptedModel(options: { gate?: Promise<void>; fail?: boolean; onCall?: (prompt: string) => void; onOptions?: (options: unknown) => void } = {}) {
  let round = 0;
  let callCount = 0;
  const model = new MastraLanguageModelV2Mock({
    doStream: async (request) => {
      callCount++;
      const prompt = JSON.stringify(request.prompt);
      options.onCall?.(prompt);
      options.onOptions?.(request.providerOptions);
      if (options.fail) throw new Error('fixture upstream error with fixture-secret');
      if (round++ === 0 && options.gate) await options.gate;
      const text = request.prompt.flatMap(message => typeof message.content === 'string' ? [message.content]
        : message.content.flatMap(part => part.type === 'text' && 'text' in part ? [part.text] : [])).join('\n');
      const inputs = new Map<string, string>();
      for (const tag of text.matchAll(/<(?:user|external-event)\b[^>]*>/g)) {
        const id = /signal_id="([0-9a-f-]{36})"/.exec(tag[0])?.[1];
        const kind = /output_kind="(message|artifact)"/.exec(tag[0])?.[1];
        if (id && kind) inputs.set(id, kind);
      }
      const toolResults = request.prompt.filter(m => m.role === 'tool').flatMap(m => m.content);
      const count = toolResults.length;
      const signalId = [...inputs.keys()][count];
      const isArtifact = signalId && inputs.get(signalId) === 'artifact';
      const toolName = isArtifact ? 'save_artifact' : 'emit_message';
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            if (signalId) {
              controller.enqueue({ type: 'tool-call', toolCallId: `fixture-${count}-${callCount}`, toolName,
                input: JSON.stringify(isArtifact ? { signalIds: [signalId], title: 'Result', markdown: '# Synthetic result' } : { signalIds: [signalId], text: 'Synthetic reply' }) });
            } else {
              controller.enqueue({ type: 'text-start', id: 'text-1' });
              controller.enqueue({ type: 'text-delta', id: 'text-1', delta: 'Internal completion text' });
              controller.enqueue({ type: 'text-end', id: 'text-1' });
            }
            controller.enqueue({ type: 'finish', finishReason: signalId ? 'tool-calls' : 'stop', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
            controller.close();
          },
        }),
      };
    },
  });
  return { model, calls: () => callCount };
}
