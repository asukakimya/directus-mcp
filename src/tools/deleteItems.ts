import { z } from 'zod';
import type { ToolContext } from '../mcp/server.js';
import { assertDeleteAllowed } from '../safety/permissions.js';
import { normalizeJsonLike, isPlainObject } from '../safety/normalize.js';
import { deleteItemsWithGuards } from '../directus/mutations.js';
import { formatMutationText } from '../safety/textFormat.js';
import { McpUserError } from '../directus/errors.js';

const Input = z.object({
  collection: z.string().min(1),
  keys: z.unknown().optional(),
  keys_json: z.string().optional(),
  verify: z.unknown().optional(),
  verify_json: z.string().optional(),
  confirm: z.string().optional(),
  dry_run: z.boolean().optional(),
});

export const deleteItemsTool = {
  name: 'directus_delete_items',
  description:
    'Delete one or more items by primary key. DISABLED by default — requires DIRECTUS_ALLOW_DELETE=true. Requires confirm="DELETE <collection>:<keys>". Reads each record first, runs optional verify, then deletes. When APPLY_REQUIRES_PLAN=true (default), dry_run=false is rejected — use dry_run=true then directus_apply_plan.',
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

    const rawVerify = args.verify_json !== undefined ? args.verify_json : args.verify;
    const verifyVal = normalizeJsonLike(rawVerify);
    let verify: Array<{ key: string | number; [field: string]: unknown }> | undefined;
    if (verifyVal !== undefined && verifyVal !== null) {
      if (!Array.isArray(verifyVal)) {
        throw new McpUserError('INVALID_DATA_TYPE', 'verify must be an array', { collection: args.collection });
      }
      verify = verifyVal.map((v, i) => {
        if (!isPlainObject(v)) {
          throw new McpUserError('INVALID_DATA_TYPE', `verify[${i}] must be an object`, { index: i });
        }
        return v as { key: string | number; [field: string]: unknown };
      });
    }

    assertDeleteAllowed(ctx.config, args.collection);

    const expectedConfirm = `DELETE ${args.collection}:${keys.join(',')}`;
    if (args.confirm !== expectedConfirm) {
      throw new McpUserError(
        'CONFIRMATION_REQUIRED',
        `Delete requires confirm='${expectedConfirm}'`,
        { collection: args.collection, keys, expected: expectedConfirm },
      );
    }

    const schema = await ctx.schema.loadCollectionSchema(args.collection);

    const dryRun = args.dry_run ?? ctx.config.mutationDryRunDefault;

    if (!dryRun && ctx.config.applyRequiresPlan) {
      throw new McpUserError(
        'APPLY_REQUIRES_PLAN',
        `Direct apply (dry_run=false) is disabled. Run dry_run:true first to create a plan, then call directus_apply_plan.`,
        { collection: args.collection },
      );
    }

    const result = await deleteItemsWithGuards(ctx.client, ctx.config, schema, keys, {
      dryRun,
      verify,
      confirm: args.confirm,
    });

    ctx.audit.record({
      ts: new Date().toISOString(),
      action: result.dryRun ? 'dry_run' : 'delete',
      collection: args.collection,
      keys,
      dryRun: result.dryRun,
      ok: true,
    });

    // Create plan on dry-run.
    let planId: string | undefined;
    let planExpiresAt: string | undefined;
    if (result.dryRun) {
      const plan = await ctx.plans.create({
        operation: 'delete_items',
        collection: args.collection,
        payload: {
          type: 'delete_items',
          keys,
          verify,
          confirm: args.confirm,
        },
        summary: {
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
        action: 'delete',
        collection: args.collection,
        dryRun: result.dryRun,
        ok: true,
        summary: {
          total: keys.length,
          ok: keys.length,
          failed: 0,
          dryRun: result.dryRun,
        },
        before: result.before,
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
        ok: true,
        ...result,
        ...(planId ? { planId, planExpiresAt, requiresApplyPlan: true, written: false } : {}),
      },
    };
  },
};
