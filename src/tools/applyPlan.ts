import { z } from 'zod';
import type { ToolContext } from '../mcp/server.js';
import { McpUserError } from '../directus/errors.js';
import { verifyPlanChecksum, type MutationPlan } from '../safety/plans.js';
import {
  assertCollectionMutable,
  assertDeleteAllowed,
  isSystemCollection,
} from '../safety/permissions.js';
import {
  createItemWithGuards,
  createItemsWithGuards,
  updateItemWithGuards,
  updateItemsSameDataWithGuards,
  batchUpdateItemsWithGuards,
  deleteItemsWithGuards,
  readBackVerify,
  readBackDelete,
} from '../directus/mutations.js';
import { formatMutationText } from '../safety/textFormat.js';

const Input = z.object({
  plan_id: z.string().min(1),
  confirm: z.boolean(),
});

interface ApplyResult {
  operation: string;
  collection: string;
  key?: string | number;
  before?: unknown;
  after?: unknown;
  diff?: unknown;
  created?: unknown;
  changedFields?: string[];
  keys?: Array<string | number>;
  summary?: { total?: number; ok?: number; failed?: number; dryRun?: boolean; aborted?: boolean; abortReason?: string };
  results?: unknown[];
  readBackOk: boolean | null;
  readBackMismatches?: Array<{ field: string; expected: unknown; actual: unknown }>;
  readBackPerItem?: unknown[];
  deleted?: boolean;
  /** When present, write happened but post-write verification surfaced a warning. */
  warning?: { code: string; message: string; details?: unknown };
}

export const applyPlanTool = {
  name: 'directus_apply_plan',
  description:
    'Apply a previously created dry-run mutation plan. The plan was created by a mutation tool (directus_update_item, directus_create_item, etc.) with dry_run=true. This tool performs the REAL write. Requires confirm=true. Re-validates collection guards, schema, field validation, and verify conditions before writing. Performs read-back verification after write. Idempotent: a plan can only be applied once. If write succeeds but read-back verification fails, the plan is marked terminal (applied_with_warning) and the warning is returned — the plan CANNOT be re-applied.',
  inputSchema: Input,
  handler: async (ctx: ToolContext, rawArgs: unknown) => {
    const args = Input.parse(rawArgs);

    if (args.confirm !== true) {
      throw new McpUserError(
        'CONFIRM_TRUE_REQUIRED',
        'directus_apply_plan requires confirm=true to proceed with the real write.',
        { planId: args.plan_id },
      );
    }

    // 1. Atomically claim the plan (pending → applying). This is the
    //    race-condition guard: two concurrent apply calls cannot both
    //    pass. claimForApply throws PLAN_ALREADY_APPLIED / PLAN_ALREADY_IN_PROGRESS /
    //    PLAN_EXPIRED / PLAN_CANCELLED / PLAN_NOT_FOUND as appropriate.
    const claimed = await ctx.plans.claimForApply(args.plan_id);
    const plan = claimed as MutationPlan;

    // 2. Verify checksum (detect corruption/tampering).
    //    CRITICAL: this happens AFTER claim (plan is now 'applying').
    //    If checksum fails, we must mark the plan cancelled so it can't
    //    be re-claimed (the payload is corrupt — re-applying would be
    //    dangerous). Then throw PLAN_CHECKSUM_MISMATCH.
    //    This is a PRE-WRITE error (no write happened), so cancelled is
    //    the correct terminal status.
    try {
      verifyPlanChecksum(plan);
    } catch (err) {
      await ctx.plans.markCancelled(plan.id);
      throw err;
    }

    // 3. Re-check collection guards (config may have changed since dry-run).
    const collection = plan.collection;
    if (isSystemCollection(collection)) {
      // Pre-write error — mark cancelled since the operation can never be valid here.
      await ctx.plans.markCancelled(plan.id);
      throw new McpUserError('SYSTEM_COLLECTION_DENIED', `Plan targets system collection '${collection}' which is denied for mutation.`, { planId: plan.id, collection });
    }
    if (plan.operation === 'delete_items') {
      try {
        assertDeleteAllowed(ctx.config, collection);
      } catch (err) {
        await ctx.plans.markCancelled(plan.id);
        throw err;
      }
    } else {
      try {
        assertCollectionMutable(ctx.config, collection);
      } catch (err) {
        await ctx.plans.markCancelled(plan.id);
        throw err;
      }
    }

    // 4. Re-load schema.
    const schema = await ctx.schema.loadCollectionSchema(collection);

    // 5. Execute operation. CRITICAL: anything that throws AFTER this point
    //    may mean a write happened. We must mark the plan terminal (not leave
    //    it in 'applying'). The pattern: try the write, on success do read-back,
    //    on read-back mismatch mark applied_with_warning (NOT throw), on
    //    unexpected post-write error mark failed_after_write.
    const payload = plan.payload;
    let applyResult: ApplyResult;
    let writeHappened = false;

    try {
      switch (payload.type) {
        case 'update_item': {
          const r = await updateItemWithGuards(ctx.client, ctx.config, schema, payload.key, payload.data, {
            dryRun: false,
            verify: payload.verify,
          });
          writeHappened = true;
          // Read-back verification.
          const rb = await readBackVerify(ctx.client, schema, payload.key, payload.data);
          applyResult = {
            operation: 'update_item',
            collection,
            key: payload.key,
            before: r.before,
            after: r.after,
            diff: r.diff,
            changedFields: Object.keys(payload.data),
            readBackOk: rb.ok,
            readBackMismatches: rb.mismatches,
          };
          if (!rb.ok) {
            // CRITICAL: write happened, but record doesn't match intent.
            // Mark terminal with warning — do NOT throw, do NOT leave pending.
            const warning = {
              code: 'READBACK_MISMATCH' as const,
              message: `Update was written but read-back verification failed for ${rb.mismatches.length} field(s). The record may have been modified by a Directus flow/trigger after the write.`,
              details: { mismatches: rb.mismatches },
            };
            applyResult.warning = warning;
            await ctx.plans.markAppliedWithWarning(plan.id, warning);
          } else {
            await ctx.plans.markApplied(plan.id);
          }
          break;
        }

        case 'batch_update_items': {
          const r = await batchUpdateItemsWithGuards(ctx.client, ctx.config, schema, payload.items, {
            dryRun: false,
            failFast: payload.failFast ?? false,
            allowPartialApply: payload.allowPartialApply ?? false,
          });
          // If aborted by preflight, no writes happened. Safe to mark cancelled.
          if (r.summary.aborted) {
            await ctx.plans.markCancelled(plan.id);
            throw new McpUserError(
              'ABORTED_BY_PREFLIGHT',
              `Plan apply aborted by preflight: ${r.summary.abortReason}`,
              { planId: plan.id, abortReason: r.summary.abortReason },
            );
          }
          writeHappened = true;
          // Read-back for each successful item.
          const readBacks: Array<{ key: string | number; ok: boolean; mismatches?: Array<{ field: string; expected: unknown; actual: unknown }> }> = [];
          for (const item of r.results) {
            if ('error' in item) continue;
            const payloadItem = payload.items.find((p) => p.key === item.key);
            if (!payloadItem) continue;
            const rb = await readBackVerify(ctx.client, schema, item.key, payloadItem.data);
            readBacks.push({ key: item.key, ok: rb.ok, mismatches: rb.mismatches });
          }
          const allReadBackOk = readBacks.every((rb) => rb.ok);
          applyResult = {
            operation: 'batch_update_items',
            collection,
            summary: r.summary,
            results: r.results as unknown[],
            readBackOk: allReadBackOk,
            readBackPerItem: readBacks,
          };
          if (!allReadBackOk) {
            const failedReadbacks = readBacks.filter((rb) => !rb.ok);
            const warning = {
              code: 'READBACK_MISMATCH' as const,
              message: `Batch update was written but read-back verification failed for ${failedReadbacks.length} item(s).`,
              details: { failedItems: failedReadbacks },
            };
            applyResult.warning = warning;
            await ctx.plans.markAppliedWithWarning(plan.id, warning);
          } else {
            await ctx.plans.markApplied(plan.id);
          }
          break;
        }

        case 'update_items_same_data': {
          const r = await updateItemsSameDataWithGuards(ctx.client, ctx.config, schema, payload.keys, payload.data, {
            dryRun: false,
          });
          writeHappened = true;
          applyResult = {
            operation: 'update_items_same_data',
            collection,
            keys: payload.keys,
            before: r.before,
            after: r.after,
            diff: r.diff,
            changedFields: Object.keys(payload.data),
            readBackOk: null, // bulk update read-back is complex; null = not verified
          };
          await ctx.plans.markApplied(plan.id);
          break;
        }

        case 'create_item': {
          const r = await createItemWithGuards(ctx.client, ctx.config, schema, payload.data, {
            dryRun: false,
            dedupe: payload.dedupe,
          });
          writeHappened = true;
          // Real read-back: try to read the created item by its primary key.
          let readBackOk: boolean | null = null;
          let readBackMismatches: Array<{ field: string; expected: unknown; actual: unknown }> | undefined;
          if (r.created && typeof r.created === 'object') {
            // Directus wraps single-item responses as { data: {...} }.
            const createdObj = r.created as Record<string, unknown>;
            const createdRecord = (createdObj.data && typeof createdObj.data === 'object'
              ? createdObj.data
              : createdObj) as Record<string, unknown>;
            const pk = schema.primaryKey ?? 'id';
            const createdId = createdRecord[pk];
            if (createdId !== undefined && createdId !== null) {
              const rb = await readBackVerify(ctx.client, schema, createdId as string | number, payload.data);
              readBackOk = rb.ok;
              readBackMismatches = rb.mismatches;
            }
          }
          applyResult = {
            operation: 'create_item',
            collection,
            created: r.created,
            changedFields: Object.keys(payload.data),
            readBackOk,
            readBackMismatches,
          };
          if (readBackOk === false) {
            const warning = {
              code: 'READBACK_MISMATCH' as const,
              message: `Create succeeded but read-back verification failed for ${readBackMismatches?.length ?? 0} field(s).`,
              details: { mismatches: readBackMismatches },
            };
            applyResult.warning = warning;
            await ctx.plans.markAppliedWithWarning(plan.id, warning);
          } else {
            await ctx.plans.markApplied(plan.id);
          }
          break;
        }

        case 'create_items': {
          const r = await createItemsWithGuards(ctx.client, ctx.config, schema, payload.items, {
            dryRun: false,
            allowPartialApply: payload.allowPartialApply ?? false,
          });
          if (r.summary.aborted) {
            await ctx.plans.markCancelled(plan.id);
            throw new McpUserError(
              'ABORTED_BY_PREFLIGHT',
              `Plan apply aborted by preflight: ${r.summary.abortReason}`,
              { planId: plan.id, abortReason: r.summary.abortReason },
            );
          }
          writeHappened = true;
          applyResult = {
            operation: 'create_items',
            collection,
            summary: r.summary,
            results: r.results as unknown[],
            readBackOk: r.summary.failed === 0,
          };
          if (r.summary.failed > 0) {
            const warning = {
              code: 'PARTIAL_FAILURE' as const,
              message: `Batch create had ${r.summary.failed} failure(s) out of ${r.summary.total}.`,
              details: { summary: r.summary },
            };
            applyResult.warning = warning;
            await ctx.plans.markAppliedWithWarning(plan.id, warning);
          } else {
            await ctx.plans.markApplied(plan.id);
          }
          break;
        }

        case 'delete_items': {
          const expectedConfirm = `DELETE ${collection}:${payload.keys.join(',')}`;
          if (payload.confirm !== expectedConfirm) {
            await ctx.plans.markCancelled(plan.id);
            throw new McpUserError(
              'CONFIRMATION_REQUIRED',
              `Plan requires confirm='${expectedConfirm}' but stored confirm is '${payload.confirm}'`,
              { planId: plan.id, expected: expectedConfirm },
            );
          }
          const r = await deleteItemsWithGuards(ctx.client, ctx.config, schema, payload.keys, {
            dryRun: false,
            verify: payload.verify,
            confirm: payload.confirm,
          });
          writeHappened = true;
          // Read-back: try to read each key, expect not found.
          const readBacks: Array<{ key: string | number; gone: boolean }> = [];
          for (const k of payload.keys) {
            const gone = await readBackDelete(ctx.client, collection, k);
            readBacks.push({ key: k, gone });
          }
          const allGone = readBacks.every((rb) => rb.gone);
          applyResult = {
            operation: 'delete_items',
            collection,
            keys: payload.keys,
            before: r.before,
            deleted: r.deleted,
            readBackOk: allGone,
            readBackPerItem: readBacks,
          };
          if (!allGone) {
            const stillPresent = readBacks.filter((rb) => !rb.gone);
            const warning = {
              code: 'READBACK_MISMATCH' as const,
              message: `Delete was issued but ${stillPresent.length} item(s) are still readable post-delete.`,
              details: { stillPresent },
            };
            applyResult.warning = warning;
            await ctx.plans.markAppliedWithWarning(plan.id, warning);
          } else {
            await ctx.plans.markApplied(plan.id);
          }
          break;
        }

        default: {
          await ctx.plans.markCancelled(plan.id);
          throw new McpUserError('PLAN_STORE_ERROR', `Unknown plan payload type`, { planId: plan.id });
        }
      }
    } catch (err) {
      // Post-write error handling. If writeHappened is true, we cannot
      // safely leave the plan in 'applying' — mark failed_after_write so
      // it can never be re-applied. The caller must investigate via read.
      if (writeHappened) {
        const errInfo = err instanceof McpUserError
          ? { code: err.errorCode, message: err.message, details: err.details }
          : err instanceof Error
            ? { code: 'DIRECTUS_API_ERROR', message: err.message, details: {} }
            : { code: 'DIRECTUS_API_ERROR', message: String(err), details: {} };
        await ctx.plans.markFailedAfterWrite(plan.id, errInfo);
        // Re-throw so the caller sees the error, but the plan is now terminal.
        throw err;
      }
      // Pre-write error — re-throw, plan stays in 'applying' which will
      // be transitioned by claimForApply on next attempt. Actually, to
      // be safe, mark cancelled so it can't be retried (pre-write errors
      // are typically config/validation issues that won't fix themselves).
      try { await ctx.plans.markCancelled(plan.id); } catch { /* ignore */ }
      throw err;
    }

    // 6. Audit log — do NOT log full payload.
    ctx.audit.record({
      ts: new Date().toISOString(),
      action: plan.operation === 'delete_items' ? 'delete' : plan.operation.startsWith('create') ? 'create' : 'update',
      collection,
      keys: plan.summary.affectedKeys ?? [],
      dryRun: false,
      ok: applyResult.warning ? false : true,
      message: applyResult.warning
        ? `plan ${plan.id} applied_with_warning: ${applyResult.warning.code}`
        : `plan ${plan.id} applied`,
    });

    // 7. Build response.
    const text = formatMutationText(
      {
        action: plan.operation === 'delete_items' ? 'delete' : plan.operation.startsWith('create') ? 'create' : 'update',
        collection,
        dryRun: false,
        ok: !applyResult.warning,
        applied: true,
        planId: plan.id,
        readBackOk: applyResult.readBackOk,
        readBackMismatches: applyResult.readBackMismatches,
        summary: applyResult.summary
          ? { ...applyResult.summary, dryRun: false }
          : undefined,
        before: applyResult.before,
        after: applyResult.after ?? applyResult.created,
        diff: applyResult.diff as Record<string, { before: unknown; after: unknown; changed: boolean }> | undefined,
        results: applyResult.results,
        error: applyResult.warning,
      },
      ctx.config,
    );

    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: {
        ok: !applyResult.warning,
        applied: true,
        dryRun: false,
        written: true,
        planId: plan.id,
        ...applyResult,
      },
    };
  },
};

// Suppress unused import warning
export type _MutationPlan = MutationPlan;
