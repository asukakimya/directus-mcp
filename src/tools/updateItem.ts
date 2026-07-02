import { z } from 'zod';
import type { ToolContext } from '../mcp/server.js';
import { assertCollectionMutable } from '../safety/permissions.js';
import { normalizeJsonLike, isPlainObject } from '../safety/normalize.js';
import { updateItemWithGuards } from '../directus/mutations.js';
import { formatMutationText } from '../safety/textFormat.js';
import { McpUserError } from '../directus/errors.js';

const Input = z.object({
  collection: z.string().min(1),
  key: z.union([z.string(), z.number()]),
  data: z.unknown().optional(),
  data_json: z.unknown().optional(),
  verify: z.unknown().optional(),
  verify_json: z.unknown().optional(),
  dry_run: z.boolean().optional(),
});

export const updateItemTool = {
  name: 'directus_update_item',
  description:
    'Update a single item by primary key. Reads the record first, runs optional verify check, validates fields, computes diff, and (unless dry_run=true) writes via PATCH. After-write re-read returns the updated record. Returns before/after/diff. When APPLY_REQUIRES_PLAN=true (default), dry_run=false is rejected — use dry_run=true then directus_apply_plan.',
  inputSchema: Input,
  handler: async (ctx: ToolContext, rawArgs: unknown) => {
    const args = Input.parse(rawArgs);

    const rawData = args.data_json !== undefined ? args.data_json : args.data;
    const data = normalizeJsonLike(rawData);
    if (!isPlainObject(data)) {
      throw new McpUserError('INVALID_DATA_TYPE', 'data must be a JSON object', {
        collection: args.collection,
        key: args.key,
      });
    }

    const rawVerify = args.verify_json !== undefined ? args.verify_json : args.verify;
    const verify = normalizeJsonLike(rawVerify);
    if (verify !== undefined && verify !== null && !isPlainObject(verify)) {
      throw new McpUserError('INVALID_DATA_TYPE', 'verify must be a JSON object', {
        collection: args.collection,
        key: args.key,
      });
    }

    assertCollectionMutable(ctx.config, args.collection);
    const schema = await ctx.schema.loadCollectionSchema(args.collection);

    const dryRun = args.dry_run ?? ctx.config.mutationDryRunDefault;

    if (!dryRun && ctx.config.applyRequiresPlan) {
      throw new McpUserError(
        'APPLY_REQUIRES_PLAN',
        `Direct apply (dry_run=false) is disabled. Run dry_run:true first to create a plan, then call directus_apply_plan.`,
        { collection: args.collection, key: args.key },
      );
    }

    const result = await updateItemWithGuards(ctx.client, ctx.config, schema, args.key, data, {
      dryRun,
      verify: verify as Record<string, unknown> | undefined,
    });

    ctx.audit.record({
      ts: new Date().toISOString(),
      action: result.dryRun ? 'dry_run' : 'update',
      collection: args.collection,
      keys: [args.key],
      dryRun: result.dryRun,
      ok: true,
    });

    // Create plan on dry-run.
    let planId: string | undefined;
    let planExpiresAt: string | undefined;
    if (result.dryRun) {
      const plan = await ctx.plans.create({
        operation: 'update_item',
        collection: args.collection,
        payload: {
          type: 'update_item',
          key: args.key,
          data,
          verify: verify as Record<string, unknown> | undefined,
        },
        summary: {
          changedFields: Object.keys(data),
          affectedKeys: [args.key],
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
        action: 'update',
        collection: args.collection,
        dryRun: result.dryRun,
        ok: true,
        before: result.before,
        after: result.after,
        diff: result.diff,
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
