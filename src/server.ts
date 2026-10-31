import { serve } from '@hono/node-server';
import { readConfig } from './config.js';
import { Core } from './core.js';
import { createApp } from './http.js';
import { AppError } from './domain.js';

async function main() {
  const config = readConfig();
  const core = await Core.open({ dataDir: config.dataDir, modelConfig: config.model, timezone: config.timezone });
  const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: config.port });
  server.on('error', () => {
    console.error('listen_failed');
    void core.close().finally(() => process.exit(1));
  });
  server.on('listening', () => console.log(`A.R.O.N.A · http://127.0.0.1:${config.port}`));
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    if ('closeIdleConnections' in server) server.closeIdleConnections();
    await core.close();
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}

main().catch((error: unknown) => {
  console.error(error instanceof AppError ? error.code : 'startup_failed');
  process.exitCode = 1;
});
