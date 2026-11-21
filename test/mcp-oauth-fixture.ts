import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Capabilities } from '../src/capabilities.js';
import { RuntimeStore } from '../src/runtime-store.js';
import { until, removeTemp } from './helpers.js';

export async function oauthFixture() {
  let base = '', access = '', refresh = '', tokens = 0, refreshes = 0, toolCalls = 0;
  const codes = new Map<string, string>(); const captured = new Set<string>();
  let tokenGate: { entered: () => void; wait: Promise<void> } | undefined;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', base || 'http://127.0.0.1');
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) => response.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(value));
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(200, { resource: base + '/mcp', authorization_servers: [base], scopes_supported: ['read'] });
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server') || url.pathname.startsWith('/.well-known/openid-configuration')) return json(200, { issuer: base, authorization_endpoint: base + '/authorize', token_endpoint: base + '/token', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    if (url.pathname === '/authorize') {
      const code = 'synthetic-code-' + (codes.size + 1); codes.set(code, url.searchParams.get('code_challenge')!);
      const redirect = new URL(url.searchParams.get('redirect_uri')!); redirect.searchParams.set('code', code); redirect.searchParams.set('state', url.searchParams.get('state')!); redirect.searchParams.set('iss', base);
      response.writeHead(302, { location: redirect.href }).end(); return;
    }
    if (url.pathname === '/token') {
      let body = ''; for await (const chunk of request) body += chunk; const form = new URLSearchParams(body);
      if (tokenGate) { const current = tokenGate; tokenGate = undefined; current.entered(); await current.wait; }
      if (form.get('grant_type') === 'authorization_code') {
        const challenge = codes.get(form.get('code')!); codes.delete(form.get('code')!);
        if (!challenge || createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== challenge) return json(400, { error: 'invalid_grant' });
      } else if (form.get('grant_type') === 'refresh_token') {
        if (form.get('refresh_token') !== refresh) return json(400, { error: 'invalid_grant' }); refreshes++;
      } else return json(400, { error: 'unsupported_grant_type' });
      tokens++; access = 'synthetic-access-' + tokens; refresh = 'synthetic-refresh-' + tokens;
      return json(200, { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope: 'read' });
    }
    if (url.pathname !== '/mcp') return json(404, {});
    if (!access || request.headers.authorization !== 'Bearer ' + access) return json(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body) as { id?: number; method: string; params?: { protocolVersion?: string } };
    if (rpc.id === undefined) { response.writeHead(202).end(); return; }
    const result = rpc.method === 'initialize' ? { protocolVersion: rpc.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'oauth-fixture', version: '1' } }
      : rpc.method === 'tools/list' ? { tools: [{ name: 'read_fixture', description: 'Read synthetic data.', inputSchema: { type: 'object', properties: {} } }] }
      : rpc.method === 'tools/call' ? (toolCalls++, { content: [{ type: 'text', text: 'Authenticated synthetic result.' }] }) : {};
    return json(200, { jsonrpc: '2.0', id: rpc.id, result });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string'); base = `http://127.0.0.1:${address.port}`;
  const callback = createServer(); callback.listen(0, '127.0.0.1'); await once(callback, 'listening'); const callbackAddress = callback.address(); assert.ok(callbackAddress && typeof callbackAddress !== 'string'); const redirectPort = callbackAddress.port; await new Promise<void>(resolve => callback.close(() => resolve()));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-mcp-oauth-')); const db = new DatabaseSync(':memory:'); const runtime = new RuntimeStore(db);
  const capabilities = new Capabilities(runtime, directory, () => undefined, 'synthetic-stable-control-token', value => captured.add(value));
  await capabilities.saveMCP({ id: 'fixture', url: base + '/mcp', protocolVersion: 'legacy', oauth: { clientId: 'synthetic-client', scopes: ['read'], redirectPort } });
  return { capabilities, runtime, directory, captured, base, redirectPort, tokenCount: () => tokens, refreshCount: () => refreshes, toolCalls: () => toolCalls,
    invalidateAccess: () => { access = 'expired-old-access'; },
    holdNextTokenResponse: () => { let entered!: () => void; let release!: () => void; const seen = new Promise<void>(resolve => { entered = resolve; }); const wait = new Promise<void>(resolve => { release = resolve; }); tokenGate = { entered, wait }; return { entered: seen, release }; },
    async close() { await capabilities.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); await removeTemp(directory); } };
}

