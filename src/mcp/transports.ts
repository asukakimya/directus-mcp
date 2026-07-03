import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { IncomingMessage, ServerResponse, createServer } from 'node:http';
import type { AppConfig } from '../config.js';
import type { Logger } from 'pino';
import type { Server } from 'node:http';
import type { ToolContext } from './server.js';
import { buildServer } from './server.js';

/**
 * Connect the McpServer using the configured transport.
 *
 * - `stdio`: uses StdioServerTransport. Best for local debug / Claude
 *   Desktop / Cursor — the host process spawns the sidecar as a
 *   subprocess and pipes JSON-RPC over stdin/stdout.
 * - `streamable-http` (default, production): exposes the MCP server
 *   on `MCP_HTTP_PORT` at the `MCP_ENDPOINT_PATH` (default `/mcp`)
 *   using the Streamable HTTP transport.
 *
 * ## Stateless mode (critical)
 *
 * We pass `sessionIdGenerator: undefined` to `StreamableHTTPServerTransport`.
 * This tells the SDK: "do NOT issue `mcp-session-id` headers; treat every
 * HTTP request as a self-contained JSON-RPC message". This is what makes
 * stateless Streamable HTTP work without a session map.
 *
 * The previous implementation used `sessionIdGenerator: () => randomUUID()`
 * which initialised a stateful session — but no session map was kept, so the
 * second request (e.g. `tools/list` after `initialize`) arrived at a fresh
 * server that didn't know about the session and returned
 * `400 Bad Request: Server not initialized`.
 *
 * ## Auth
 *
 * When `MCP_REQUIRE_AUTH=true`, every HTTP request must carry
 * `Authorization: Bearer <MCP_AUTH_TOKEN>` or the server responds 401.
 * Stdio is exempt (it's a local subprocess — auth belongs to the parent process).
 *
 * ## Endpoint routing
 *
 * Only `MCP_ENDPOINT_PATH` (default `/mcp`) is the MCP endpoint.
 * `GET /healthz` returns `{ ok: true }` for liveness probes.
 * All other paths return 404.
 *
 * ## Origin / Host guard (DNS rebinding protection)
 *
 * If `MCP_ALLOWED_ORIGINS` is set and the request has an `Origin` header,
 * the origin must be in the allowlist. Same for `MCP_ALLOWED_HOSTS` vs the
 * `Host` header. Empty allowlist = allow anything (default).
 *
 * SSE: legacy HTTP+SSE transport is NOT supported. Streamable HTTP may
 * itself return `text/event-stream` responses when the client requests
 * streaming — that's part of the Streamable HTTP spec, not the legacy
 * HTTP+SSE transport.
 */
export async function connectTransport(
  serverFactory: () => McpServer,
  config: AppConfig,
  logger: Logger,
): Promise<void> {
  if (config.mcpTransport === 'stdio') {
    logger.info('connecting stdio transport');
    const transport = new StdioServerTransport();
    const server = serverFactory();
    await server.connect(transport);
    return;
  }

  if (config.mcpTransport === 'streamable-http') {
    logger.info(
      {
        port: config.mcpHttpPort,
        bindHost: config.mcpBindHost,
        endpoint: config.mcpEndpointPath,
        requireAuth: config.mcpRequireAuth,
        allowedOrigins: config.mcpAllowedOrigins,
        allowedHosts: config.mcpAllowedHosts,
      },
      'connecting streamable-http transport (stateless)',
    );

    const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const pathname = parsePathname(req.url ?? '/');

        // 1. Health endpoint — no auth, for k8s/docker liveness probes.
        if (pathname === '/healthz') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, service: 'directus-safe-mcp' }));
          return;
        }

        // 2. 404 for any non-MCP path.
        if (pathname !== config.mcpEndpointPath) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found', path: pathname }));
          return;
        }

        // 3. Host guard (DNS rebinding protection).
        // Tolerant match: HTTP Host header usually contains a port
        // (`mcp.example.com:3333`). The allowlist may contain either
        // the full `host:port` form OR the bare hostname — both match.
        if (config.mcpAllowedHosts.length > 0) {
          const host = (req.headers.host ?? '').toLowerCase();
          if (!host || !hostMatchesAllowlist(host, config.mcpAllowedHosts)) {
            logger.warn({ host, allowlist: config.mcpAllowedHosts }, 'host not in allowlist');
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'host not allowed' }));
            return;
          }
        }

        // 4. Origin guard (DNS rebinding + CSRF protection).
        if (config.mcpAllowedOrigins.length > 0) {
          const origin = req.headers.origin;
          // `Origin` is sent by browsers on POST/cross-origin GET.
          // Empty allowlist = allow any. If allowlist set and origin
          // present, must match.
          if (origin && !config.mcpAllowedOrigins.includes(origin)) {
            logger.warn({ origin }, 'origin not in allowlist');
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'origin not allowed' }));
            return;
          }
        }

        // 5. Bearer auth gate.
        if (config.mcpRequireAuth) {
          const ok = checkBearer(req.headers.authorization, config.mcpAuthToken);
          if (!ok) {
            logger.warn({ url: req.url }, 'unauthorized streamable-http request');
            res.writeHead(401, {
              'content-type': 'application/json',
              'www-authenticate': 'Bearer realm="directus-safe-mcp"',
            });
            res.end(JSON.stringify({ error: 'unauthorized' }));
            return;
          }
        }

        // 6. Stateless handling: fresh server + fresh transport per request.
        //    sessionIdGenerator: undefined → no `mcp-session-id` header,
        //    every request is self-contained. This is what makes stateless
        //    Streamable HTTP actually work.
        const server = serverFactory();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        logger.error({ err }, 'streamable-http transport error');
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
        }
        res.end(JSON.stringify({ error: 'internal error' }));
      }
    });

    await new Promise<void>((resolve) => {
      // bind to config.mcpBindHost (default 0.0.0.0). For local-only
      // debug set MCP_BIND_HOST=127.0.0.1.
      httpServer.listen(config.mcpHttpPort, config.mcpBindHost, () => resolve());
    });

    logger.info(
      `streamable-http server listening on ${config.mcpBindHost}:${config.mcpHttpPort}${config.mcpEndpointPath}`,
    );

    const shutdown = (signal: string) => {
      logger.info({ signal }, 'shutting down streamable-http server');
      httpServer.close((err?: Error) => {
        if (err) {
          logger.error({ err }, 'streamable-http server shutdown failed');
          process.exit(1);
        }
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 5000).unref();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Keep a reference so the server instance isn't GC'd.
    (httpServer as Server & { _keepalive?: unknown })._keepalive = serverFactory;
    return;
  }

  throw new Error(`Unknown MCP_TRANSPORT: ${config.mcpTransport}`);
}

function parsePathname(url: string): string {
  // Strip query string. URL parsing is forgiving of weird inputs.
  try {
    return new URL(url, 'http://placeholder').pathname;
  } catch {
    return url.split('?', 1)[0] ?? '/';
  }
}

/**
 * Tolerant Host allowlist match.
 *
 * HTTP Host header may be `mcp.example.com:3333` or just
 * `mcp.example.com`. The allowlist may also contain either form.
 * We match if:
 *   - the full Host value equals an allowlist entry, OR
 *   - the bare hostname (Host with port stripped) equals an allowlist entry, OR
 *   - an allowlist entry with a port matches when the Host has no port
 *     (we strip the port from the allowlist entry too).
 *
 * Examples (allowlist = ['mcp.example.com']):
 *   Host 'mcp.example.com:3333'        → MATCH (bare hostname matches)
 *   Host 'mcp.example.com'             → MATCH (full match)
 *   Host 'evil.example.com:3333'       → no match
 *
 * Examples (allowlist = ['mcp.example.com:3333']):
 *   Host 'mcp.example.com:3333'        → MATCH (full match)
 *   Host 'mcp.example.com'             → MATCH (hostname matches; port ignored)
 *   Host 'mcp.example.com:9999'        → no match (different port specified on both sides)
 */
/**
 * Exported for unit tests. Production code uses it via the closure above.
 */
export function hostMatchesAllowlist(host: string, allowlist: string[]): boolean {
  const hostBare = stripPort(host);
  for (const entry of allowlist) {
    if (entry === host) return true;
    const entryBare = stripPort(entry);
    if (entryBare === hostBare) {
      // If allowlist entry has an explicit port AND Host has an explicit port,
      // they must match. Otherwise (one or both lack port), bare-hostname match wins.
      const entryPort = extractPort(entry);
      const hostPort = extractPort(host);
      if (entryPort && hostPort) {
        if (entryPort === hostPort) return true;
      } else {
        return true;
      }
    }
  }
  return false;
}

function stripPort(h: string): string {
  // Handle IPv6 brackets: [::1]:3333
  if (h.startsWith('[')) {
    const close = h.indexOf(']');
    if (close > 0) return h.slice(0, close + 1);
  }
  const idx = h.lastIndexOf(':');
  if (idx <= 0) return h; // no port (or leading colon, treat as no port)
  return h.slice(0, idx);
}

function extractPort(h: string): string | null {
  if (h.startsWith('[')) {
    const close = h.indexOf(']');
    if (close > 0 && close + 1 < h.length && h[close + 1] === ':') {
      return h.slice(close + 2);
    }
    return null;
  }
  const idx = h.lastIndexOf(':');
  if (idx <= 0) return null;
  return h.slice(idx + 1);
}

/**
 * Constant-time string comparison to avoid timing side-channels on token check.
 */
function checkBearer(header: string | undefined, expected: string): boolean {
  if (!header || !expected) return false;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  const actual = header.slice(prefix.length).trim();

  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Build a factory that creates a fresh McpServer with all tools registered.
 * Each call returns an independent server instance — used by both stdio
 * (single call) and streamable-http (per-request call).
 */
export function makeServerFactory(ctx: ToolContext): () => McpServer {
  return () => {
    const server = new McpServer({
      name: 'directus-safe-mcp',
      version: '1.0.0',
    });
    return buildServer(server, ctx);
  };
}
