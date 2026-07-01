import { z } from 'zod';
import type { ToolContext } from '../mcp/server.js';
import { assertCollectionMutable, assertBatchSize } from '../safety/permissions.js';
import { normalizeJsonLike, isPlainObject } from '../safety/normalize.js';
import { createItemsWithGuards } from '../directus/mutations.js';
import { McpUserError } from '../directus/errors.js';

const Input = z.object({
  collection: z.string().min(1),
  items: z.unknown().optional(),
  items_json: z.string().optional(),
  dry_run: z.boolean().optional(),
  /**
   * When false (default), dry_run=false apply runs a preflight first;
   * if ANY item fails validation or dedupe, the ENTIRE batch is
   * aborted with `aborted: true` and zero creates happen.
   * Set to true to opt into partial-create behaviour.
   */
  allow_partial_apply: z.boolean().optional(),
});

export const createItemsTool = {
  name: 'directus_create_items',
  description:
    'Create multiple items serially. Each item has its own data + optional dedupe. Batch size limited by MUTATION_MAX_BATCH_SIZE. By default (allow_partial_apply=false), apply runs all-or-nothing preflight: if any item fails validation/dedupe, the entire batch is aborted with zero creates. Set allow_partial_apply=true for partial-success behaviour. Set dry_run=false to actually write.',
  inputSchema: Input,
  handler: async (ctx: ToolContext, rawArgs: unknown) => {
    const args = Input.parse(rawArgs);

    const rawItems = args.items_json !== undefined ? args.items_json : args.items;
    const itemsVal = normalizeJsonLike(rawItems);
    if (!Array.isArray(itemsVal)) {
      throw new McpUserError('INVALID_DATA_TYPE', 'items must be an array', { collection: args.collection });
    }
    assertBatchSize(ctx.config, itemsVal.length);

    const items = itemsVal.map((item, i) => {
      if (!isPlainObject(item)) {
        throw new McpUserError('INVALID_DATA_TYPE', `items[${i}] must be an object`, { index: i });
      }
      const dataRaw = (item as Record<string, unknown>).data;
      const data = normalizeJsonLike(dataRaw);
      if (!isPlainObject(data)) {
        throw new McpUserError('INVALID_DATA_TYPE', `items[${i}].data must be an object`, { index: i });
      }
      const dedupeRaw = (item as Record<string, unknown>).dedupe;
      const dedupe = normalizeJsonLike(dedupeRaw);
      return {
        data: data as Record<string, unknown>,
        dedupe: (dedupe as Record<string, unknown> | undefined) ?? undefined,
      };
    });

    assertCollectionMutable(ctx.config, args.collection);
    const schema = await ctx.schema.loadCollectionSchema(args.collection);

    const result = await createItemsWithGuards(ctx.client, ctx.config, schema, items, {
      dryRun: args.dry_run,
      allowPartialApply: args.allow_partial_apply,
    });

    ctx.audit.record({
      ts: new Date().toISOString(),
      action: 'create',
      collection: args.collection,
      keys: [],
      dryRun: result.summary.dryRun,
      ok: result.summary.failed === 0,
      message: result.summary.aborted
        ? `ABORTED (preflight): ${result.summary.abortReason ?? ''}`
        : `${result.summary.ok}/${result.summary.total} ok`,
    });

    const summaryText = result.summary.aborted
      ? `Batch create ABORTED (all-or-nothing preflight failed): ${result.summary.abortReason ?? ''}`
      : `Batch create ${result.summary.ok}/${result.summary.total} ok on ${args.collection} (dryRun=${result.summary.dryRun}).`;
    return {
      content: [
        {
          type: 'text' as const,
          text: summaryText,
        },
      ],
      structuredContent: {
        ok: result.summary.failed === 0 && !result.summary.aborted,
        collection: args.collection,
        ...result,
      },
    };
  },
};
