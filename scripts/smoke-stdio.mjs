#!/usr/bin/env node
/**
 * Smoke test: spawn the MCP sidecar in stdio mode and send an MCP
 * `initialize` + `tools/list` request. Verifies the server actually
 * starts, registers tools, and responds over JSON-RPC.
 */
import { spawn } from 'node:child_process';

const env = {
  ...process.env,
  DIRECTUS_URL: 'https://directus.example.com',
  DIRECTUS_TOKEN: 'fake-token-for-smoke-test',
  MCP_TRANSPORT: 'stdio',
  LOG_LEVEL: 'warn',
};

const child = spawn('node', ['dist/index.js'], {
  cwd: process.cwd(),
  env,
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buffer = '';
const messages = [];

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        // ignore non-JSON lines
      }
    }
  }
});

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + '\n');
}

async function waitForMessage(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for message matching ${predicate.toString()}`);
}

async function main() {
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '1.0' },
    },
  });

  const initResp = await waitForMessage((m) => m.id === 1);
  console.log('[smoke] initialize response:', JSON.stringify(initResp.result.serverInfo));

  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const toolsResp = await waitForMessage((m) => m.id === 2);
  const tools = toolsResp.result.tools;
  console.log(`[smoke] registered ${tools.length} tools:`);
  for (const t of tools) {
    console.log(`  - ${t.name}`);
  }

  if (tools.length < 13) {
    throw new Error(`expected >= 13 tools, got ${tools.length}`);
  }
  const expectedNames = [
    'directus_schema_overview',
    'directus_schema_detail',
    'directus_read_items',
    'directus_read_item',
    'directus_create_item',
    'directus_create_items',
    'directus_update_item',
    'directus_update_items_same_data',
    'directus_batch_update_items',
    'directus_delete_items',
    'directus_dry_run_mutation',
    'directus_apply_plan',
    'directus_cancel_plan',
  ];
  const missing = expectedNames.filter((n) => !tools.some((t) => t.name === n));
  if (missing.length > 0) {
    throw new Error(`missing tools: ${missing.join(', ')}`);
  }

  console.log('[smoke] OK — all 13 tools registered and responding');

  child.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err.message);
  child.kill();
  process.exit(1);
});
