import { z } from 'zod';
import type { ToolContext } from '../mcp/server.js';
import { assertCollectionMutable, assertBatchSize } from '../safety/permissions.js';
import { normalizeJsonLike, isPlainObject } from '../safety/normalize.js';
import { batchUpdateItemsWithGuards } from '../directus/mutations.js';
import { formatMutationText } from '../safety/textFormat.js';
import { McpUserError } from '../directus/errors.js';

const Input = z.object({
  collection: z.string().min(1),
  items: z.unknown().optional(),
  items_json: z.string().optional(),
  dry_run: z.boolean().optional(),
  fail_fast: z.boolean().optional(),
  /**
   * When false (default), dry_run=false apply runs a preflight first;
   * if ANY item fails (verify / validation / unknown field), the ENTIRE
   * batch is aborted with `aborted: true` and zero writes happen.
   * Set to true to opt into partial-apply behaviour (older versions).
   */
  allow_partial_apply: z.boolean().optional(),
});

export const batchUpdateItemsTool = {
  name: 'directus_batch_update_items',
  description:
    'Update multiple items with PER-ITEM different data (serial PATCH /items/{collection}/{id}). Each item: { key, data, verify? }. By default (allow_partial_apply=false), apply runs all-or-nothing preflight: if any item fails verify/validation, the entire batch is aborted with zero writes. Set allow_partial_apply=true to opt into partial-success behaviour. Set dry_run=false to actually write.',
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
      const rec = item as Record<string, unknown>;
      const key = rec.key;
      if (typeof key !== 'string' && typeof key !== 'number') {
        throw new McpUserError('INVALID_DATA_TYPE', `items[${i}].key is required (string or number)`, { index: i });
      }
      const data = normalizeJsonLike(rec.data);
      if (!isPlainObject(data)) {
        throw new McpUserError('INVALID_DATA_TYPE', `items[${i}].data must be an object`, { index: i });
      }
      const verify = normalizeJsonLike(rec.verify);
      return {
        key: key as string | number,
        data: data as Record<string, unknown>,
        verify: (verify as Record<string, unknown> | undefined) ?? undefined,
      };
    });

    assertCollectionMutable(ctx.config, args.collection);
    const schema = await ctx.schema.loadCollectionSchema(args.collection);

    const result = await batchUpdateItemsWithGuards(ctx.client, ctx.config, schema, items, {
      dryRun: args.dry_run,
      failFast: args.fail_fast,
      allowPartialApply: args.allow_partial_apply,
    });

    ctx.audit.record({
      ts: new Date().toISOString(),
      action: result.summary.dryRun ? 'dry_run' : 'update',
      collection: args.collection,
      keys: items.map((i) => i.key),
      dryRun: result.summary.dryRun,
      ok: result.summary.failed === 0,
      message: result.summary.aborted
        ? `ABORTED (preflight): ${result.summary.abortReason ?? ''}`
        : `${result.summary.ok}/${result.summary.total} ok`,
    });

    const text = formatMutationText(
      {
        action: result.summary.dryRun ? 'dry_run' : 'update',
        collection: args.collection,
        dryRun: result.summary.dryRun,
        aborted: result.summary.aborted,
        abortReason: result.summary.abortReason,
        ok: result.summary.failed === 0 && !result.summary.aborted,
        summary: result.summary,
        results: result.results as unknown[],
      },
      ctx.config,
    );

    return {
      content: [
        { type: 'text' as const, text },
      ],
      structuredContent: {
        ok: result.summary.failed === 0 && !result.summary.aborted,
        collection: args.collection,
        ...result,
      },
    };
  },
};
