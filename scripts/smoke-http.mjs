#!/usr/bin/env node
/**
 * Smoke test for Streamable HTTP transport:
 *   1. Spawn the sidecar with MCP_TRANSPORT=streamable-http + MCP_AUTH_TOKEN.
 *   2. Confirm /healthz returns 200 (no auth).
 *   3. Confirm /unknown-path returns 404.
 *   4. Confirm /mcp returns 401 without auth header.
 *   5. Confirm /mcp returns 401 with wrong token.
 *   6. Confirm /mcp initialize returns 200 with correct Bearer token.
 *   7. Confirm /mcp tools/list returns 200 + lists 11 tools —
 *      THIS is the regression test for the stateless Streamable HTTP bug
 *      where `sessionIdGenerator: () => randomUUID()` would cause
 *      "Server not initialized" on the second request.
 */
import { spawn } from 'node:child_process';

const AUTH_TOKEN = 'smoke-test-token-1234';
const PORT = '3399';

const env = {
  ...process.env,
  DIRECTUS_URL: 'https://directus.example.com',
  DIRECTUS_TOKEN: 'fake-token-for-smoke-test',
  MCP_TRANSPORT: 'streamable-http',
  MCP_HTTP_PORT: PORT,
  MCP_BIND_HOST: '127.0.0.1',
  MCP_ENDPOINT_PATH: '/mcp',
  MCP_REQUIRE_AUTH: 'true',
  MCP_AUTH_TOKEN: AUTH_TOKEN,
  LOG_LEVEL: 'warn',
};

const child = spawn('node', ['dist/index.js'], {
  cwd: process.cwd(),
  env,
  stdio: ['inherit', 'inherit', 'inherit'],
});

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchRaw(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  return { status: r.status, text, headers: r.headers };
}

async function callMcp(method, params, id = 1) {
  const r = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${AUTH_TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await r.text();
  // Streamable HTTP may return JSON or SSE; for these simple calls we expect JSON.
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // SSE: parse `data: {...}` lines
    const lines = text.split('\n').filter((l) => l.startsWith('data:'));
    if (lines.length > 0) {
      try { body = JSON.parse(lines[0].slice(5).trim()); } catch { body = text; }
    } else {
      body = text;
    }
  }
  return { status: r.status, body };
}

async function main() {
  // Wait for server to listen.
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (r.ok) break;
    } catch {}
    await sleep(100);
  }
  console.log('[http-smoke] server up');

  // 1. /healthz → 200 (no auth)
  const health = await fetchRaw(`http://127.0.0.1:${PORT}/healthz`);
  console.log('[http-smoke] /healthz status:', health.status);
  if (health.status !== 200) throw new Error(`/healthz expected 200, got ${health.status}`);

  // 2. /unknown → 404
  const notFound = await fetchRaw(`http://127.0.0.1:${PORT}/unknown-path`);
  console.log('[http-smoke] /unknown-path status:', notFound.status);
  if (notFound.status !== 404) throw new Error(`/unknown-path expected 404, got ${notFound.status}`);

  // 3. /mcp no auth → 401
  const noAuth = await fetchRaw(`http://127.0.0.1:${PORT}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  console.log('[http-smoke] /mcp no-auth status:', noAuth.status);
  if (noAuth.status !== 401) throw new Error(`expected 401 without auth, got ${noAuth.status}`);

  // 4. /mcp wrong token → 401
  const wrongToken = await fetchRaw(`http://127.0.0.1:${PORT}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer wrong-token',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  console.log('[http-smoke] /mcp wrong-token status:', wrongToken.status);
  if (wrongToken.status !== 401) throw new Error(`expected 401 with wrong token, got ${wrongToken.status}`);

  // 5. /mcp initialize → 200
  const init = await callMcp('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'http-smoke', version: '1.0' },
  }, 1);
  console.log('[http-smoke] /mcp initialize status:', init.status);
  if (init.status !== 200) throw new Error(`initialize expected 200, got ${init.status}`);
  if (!init.body?.result?.serverInfo) throw new Error('initialize did not return serverInfo');
  console.log('[http-smoke] serverInfo:', JSON.stringify(init.body.result.serverInfo));

  // 6. /mcp tools/list → 200 (CRITICAL regression test for stateless Streamable HTTP)
  const toolsResp = await callMcp('tools/list', {}, 2);
  console.log('[http-smoke] /mcp tools/list status:', toolsResp.status);
  if (toolsResp.status !== 200) {
    throw new Error(`tools/list expected 200, got ${toolsResp.status}: ${JSON.stringify(toolsResp.body)}`);
  }
  const tools = toolsResp.body?.result?.tools;
  if (!Array.isArray(tools)) {
    throw new Error(`tools/list did not return tools array: ${JSON.stringify(toolsResp.body)}`);
  }
  console.log(`[http-smoke] tools/list returned ${tools.length} tools`);
  if (tools.length < 16) throw new Error(`expected >= 16 tools, got ${tools.length}`);

  const expectedNames = [
    'directus_schema_overview', 'directus_schema_detail',
    'directus_read_items', 'directus_read_item',
    'directus_create_item', 'directus_create_items',
    'directus_update_item', 'directus_update_items_same_data',
    'directus_batch_update_items', 'directus_delete_items',
    'directus_dry_run_mutation',
    'directus_apply_plan',
    'directus_cancel_plan',
    'directus_apply_plans',
    'directus_cancel_plans',
    'directus_verify_fields_empty',
  ];
  const missing = expectedNames.filter((n) => !tools.some((t) => t.name === n));
  if (missing.length > 0) throw new Error(`missing tools: ${missing.join(', ')}`);

  console.log('[http-smoke] OK — Streamable HTTP stateless mode works end-to-end (initialize + tools/list)');
  child.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error('[http-smoke] FAILED:', err.message);
  child.kill();
  process.exit(1);
});
