import pino, { type Logger } from 'pino';

/**
 * Application configuration loaded from environment variables.
 * All values are parsed and validated here so the rest of the
 * codebase can rely on a strongly-typed `AppConfig` object.
 *
 * Transport canonical values:
 *   - `streamable-http` (default) — production Docker deployment
 *   - `stdio` — local debug / some MCP clients (Claude Desktop, Cursor)
 *
 * The legacy alias `http` is accepted and canonicalised to `streamable-http`.
 */
export type McpTransport = 'streamable-http' | 'stdio';

export interface AppConfig {
  directusUrl: string;
  directusToken: string;

  mcpTransport: McpTransport;
  mcpHttpPort: number;

  /** When true, HTTP transport requires `Authorization: Bearer <token>` matching `mcpAuthToken`. */
  mcpRequireAuth: boolean;
  mcpAuthToken: string;

  /** HTTP endpoint path that serves MCP (default `/mcp`). Other paths → 404 except `/healthz`. */
  mcpEndpointPath: string;
  /** Network interface to bind HTTP server to. Default `0.0.0.0`; use `127.0.0.1` for local-only. */
  mcpBindHost: string;
  /** If non-empty, only requests with matching `Origin` header are accepted. Empty = allow any. */
  mcpAllowedOrigins: string[];
  /** If non-empty, only requests with matching `Host` header are accepted. Empty = allow any. */
  mcpAllowedHosts: string[];

  allowedCollections: Set<string>;
  deniedCollectionPrefixes: string[];
  allowDelete: boolean;
  allowSchemaWrite: boolean;

  mutationDryRunDefault: boolean;
  mutationRequireVerify: boolean;
  mutationMaxBatchSize: number;

  readDefaultLimit: number;
  readMaxLimit: number;
  allowWildcardFields: boolean;

  schemaCacheTtlSeconds: number;

  verifyCaseInsensitive: boolean;

  /**
   * Text-output limits for `content.text` payloads. These cap how much
   * real result data we put into the human-readable text part of each
   * MCP tool response (so the LLM can see it without LibreChat having
   * to surface structuredContent). Token-bloat protection.
   */
  schemaTextMaxFields: number;
  readTextMaxRows: number;
  readTextMaxChars: number;

  logLevel: string;
}

class ConfigError extends Error {
  constructor(message: string) {
    super(`[CONFIG_ERROR] ${message}`);
    this.name = 'ConfigError';
  }
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  const v = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return n;
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseTransport(raw: string | undefined): McpTransport {
  const v = (raw ?? 'streamable-http').trim().toLowerCase();
  // Canonicalise the legacy `http` alias to `streamable-http`.
  if (v === 'http' || v === 'streamable-http') return 'streamable-http';
  if (v === 'stdio') return 'stdio';
  throw new ConfigError(
    `MCP_TRANSPORT must be 'streamable-http', 'http' (alias), or 'stdio', got '${v}'`,
  );
}

function normaliseEndpointPath(raw: string): string {
  let p = raw.trim();
  if (!p) p = '/mcp';
  if (!p.startsWith('/')) p = `/${p}`;
  // Strip query string if present.
  p = p.split('?', 1)[0] ?? p;
  // Forbid `//` or path traversal segments.
  if (p.includes('//') || p.includes('/..') || p.includes('../')) {
    throw new ConfigError(`MCP_ENDPOINT_PATH contains invalid segments: '${raw}'`);
  }
  return p;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const directusUrl = env.DIRECTUS_URL?.trim();
  const directusToken = env.DIRECTUS_TOKEN?.trim();

  if (!directusUrl) {
    throw new ConfigError('DIRECTUS_URL is required');
  }
  if (!directusToken) {
    throw new ConfigError('DIRECTUS_TOKEN is required');
  }

  const mcpTransport = parseTransport(env.MCP_TRANSPORT);
  const mcpRequireAuth = parseBool(env.MCP_REQUIRE_AUTH, true);
  const mcpAuthToken = env.MCP_AUTH_TOKEN?.trim() ?? '';

  // If auth is required but no token configured, refuse to start.
  // (Stdio transport is local-only, so we don't enforce this there.)
  if (mcpTransport === 'streamable-http' && mcpRequireAuth && !mcpAuthToken) {
    throw new ConfigError(
      'MCP_REQUIRE_AUTH=true but MCP_AUTH_TOKEN is empty — refusing to start an unauthenticated HTTP server',
    );
  }

  // Endpoint path must start with `/` and not contain query string.
  const mcpEndpointPath = normaliseEndpointPath(env.MCP_ENDPOINT_PATH ?? '/mcp');
  const mcpBindHost = (env.MCP_BIND_HOST ?? '0.0.0.0').trim() || '0.0.0.0';
  const mcpAllowedOrigins = parseList(env.MCP_ALLOWED_ORIGINS);
  const mcpAllowedHosts = parseList(env.MCP_ALLOWED_HOSTS).map((h) => h.toLowerCase());

  return {
    directusUrl,
    directusToken,
    mcpTransport,
    mcpHttpPort: parseInteger(env.MCP_HTTP_PORT, 3333),
    mcpRequireAuth,
    mcpAuthToken,
    mcpEndpointPath,
    mcpBindHost,
    mcpAllowedOrigins,
    mcpAllowedHosts,
    allowedCollections: new Set(parseList(env.DIRECTUS_ALLOWED_COLLECTIONS)),
    deniedCollectionPrefixes: parseList(env.DIRECTUS_DENIED_COLLECTION_PREFIXES).length
      ? parseList(env.DIRECTUS_DENIED_COLLECTION_PREFIXES)
      : ['directus_'],
    allowDelete: parseBool(env.DIRECTUS_ALLOW_DELETE, false),
    allowSchemaWrite: parseBool(env.DIRECTUS_ALLOW_SCHEMA_WRITE, false),
    mutationDryRunDefault: parseBool(env.MUTATION_DRY_RUN_DEFAULT, true),
    mutationRequireVerify: parseBool(env.MUTATION_REQUIRE_VERIFY, true),
    mutationMaxBatchSize: parseInteger(env.MUTATION_MAX_BATCH_SIZE, 100),
    readDefaultLimit: parseInteger(env.READ_DEFAULT_LIMIT, 50),
    readMaxLimit: parseInteger(env.READ_MAX_LIMIT, 500),
    allowWildcardFields: parseBool(env.ALLOW_WILDCARD_FIELDS, false),
    schemaCacheTtlSeconds: parseInteger(env.SCHEMA_CACHE_TTL_SECONDS, 300),
    verifyCaseInsensitive: parseBool(env.VERIFY_CASE_INSENSITIVE, false),
    schemaTextMaxFields: parseInteger(env.SCHEMA_TEXT_MAX_FIELDS, 80),
    readTextMaxRows: parseInteger(env.READ_TEXT_MAX_ROWS, 10),
    readTextMaxChars: parseInteger(env.READ_TEXT_MAX_CHARS, 12000),
    logLevel: (env.LOG_LEVEL ?? 'info').trim().toLowerCase(),
  };
}

/**
 * Build a pino logger. In stdio mode we MUST NOT write logs to stdout
 * (stdout is reserved for MCP protocol messages), so we use stderr.
 */
export function createLogger(config: AppConfig): Logger {
  const isStdio = config.mcpTransport === 'stdio';
  const dest = isStdio ? pino.destination({ fd: process.stderr.fd }) : pino.destination(1);

  return pino(
    {
      level: config.logLevel,
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    dest,
  );
}
