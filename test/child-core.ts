import { serve } from '@hono/node-server';
import { Core } from '../src/core.js';
import { createApp } from '../src/http.js';
import { scriptedModel } from './helpers.js';

let release!: () => void;
const gate = new Promise<void>(resolve => { release = resolve; });
const fixture = scriptedModel({ gate, onCall: () => process.send?.({ type: 'model-call' }) });
const core = await Core.open({ dataDir: process.argv[2]!, model: fixture.model });
const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 });
server.on('listening', () => {
  const address = server.address();
  if (address && typeof address !== 'string') process.send?.({ type: 'ready', port: address.port, token: core.controlToken });
});
process.on('message', (message) => { if (message === 'release') release(); });
process.once('SIGTERM', () => {
  release();
  server.close();
  if ('closeAllConnections' in server) server.closeAllConnections();
  void core.close().finally(() => process.exit(0));
});
