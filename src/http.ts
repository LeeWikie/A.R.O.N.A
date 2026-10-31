import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { Core } from './core.js';
import { AppError, contextIdSchema } from './domain.js';

const integer = (value: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = z.coerce.number().int().min(0).max(max).safeParse(value ?? fallback);
  if (!parsed.success) throw new AppError('invalid_query');
  return parsed.data;
};

export function createApp(core: Core) {
  const app = new Hono();
  app.use('*', bodyLimit({ maxSize: 128 * 1024, onError: (c) => c.json({ error: 'request_too_large' }, 413) }));
  app.onError((error, c) => c.json({ error: error instanceof AppError ? error.code : 'internal_error' },
    (error instanceof AppError ? error.status : 500) as 400));
  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.get('/health', (c) => c.json({ status: 'ok' }));
  const readJSON = async (request: Request) => {
    try { return await request.json() as unknown; }
    catch { throw new AppError('invalid_json'); }
  };
  const operationKey = (request: Request) => {
    const key = request.headers.get('Idempotency-Key');
    if (key !== null && !/^[\w.-]{1,128}$/.test(key)) throw new AppError('invalid_operation_id');
    return key ? `http:${key}` : undefined;
  };
  app.get('/schedules', (c) => {
    const contextId = c.req.query('contextId');
    if (contextId && !contextIdSchema.safeParse(contextId).success) throw new AppError('invalid_context');
    return c.json({ ...core.schedules.now(), schedules: core.schedules.list(contextId) });
  });
  app.get('/schedules/:id', (c) => c.json(core.schedules.get(c.req.param('id'))));
  app.post('/schedules', async (c) => c.json(core.schedules.create(await readJSON(c.req.raw), operationKey(c.req.raw)), 201));
  app.patch('/schedules/:id', async (c) => c.json(core.schedules.update(c.req.param('id'), await readJSON(c.req.raw), operationKey(c.req.raw))));
  for (const action of ['pause', 'resume', 'cancel'] as const) {
    app.post(`/schedules/:id/${action}`, async (c) => {
      const parsed = z.object({ revision: z.number().int().positive() }).strict().safeParse(await readJSON(c.req.raw));
      if (!parsed.success) throw new AppError('invalid_schedule_control');
      return c.json(core.schedules.control(c.req.param('id'), action, parsed.data.revision, operationKey(c.req.raw)));
    });
  }
  app.post('/schedules/:id/run', async (c) => c.json(await core.schedules.run(c.req.param('id'), operationKey(c.req.raw)), 202));
  app.get('/schedules/:id/occurrences', (c) => {
    const offset = integer(c.req.query('offset'), 0);
    const limit = integer(c.req.query('limit'), 40, 100);
    if (!limit) throw new AppError('invalid_query');
    const occurrences = core.schedules.occurrences(c.req.param('id'), offset, limit);
    return c.json({ occurrences, nextOffset: offset + occurrences.length });
  });
  app.post('/signals', async (c) => {
    let body: unknown;
    try { body = await c.req.json(); }
    catch { throw new AppError('invalid_json'); }
    return c.json(await core.submitSignal(body), 202);
  });
  app.get('/signals/:id', (c) => {
    const signal = core.store.getSignal(c.req.param('id'));
    if (!signal) throw new AppError('signal_not_found', 404);
    return c.json(signal);
  });
  app.get('/runs/:id', (c) => {
    const run = core.store.getRun(c.req.param('id'));
    if (!run) throw new AppError('run_not_found', 404);
    return c.json(run);
  });
  app.get('/outputs', (c) => {
    const kind = c.req.query('kind');
    if (kind && kind !== 'message' && kind !== 'artifact') throw new AppError('invalid_output_kind');
    const contextId = c.req.query('contextId');
    if (contextId && !contextIdSchema.safeParse(contextId).success) throw new AppError('invalid_context');
    const after = integer(c.req.query('after'), 0);
    const outputs = core.store.listOutputs({ after, kind: kind === 'message' || kind === 'artifact' ? kind : undefined, contextId, limit: 100 });
    return c.json({ outputs, nextCursor: outputs.at(-1)?.seq ?? after });
  });
  app.get('/contexts/:id/history', async (c) => {
    const contextId = contextIdSchema.safeParse(c.req.param('id'));
    if (!contextId.success) throw new AppError('invalid_context');
    const page = integer(c.req.query('page'), 0);
    const perPage = integer(c.req.query('perPage'), 40, 100);
    if (!perPage) throw new AppError('invalid_query');
    return c.json(await core.history(contextId.data, page, perPage));
  });
  return app;
}
