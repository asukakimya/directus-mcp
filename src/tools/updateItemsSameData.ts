import { z } from 'zod';
import type { ToolContext } from '../mcp/server.js';
import { assertCollectionMutable, assertBatchSize } from '../safety/permissions.js';
import { normalizeJsonLike, isPlainObject } from '../safety/normalize.js';
import { updateItemsSameDataWithGuards } from '../directus/mutations.js';
import { McpUserError } from '../directus/errors.js';

const Input = z.object({
  collection: z.string().min(1),
  keys: z.unknown().optional(),
  keys_json: z.string().optional(),
  data: z.unknown().optional(),
  data_json: z.string().optional(),
  dry_run: z.boolean().optional(),
});

export const updateItemsSameDataTool = {
  name: 'directus_update_items_same_data',
  description:
    'Apply the SAME partial data to multiple keys using Directus bulk PATCH /items/{collection} endpoint. Use this when every key should receive identical changes. For per-key different data, use directus_batch_update_items instead.',
  inputSchema: Input,
  handler: async (ctx: ToolContext, rawArgs: unknown) => {
    const args = Input.parse(rawArgs);

    const rawKeys = args.keys_json !== undefined ? args.keys_json : args.keys;
    const keysVal = normalizeJsonLike(rawKeys);
    if (!Array.isArray(keysVal)) {
      throw new McpUserError('INVALID_DATA_TYPE', 'keys must be an array', { collection: args.collection });
    }
    const keys = keysVal.map((k, i) => {
      if (typeof k !== 'string' && typeof k !== 'number') {
        throw new McpUserError('INVALID_DATA_TYPE', `keys[${i}] must be string or number`, { index: i });
      }
      return k as string | number;
    });
    assertBatchSize(ctx.config, keys.length);

    const rawData = args.data_json !== undefined ? args.data_json : args.data;
    const data = normalizeJsonLike(rawData);
    if (!isPlainObject(data)) {
      throw new McpUserError('INVALID_DATA_TYPE', 'data must be a JSON object', { collection: args.collection });
    }

    assertCollectionMutable(ctx.config, args.collection);
    const schema = await ctx.schema.loadCollectionSchema(args.collection);

    const result = await updateItemsSameDataWithGuards(ctx.client, ctx.config, schema, keys, data, {
      dryRun: args.dry_run,
    });

    ctx.audit.record({
      ts: new Date().toISOString(),
      action: result.dryRun ? 'dry_run' : 'update',
      collection: args.collection,
      keys,
      dryRun: result.dryRun,
      ok: true,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: result.dryRun
            ? `Dry-run bulk update on ${args.collection} (keys: ${keys.join(', ')}).`
            : `Bulk-updated ${keys.length} items in ${args.collection}.`,
        },
      ],
      structuredContent: {
        ok: true,
        collection: args.collection,
        ...result,
      },
    };
  },
};
