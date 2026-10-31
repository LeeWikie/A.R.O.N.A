import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { OutputRecord, SignalRecord } from './domain.js';
import { AppError } from './domain.js';

export class Client {
  constructor(readonly baseURL: string) {}

  async request<T>(route: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(new URL(route, this.baseURL), { ...init, signal: AbortSignal.timeout(10_000) });
    } catch { throw new AppError('connection_failed', 502); }
    const body: unknown = await response.json();
    if (!response.ok) {
      const code = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
      throw new AppError(typeof code === 'string' ? code : 'request_failed', response.status);
    }
    return body as T;
  }

  submit(content: string, type: 'user-message' | 'external-event', contextId = 'main', id = randomUUID()) {
    return this.request<SignalRecord>('/signals', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, contextId, source: type === 'user-message' ? 'terminal' : 'manual-event', type, content }),
    });
  }

  outputs(after: number, kind: OutputRecord['kind'], contextId: string) {
    const params = new URLSearchParams({ after: String(after), kind, contextId });
    return this.request<{ outputs: OutputRecord[]; nextCursor: number }>(`/outputs?${params}`);
  }
}

export class OutputCursor {
  private readonly file: string;
  constructor(directory: string, baseURL: string, contextId: string, kind: OutputRecord['kind']) {
    fs.mkdirSync(directory, { recursive: true });
    const key = createHash('sha256').update(JSON.stringify([baseURL, contextId, kind])).digest('hex');
    this.file = path.join(directory, `cursor-${key}.json`);
  }

  read(): number {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
      throw new AppError('invalid_output_cursor');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw new AppError('invalid_output_cursor');
    }
  }

  save(value: number) {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
}

export async function watchOutputs(options: {
  client: Client; cursor: OutputCursor; kind: OutputRecord['kind']; contextId: string;
  signal: AbortSignal; onOutput: (output: OutputRecord) => void;
  onError?: () => void;
}) {
  while (!options.signal.aborted) {
    try {
      const page = await options.client.outputs(options.cursor.read(), options.kind, options.contextId);
      for (const output of page.outputs) {
        if (options.signal.aborted) break;
        options.cursor.save(output.seq);
        options.onOutput(output);
      }
    } catch { if (!options.signal.aborted) options.onError?.(); }
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); options.signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, 500);
      options.signal.addEventListener('abort', done, { once: true });
      if (options.signal.aborted) done();
    });
  }
}
