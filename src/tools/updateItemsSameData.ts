import { z } from 'zod';
import type { ToolContext } from '../mcp/server.js';
import { assertCollectionMutable, assertBatchSize } from '../safety/permissions.js';
import { normalizeJsonLike, isPlainObject } from '../safety/normalize.js';
import { updateItemsSameDataWithGuards } from '../directus/mutations.js';
import { formatMutationText } from '../safety/textFormat.js';
import { McpUserError } from '../directus/errors.js';
import { assertDirectWriteAllowed } from '../safety/planPolicy.js';

const Input = z.object({
  collection: z.string().min(1),
  keys: z.unknown().optional(),
  // LibreChat sometimes passes arrays/objects to *_json fields instead of strings.
  // Accept any type here; handler normalises + validates.
  keys_json: z.unknown().optional(),
  data: z.unknown().optional(),
  data_json: z.unknown().optional(),
  dry_run: z.boolean().optional(),
});

export const updateItemsSameDataTool = {
  name: 'directus_update_items_same_data',
  description:
    'Apply the SAME partial data to multiple keys using Directus bulk PATCH /items/{collection} endpoint. Use this when every key should receive identical changes. For per-key different data, use directus_batch_update_items instead. When BULK_REQUIRES_PLAN=true, dry_run=false is rejected — use dry_run=true then directus_apply_plan.',
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

    const dryRun = args.dry_run ?? ctx.config.mutationDryRunDefault;

    if (!dryRun) assertDirectWriteAllowed(ctx.config, 'bulk', { collection: args.collection, tool: 'directus_update_items_same_data' });

    const result = await updateItemsSameDataWithGuards(ctx.client, ctx.config, schema, keys, data, {
      dryRun,
    });

    ctx.audit.record({
      ts: new Date().toISOString(),
      action: result.dryRun ? 'dry_run' : 'update',
      collection: args.collection,
      keys,
      dryRun: result.dryRun,
      ok: true,
    });

    const perItemResults: Array<unknown> = Object.entries(result.diff).map(([k, d]) => ({
      key: k,
      diff: d,
    }));

    // Create plan on dry-run.
    let planId: string | undefined;
    let planExpiresAt: string | undefined;
    if (result.dryRun) {
      const plan = await ctx.plans.create({
        operation: 'update_items_same_data',
        collection: args.collection,
        payload: {
          type: 'update_items_same_data',
          keys,
          data,
        },
        summary: {
          changedFields: Object.keys(data),
          affectedKeys: keys,
          itemCount: keys.length,
        },
        ttlSeconds: ctx.config.planTtlSeconds,
        maxBytes: ctx.config.planMaxBytes,
      } as never);
      planId = plan.id;
      planExpiresAt = plan.expiresAt;
    }

    const text = formatMutationText(
      {
        action: 'update',
        collection: args.collection,
        dryRun: result.dryRun,
        ok: true,
        summary: {
          total: keys.length,
          ok: keys.length,
          failed: 0,
          dryRun: result.dryRun,
        },
        results: perItemResults,
        planId,
        planExpiresAt,
        changedFields: Object.keys(data),
      },
      ctx.config,
    );

    return {
      content: [
        { type: 'text' as const, text },
      ],
      structuredContent: {
        ok: true,
        collection: args.collection,
        ...result,
        ...(planId ? { planId, planExpiresAt, requiresApplyPlan: true, written: false } : {}),
      },
    };
  },
};
