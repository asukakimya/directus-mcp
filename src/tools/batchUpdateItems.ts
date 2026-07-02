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
  allow_partial_apply: z.boolean().optional(),
});

export const batchUpdateItemsTool = {
  name: 'directus_batch_update_items',
  description:
    'Update multiple items with PER-ITEM different data (serial PATCH /items/{collection}/{id}). Each item: { key, data, verify? }. By default (allow_partial_apply=false), apply runs all-or-nothing preflight: if any item fails verify/validation, the entire batch is aborted with zero writes. When APPLY_REQUIRES_PLAN=true (default), dry_run=false is rejected — use dry_run=true then directus_apply_plan.',
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

    const dryRun = args.dry_run ?? ctx.config.mutationDryRunDefault;

    if (!dryRun && ctx.config.applyRequiresPlan) {
      throw new McpUserError(
        'APPLY_REQUIRES_PLAN',
        `Direct apply (dry_run=false) is disabled. Run dry_run:true first to create a plan, then call directus_apply_plan.`,
        { collection: args.collection },
      );
    }

    const result = await batchUpdateItemsWithGuards(ctx.client, ctx.config, schema, items, {
      dryRun,
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

    // Create plan on successful dry-run (no abort, no failures).
    let planId: string | undefined;
    let planExpiresAt: string | undefined;
    if (result.summary.dryRun && !result.summary.aborted && result.summary.failed === 0) {
      const plan = await ctx.plans.create({
        operation: 'batch_update_items',
        collection: args.collection,
        payload: {
          type: 'batch_update_items',
          items,
          allowPartialApply: args.allow_partial_apply ?? false,
          failFast: args.fail_fast ?? false,
        },
        summary: {
          affectedKeys: items.map((i) => i.key),
          itemCount: items.length,
          changedFields: Array.from(new Set(items.flatMap((i) => Object.keys(i.data)))),
        },
        ttlSeconds: ctx.config.planTtlSeconds,
        maxBytes: ctx.config.planMaxBytes,
      } as never);
      planId = plan.id;
      planExpiresAt = plan.expiresAt;
    }

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
        planId,
        planExpiresAt,
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
        ...(planId ? { planId, planExpiresAt, requiresApplyPlan: true, written: false } : {}),
      },
    };
  },
};
