import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import { registerAllTools } from './tools.js';

/**
 * Container for shared services passed to every tool handler.
 */
export interface ToolContext {
  config: AppConfig;
  logger: Logger;
  /** Directus REST client (token-bearing). */
  client: import('../directus/rest.js').DirectusRestClient;
  /** Schema cache with TTL. */
  schema: import('../directus/schemaService.js').SchemaService;
  /** Mutation audit log. */
  audit: import('../safety/audit.js').AuditLog;
  /** Plan store for dry-run → apply flow. */
  plans: import('../safety/plans.js').PlanStore;
  /** Bundle store for grouping multiple plans (update_by_query_plan etc.). */
  bundles: import('../safety/bundles.js').BundleStore;
}

/**
 * Register all directus_* tools onto the given McpServer instance.
 */
export function buildServer(server: McpServer, ctx: ToolContext): McpServer {
  registerAllTools(server, ctx);
  return server;
}
