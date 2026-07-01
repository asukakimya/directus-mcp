import { loadConfig, createLogger } from './config.js';
import { DirectusRestClient } from './directus/rest.js';
import { SchemaService } from './directus/schemaService.js';
import { createAuditLog } from './safety/audit.js';
import type { ToolContext } from './mcp/server.js';
import { connectTransport, makeServerFactory } from './mcp/transports.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Logger not yet available — write to stderr directly.
    process.stderr.write(
      `[FATAL] Failed to load config: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  const logger = createLogger(config);

  logger.info(
    {
      transport: config.mcpTransport,
      directusUrl: config.directusUrl,
      allowedCollections: Array.from(config.allowedCollections),
      allowDelete: config.allowDelete,
      dryRunDefault: config.mutationDryRunDefault,
      requireAuth: config.mcpRequireAuth,
    },
    'starting directus-safe-mcp',
  );

  const client = new DirectusRestClient(config.directusUrl, config.directusToken);
  const schemaService = new SchemaService(client, config.schemaCacheTtlSeconds * 1000);
  const audit = createAuditLog(logger, config);

  const ctx: ToolContext = {
    config,
    logger,
    client,
    schema: schemaService,
    audit,
  };

  const serverFactory = makeServerFactory(ctx);

  await connectTransport(serverFactory, config, logger);

  // For stdio, the transport owns the lifecycle. For streamable-http,
  // connectTransport installs signal handlers.
  if (config.mcpTransport === 'stdio') {
    process.on('SIGINT', () => process.exit(0));
    process.on('SIGTERM', () => process.exit(0));
  }
}

main().catch((err) => {
  process.stderr.write(
    `[FATAL] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
