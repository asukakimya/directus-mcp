import { z } from 'zod';
import type { ToolContext } from '../mcp/server.js';
import { assertCollectionMutable, assertBatchSize } from '../safety/permissions.js';
import { normalizeJsonLike, isPlainObject } from '../safety/normalize.js';
import { batchUpdateItemsWithGuards } from '../directus/mutations.js';
import { McpUserError } from '../directus/errors.js';

const Input = z.object({
  operations: z.unknown().optional(),
  operations_json: z.string().optional(),
});

/**
 * Plan-mode tool: runs a batch of operations as dry-run only.
 * Useful for "show me what would happen if I applied these N changes".
 * The output is a per-operation structured diff; the LLM can present
 * that to the user for approval before invoking the real writers.
 */
export const dryRunMutationTool = {
  name: 'directus_dry_run_mutation',
  description:
    'Run a batch of update operations in DRY-RUN mode only (no writes). Each operation: { action: "update", collection, key, data, verify? }. Returns before/after/diff per operation. Use this to plan multi-step changes and present them to the user before applying.',
  inputSchema: Input,
  handler: async (ctx: ToolContext, rawArgs: unknown) => {
    const args = Input.parse(rawArgs);

    const rawOps = args.operations_json !== undefined ? args.operations_json : args.operations;
    const opsVal = normalizeJsonLike(rawOps);
    if (!Array.isArray(opsVal)) {
      throw new McpUserError('INVALID_DATA_TYPE', 'operations must be an array', {});
    }
    assertBatchSize(ctx.config, opsVal.length);

    // Group by collection so we only load each schema once.
    const byCollection = new Map<string, Array<{ key: string | number; data: Record<string, unknown>; verify?: Record<string, unknown> }>>();

    for (let i = 0; i < opsVal.length; i++) {
      const op = opsVal[i];
      if (!isPlainObject(op)) {
        throw new McpUserError('INVALID_DATA_TYPE', `operations[${i}] must be an object`, { index: i });
      }
      const action = (op as Record<string, unknown>).action;
      if (action !== 'update') {
        throw new McpUserError(
          'INVALID_QUERY',
          `directus_dry_run_mutation currently supports only action="update" (got '${String(action)}' at index ${i})`,
          { index: i, action },
        );
      }
      const collection = (op as Record<string, unknown>).collection;
      if (typeof collection !== 'string') {
        throw new McpUserError('INVALID_QUERY', `operations[${i}].collection must be a string`, { index: i });
      }
      const key = (op as Record<string, unknown>).key;
      if (typeof key !== 'string' && typeof key !== 'number') {
        throw new McpUserError('INVALID_QUERY', `operations[${i}].key is required`, { index: i });
      }
      const data = normalizeJsonLike((op as Record<string, unknown>).data);
      if (!isPlainObject(data)) {
        throw new McpUserError('INVALID_DATA_TYPE', `operations[${i}].data must be an object`, { index: i });
      }
      const verify = normalizeJsonLike((op as Record<string, unknown>).verify);

      assertCollectionMutable(ctx.config, collection);
      const list = byCollection.get(collection) ?? [];
      list.push({
        key: key as string | number,
        data: data as Record<string, unknown>,
        verify: (verify as Record<string, unknown> | undefined) ?? undefined,
      });
      byCollection.set(collection, list);
    }

    const results: Array<Record<string, unknown>> = [];

    for (const [collection, items] of byCollection.entries()) {
      const schema = await ctx.schema.loadCollectionSchema(collection);
      const r = await batchUpdateItemsWithGuards(ctx.client, ctx.config, schema, items, {
        dryRun: true,
        failFast: false,
      });
      for (const res of r.results) {
        if ('error' in res) {
          results.push({ collection, key: res.key, ok: false, error: res.error });
        } else {
          // `res` already contains a `collection` field, so spread it
          // first and let our explicit `collection` win to avoid
          // "specified more than once" warnings.
          results.push({ ok: true, ...res, collection });
        }
      }
    }

    ctx.audit.record({
      ts: new Date().toISOString(),
      action: 'dry_run',
      collection: '<multi>',
      keys: [],
      dryRun: true,
      ok: true,
      message: `${results.length} ops`,
    });

    return {
      content: [
        { type: 'text' as const, text: `Dry-run plan: ${results.length} operations.` },
      ],
      structuredContent: {
        ok: true,
        dryRun: true,
        operations: results,
      },
    };
  },
};
