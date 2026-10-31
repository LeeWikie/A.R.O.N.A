import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Client, OutputCursor, watchOutputs } from './client.js';
import { AppError } from './domain.js';

async function main() {
  const args = process.argv.slice(2).filter(arg => arg !== '--');
  const command = args.shift() ?? 'chat';
  const baseURL = process.env.ARONA_CORE_URL ?? 'http://127.0.0.1:4111';
  const contextId = process.env.ARONA_CONTEXT_ID ?? 'main';
  const directory = path.join(process.env.ARONA_DATA_DIR || path.join(os.homedir(), '.arona'), 'client');
  const client = new Client(baseURL);
  if (command === 'send' || command === 'event') {
    const text = args.join(' ');
    if (!text.trim()) throw new AppError('text_required');
    console.log(JSON.stringify(await client.submit(text, command === 'send' ? 'user-message' : 'external-event', contextId), null, 2));
    return;
  }
  if (command === 'run' || command === 'signal') {
    if (!args[0]) throw new AppError('id_required');
    console.log(JSON.stringify(await client.request(`/${command}s/${encodeURIComponent(args[0])}`), null, 2));
    return;
  }
  if (command === 'history') {
    const page = args[0] ?? '0';
    console.log(JSON.stringify(await client.request(`/contexts/${encodeURIComponent(contextId)}/history?page=${encodeURIComponent(page)}`), null, 2));
    return;
  }
  if (command === 'outputs') {
    const kind = args[0] === 'artifact' ? 'artifact' : 'message';
    console.log(JSON.stringify(await client.outputs(Number(args[1] ?? 0), kind, contextId), null, 2));
    return;
  }
  if (command !== 'chat' && command !== 'watch') throw new AppError('unknown_command');
  const kind = command === 'watch' && args[0] === 'artifact' ? 'artifact' : 'message';
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  const cursor = new OutputCursor(directory, baseURL, contextId, kind);
  cursor.read();
  let warned = false;
  const watching = watchOutputs({
    client, cursor, kind, contextId, signal: controller.signal,
    onOutput: output => {
      warned = false;
      if (output.kind === 'message') console.log(`\n阿罗娜> ${output.content}`);
      else console.log(`\n${output.title}\n${output.content}`);
    },
    onError: () => { if (!warned) { console.error('连接暂不可用，正在重试。'); warned = true; } },
  });
  if (command === 'chat') {
    const reader = createInterface({ input: process.stdin, output: process.stdout, prompt: '你> ' });
    controller.signal.addEventListener('abort', () => reader.close(), { once: true });
    reader.on('close', () => controller.abort());
    reader.prompt();
    for await (const line of reader) {
      if (line.trim() === '/quit') { reader.close(); break; }
      if (line.trim()) {
        try { await client.submit(line, 'user-message', contextId); }
        catch (error) { console.error(error instanceof AppError ? error.code : 'request_failed'); }
      }
      reader.prompt();
    }
  }
  await watching;
}

main().catch((error: unknown) => {
  console.error(error instanceof AppError ? error.code : 'client_failed');
  process.exitCode = 1;
});
