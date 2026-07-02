import { z } from 'zod';
import type { ToolContext } from '../mcp/server.js';
import { assertCollectionMutable, assertBatchSize } from '../safety/permissions.js';
import { normalizeJsonLike, isPlainObject } from '../safety/normalize.js';
import { createItemsWithGuards } from '../directus/mutations.js';
import { formatMutationText } from '../safety/textFormat.js';
import { McpUserError } from '../directus/errors.js';

const Input = z.object({
  collection: z.string().min(1),
  items: z.unknown().optional(),
  // LibreChat sometimes passes arrays/objects to *_json fields instead of strings.
  // Accept any type here; handler normalises + validates.
  items_json: z.unknown().optional(),
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
    'Create multiple items serially. Each item has its own data + optional dedupe. Batch size limited by MUTATION_MAX_BATCH_SIZE. By default (allow_partial_apply=false), apply runs all-or-nothing preflight: if any item fails validation/dedupe, the entire batch is aborted with zero creates. When APPLY_REQUIRES_PLAN=true (default), dry_run=false is rejected — use dry_run=true then directus_apply_plan.',
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

    const dryRun = args.dry_run ?? ctx.config.mutationDryRunDefault;

    if (!dryRun && ctx.config.applyRequiresPlan) {
      throw new McpUserError(
        'APPLY_REQUIRES_PLAN',
        `Direct apply (dry_run=false) is disabled. Run dry_run:true first to create a plan, then call directus_apply_plan.`,
        { collection: args.collection },
      );
    }

    const result = await createItemsWithGuards(ctx.client, ctx.config, schema, items, {
      dryRun,
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

    // Create plan on successful dry-run.
    let planId: string | undefined;
    let planExpiresAt: string | undefined;
    if (result.summary.dryRun && !result.summary.aborted && result.summary.failed === 0) {
      const plan = await ctx.plans.create({
        operation: 'create_items',
        collection: args.collection,
        payload: {
          type: 'create_items',
          items,
          allowPartialApply: args.allow_partial_apply ?? false,
        },
        summary: {
          itemCount: items.length,
          affectedKeys: [],
        },
        ttlSeconds: ctx.config.planTtlSeconds,
        maxBytes: ctx.config.planMaxBytes,
      } as never);
      planId = plan.id;
      planExpiresAt = plan.expiresAt;
    }

    const text = formatMutationText(
      {
        action: 'create',
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
