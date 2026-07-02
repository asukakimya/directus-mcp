import { z } from 'zod';
import type { ToolContext } from '../mcp/server.js';
import { assertCollectionMutable } from '../safety/permissions.js';
import { normalizeJsonLike, isPlainObject } from '../safety/normalize.js';
import { createItemWithGuards } from '../directus/mutations.js';
import { formatMutationText } from '../safety/textFormat.js';
import { McpUserError } from '../directus/errors.js';

const Input = z.object({
  collection: z.string().min(1),
  data: z.unknown().optional(),
  data_json: z.unknown().optional(),
  dedupe: z.unknown().optional(),
  dedupe_json: z.unknown().optional(),
  dry_run: z.boolean().optional(),
});

export const createItemTool = {
  name: 'directus_create_item',
  description:
    'Create a single item. Validates fields against schema, runs dedupe check if provided, and supports dry_run. By default dry_run=true (set dry_run=false to actually write). When APPLY_REQUIRES_PLAN=true (default), dry_run=false is rejected — use dry_run=true then directus_apply_plan. data may be sent as object or as JSON string in data_json.',
  inputSchema: Input,
  handler: async (ctx: ToolContext, rawArgs: unknown) => {
    const args = Input.parse(rawArgs);

    const rawData = args.data_json !== undefined ? args.data_json : args.data;
    const data = normalizeJsonLike(rawData);
    if (!isPlainObject(data)) {
      throw new McpUserError('INVALID_DATA_TYPE', 'data must be a JSON object', { collection: args.collection });
    }

    const rawDedupe = args.dedupe_json !== undefined ? args.dedupe_json : args.dedupe;
    const dedupe = normalizeJsonLike(rawDedupe);
    if (dedupe !== undefined && dedupe !== null && !isPlainObject(dedupe)) {
      throw new McpUserError('INVALID_DATA_TYPE', 'dedupe must be a JSON object', { collection: args.collection });
    }

    assertCollectionMutable(ctx.config, args.collection);
    const schema = await ctx.schema.loadCollectionSchema(args.collection);

    const dryRun = args.dry_run ?? ctx.config.mutationDryRunDefault;

    // APPLY_REQUIRES_PLAN enforcement: block direct apply.
    if (!dryRun && ctx.config.applyRequiresPlan) {
      throw new McpUserError(
        'APPLY_REQUIRES_PLAN',
        `Direct apply (dry_run=false) is disabled. Run dry_run:true first to create a plan, then call directus_apply_plan.`,
        { collection: args.collection },
      );
    }

    const result = await createItemWithGuards(ctx.client, ctx.config, schema, data, {
      dryRun,
      dedupe: dedupe as Record<string, unknown> | undefined,
    });

    ctx.audit.record({
      ts: new Date().toISOString(),
      action: 'create',
      collection: args.collection,
      keys: [],
      dryRun: result.dryRun,
      ok: true,
    });

    // Create plan on dry-run so the model can apply via directus_apply_plan.
    let planId: string | undefined;
    let planExpiresAt: string | undefined;
    if (result.dryRun) {
      const plan = await ctx.plans.create({
        operation: 'create_item',
        collection: args.collection,
        payload: {
          type: 'create_item',
          data,
          dedupe: dedupe as Record<string, unknown> | undefined,
        },
        summary: {
          changedFields: Object.keys(data),
          itemCount: 1,
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
        dryRun: result.dryRun,
        ok: true,
        after: result.created,
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
        ...result,
        ...(planId ? { planId, planExpiresAt, requiresApplyPlan: true, written: false } : {}),
      },
    };
  },
};
