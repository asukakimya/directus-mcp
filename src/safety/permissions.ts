import type { AppConfig } from '../config.js';
import { McpUserError } from '../directus/errors.js';

/**
 * Collection-level guards.
 *
 * - allowlist: if non-empty, only listed collections are accepted.
 * - denylist: any collection whose name starts with a denied prefix
 *   (default `directus_`) is rejected for any mutation.
 * - System collections: mutation is always rejected, regardless of
 *   allowlist, even if `DIRECTUS_ALLOW_SCHEMA_WRITE=true`.
 */

export function isCollectionAllowed(config: AppConfig, collection: string): boolean {
  if (config.deniedCollectionPrefixes.some((p) => collection.startsWith(p))) {
    return false;
  }
  if (config.allowedCollections.size === 0) return true;
  return config.allowedCollections.has(collection);
}

export function isSystemCollection(collection: string): boolean {
  return collection.startsWith('directus_');
}

export function assertCollectionReadable(config: AppConfig, collection: string): void {
  if (!collection || typeof collection !== 'string') {
    throw new McpUserError('INVALID_QUERY', 'collection is required', { collection });
  }
  if (!isCollectionAllowed(config, collection)) {
    throw new McpUserError('COLLECTION_NOT_ALLOWED', `Collection '${collection}' is not allowed`, {
      collection,
    });
  }
}

export function assertCollectionMutable(config: AppConfig, collection: string): void {
  // System collection mutation is always denied — even if a config
  // accidentally allowlists a directus_* collection, we still refuse
  // to mutate it.
  if (isSystemCollection(collection)) {
    throw new McpUserError(
      'SYSTEM_COLLECTION_DENIED',
      `Mutation on system collection '${collection}' is denied`,
      { collection },
    );
  }
  assertCollectionReadable(config, collection);
}

export function assertDeleteAllowed(config: AppConfig, collection: string): void {
  assertCollectionMutable(config, collection);
  if (!config.allowDelete) {
    throw new McpUserError(
      'DELETE_DISABLED',
      `Delete is disabled on this MCP instance (collection '${collection}')`,
      { collection },
    );
  }
}

export function assertBatchSize(config: AppConfig, size: number): void {
  if (!Number.isInteger(size) || size <= 0) {
    throw new McpUserError('INVALID_QUERY', `batch size must be a positive integer, got ${size}`, {
      size,
    });
  }
  if (size > config.mutationMaxBatchSize) {
    throw new McpUserError(
      'BATCH_LIMIT_EXCEEDED',
      `Batch size ${size} exceeds maximum ${config.mutationMaxBatchSize}`,
      { size, max: config.mutationMaxBatchSize },
    );
  }
}
