import { loadConfig, createLogger } from './config.js';
import { DirectusRestClient } from './directus/rest.js';
import { SchemaService } from './directus/schemaService.js';
import { createAuditLog } from './safety/audit.js';
import { createPlanStore } from './safety/plans.js';
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
      applyRequiresPlan: config.applyRequiresPlan,
      planStore: config.planStore,
    },
    'starting directus-safe-mcp',
  );

  const client = new DirectusRestClient(config.directusUrl, config.directusToken);
  const schemaService = new SchemaService(client, config.schemaCacheTtlSeconds * 1000);
  const audit = createAuditLog(logger, config);
  const plans = createPlanStore(config.planStore, config.planStoreDir, config.planMaxBytes, logger);

  // Best-effort cleanup of expired/cancelled plans on startup.
  // Errors are logged but do not block startup.
  plans.cleanup().then((removed) => {
    if (removed > 0) {
      logger.info({ removed }, 'startup plan cleanup: removed expired/cancelled plans');
    }
  }).catch((err) => {
    logger.warn({ err }, 'startup plan cleanup failed (non-fatal)');
  });

  // Periodic cleanup every 5 minutes (best-effort).
  const cleanupInterval = setInterval(() => {
    plans.cleanup().catch((err) => {
      logger.debug({ err }, 'periodic plan cleanup failed (non-fatal)');
    });
  }, 5 * 60 * 1000);
  // Don't keep the process alive just for the interval.
  cleanupInterval.unref();

  const ctx: ToolContext = {
    config,
    logger,
    client,
    schema: schemaService,
    audit,
    plans,
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
