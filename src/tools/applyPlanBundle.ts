import { z } from 'zod';
import type { ToolContext } from '../mcp/server.js';
import { McpUserError } from '../directus/errors.js';
import { applyPlanTool } from './applyPlan.js';
import { verifyFieldsValueTool } from './verifyFieldsValue.js';
import { verifyFieldsEmptyTool } from './verifyFieldsEmpty.js';

const Input = z.object({
  bundle_id: z.string().min(1),
  confirm: z.boolean(),
  stop_on_error: z.boolean().optional(),
  /** When true (default), PLAN_ALREADY_APPLIED is treated as success if verification passes. */
  treat_already_applied_as_success_if_verified: z.boolean().optional(),
  /** When true (default), run bundle-level verification after all plans applied. */
  verify_after_apply: z.boolean().optional(),
});

interface BundlePlanResult {
  planId: string;
  ok: boolean;
  status: 'applied' | 'already_applied_verified' | 'already_applied_unverified' | 'warning' | 'failed';
  applied?: boolean;
  written?: boolean;
  readBackOk?: boolean | null;
  warning?: { code: string; message: string };
  error?: { code: string; message: string; details?: unknown };
}

export const applyPlanBundleTool = {
  name: 'directus_apply_plan_bundle',
  description:
    'Apply all plans in a bundle (created by directus_update_by_query_plan). Requires confirm=true. By default, PLAN_ALREADY_APPLIED is treated as success if post-apply verification passes. Runs bundle-level verification after all plans are applied. Returns a summary with per-plan outcomes.',
  inputSchema: Input,
  handler: async (ctx: ToolContext, rawArgs: unknown) => {
    const args = Input.parse(rawArgs);

    if (args.confirm !== true) {
      throw new McpUserError(
        'CONFIRM_TRUE_REQUIRED',
        'directus_apply_plan_bundle requires confirm=true to proceed with real writes.',
        { bundleId: args.bundle_id },
      );
    }

    const bundle = await ctx.bundles.get(args.bundle_id);
    if (!bundle) {
      throw new McpUserError('PLAN_NOT_FOUND', `Bundle ${args.bundle_id} not found`, { bundleId: args.bundle_id });
    }

    // Check bundle expiry.
    if (new Date(bundle.expiresAt).getTime() < Date.now()) {
      throw new McpUserError('PLAN_EXPIRED', `Bundle ${bundle.id} has expired. Run the dry-run again to create a new bundle.`, { bundleId: bundle.id, expiresAt: bundle.expiresAt });
    }

    const stopOnError = args.stop_on_error ?? true;
    const treatAlreadyAppliedAsSuccess = args.treat_already_applied_as_success_if_verified ?? true;
    const verifyAfterApply = args.verify_after_apply ?? true;

    const results: BundlePlanResult[] = [];
    let appliedCount = 0;
    let alreadyAppliedCount = 0;
    let failedCount = 0;
    let warningCount = 0;
    let stopped = false;

    for (const planId of bundle.planIds) {
      try {
        const singleResult = await applyPlanTool.handler(ctx, { plan_id: planId, confirm: true });
        const sc = singleResult.structuredContent as Record<string, unknown>;
        const hasWarning = !!sc.warning;

        results.push({
          planId,
          ok: true,
          status: hasWarning ? 'warning' : 'applied',
          applied: sc.applied as boolean | undefined,
          written: sc.written as boolean | undefined,
          readBackOk: sc.readBackOk as boolean | null | undefined,
          warning: sc.warning as { code: string; message: string } | undefined,
        });

        if (hasWarning) {
          warningCount++;
          appliedCount++;
        } else {
          appliedCount++;
        }
      } catch (err) {
        const errCode = err instanceof McpUserError ? err.errorCode : 'DIRECTUS_API_ERROR';
        const errMsg = err instanceof Error ? err.message : String(err);
        const errDetails = err instanceof McpUserError ? err.details : {};

        // Handle PLAN_ALREADY_APPLIED.
        if (errCode === 'PLAN_ALREADY_APPLIED') {
          if (treatAlreadyAppliedAsSuccess) {
            // We'll verify at the bundle level after all plans.
            results.push({
              planId,
              ok: true,
              status: 'already_applied_verified', // will be confirmed by bundle verification
              applied: true,
              written: true,
            });
            alreadyAppliedCount++;
            continue;
          }
          results.push({
            planId,
            ok: false,
            status: 'already_applied_unverified',
            error: { code: errCode, message: errMsg, details: errDetails },
          });
          failedCount++;
          if (stopOnError) {
            stopped = true;
            break;
          }
        } else {
          results.push({
            planId,
            ok: false,
            status: 'failed',
            error: { code: errCode, message: errMsg, details: errDetails },
          });
          failedCount++;
          if (stopOnError) {
            stopped = true;
            break;
          }
        }
      }
    }

    // Tri-state read-back status.
    const hasMismatch = results.some((r) => r.readBackOk === false);
    const hasUnverified = results.some((r) => r.readBackOk === null || r.readBackOk === undefined);
    const readBackStatus: 'ok' | 'partial_or_not_verified' | 'mismatch' = hasMismatch
      ? 'mismatch'
      : hasUnverified
        ? 'partial_or_not_verified'
        : 'ok';

    // Bundle-level verification.
    let verification: { ok: boolean; totalChecked?: number; matchedCount?: number; mismatchCount?: number; mismatches?: unknown[]; error?: string } | undefined;
    if (verifyAfterApply && bundle.verification && failedCount === 0) {
      try {
        const verifResult = await runBundleVerification(ctx, bundle.collection, bundle.verification);
        verification = verifResult;
      } catch (err) {
        verification = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const totalPlans = bundle.planIds.length;
    const ok = failedCount === 0 && (!verification || verification.ok);

    // Build text.
    const lines: string[] = [];
    lines.push(`APPLIED PLAN BUNDLE — ${ok ? 'OK' : stopped ? 'STOPPED' : 'PARTIAL'}`);
    lines.push(`Bundle ID: ${bundle.id}`);
    lines.push(`Plans: ${totalPlans}`);
    lines.push(`Applied: ${appliedCount}`);
    lines.push(`Already applied: ${alreadyAppliedCount}`);
    lines.push(`Failed: ${failedCount}`);
    lines.push(`Warnings: ${warningCount}`);
    if (stopped) {
      lines.push(`Stopped early (stop_on_error=true)`);
    }
    lines.push(`Read-back: ${readBackStatus === 'ok' ? 'OK' : readBackStatus === 'partial_or_not_verified' ? 'PARTIAL / NOT VERIFIED' : 'MISMATCH'}`);
    if (verification) {
      lines.push(`Verification: ${verification.ok ? 'OK' : 'FAILED'}`);
      if (verification.totalChecked !== undefined) {
        lines.push(`  Total checked: ${verification.totalChecked}`);
      }
      if (verification.mismatchCount !== undefined && verification.mismatchCount > 0) {
        lines.push(`  Mismatches: ${verification.mismatchCount}`);
      }
      if (verification.error) {
        lines.push(`  Error: ${verification.error}`);
      }
    }
    lines.push('');
    lines.push('Per-plan results:');
    for (const r of results) {
      const status = r.status;
      lines.push(`  [${r.planId}] ${status}${r.warning ? ` (${r.warning.code})` : ''}${r.error ? ` — ${r.error.code}: ${r.error.message}` : ''}`);
    }
    lines.push('');
    lines.push('NEXT ACTION:');
    if (ok) {
      lines.push('- All plans applied successfully.');
      lines.push('- You can report success to the user.');
    } else {
      lines.push('- Some plans failed or verification failed.');
      lines.push('- Check per-plan results above.');
      lines.push('- Do not report full success.');
    }

    ctx.audit.record({
      ts: new Date().toISOString(),
      action: 'update',
      collection: bundle.collection,
      keys: bundle.summary.affectedKeys ?? [],
      dryRun: false,
      ok,
      message: `bundle ${bundle.id} applied: ${appliedCount}/${totalPlans} applied, ${alreadyAppliedCount} already-applied, ${failedCount} failed`,
    });

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
      structuredContent: {
        ok,
        bundleId: bundle.id,
        totalPlans,
        applied: appliedCount,
        alreadyApplied: alreadyAppliedCount,
        failed: failedCount,
        warnings: warningCount,
        written: appliedCount > 0,
        stopped,
        readBackStatus,
        verification,
        results,
      },
    };
  },
};

/**
 * Run bundle-level verification using either verify_fields_value or
 * verify_fields_empty depending on the bundle's verification spec.
 */
async function runBundleVerification(
  ctx: ToolContext,
  collection: string,
  verification: NonNullable<import('../safety/bundles.js').BundleVerification>,
): Promise<{ ok: boolean; totalChecked: number; matchedCount?: number; mismatchCount?: number; mismatches?: unknown[]; error?: string }> {
  if (verification.type === 'fields_value' && verification.expected) {
    const result = await verifyFieldsValueTool.handler(ctx, {
      collection,
      expected: verification.expected,
      query: verification.query ?? {},
    });
    const sc = result.structuredContent as Record<string, unknown>;
    return {
      ok: sc.ok as boolean,
      totalChecked: sc.totalChecked as number,
      matchedCount: sc.matchedCount as number,
      mismatchCount: sc.mismatchCount as number,
      mismatches: sc.mismatches as unknown[],
    };
  }
  if (verification.type === 'fields_empty' && verification.fields) {
    const result = await verifyFieldsEmptyTool.handler(ctx, {
      collection,
      fields: verification.fields,
      query: verification.query ?? {},
    });
    const sc = result.structuredContent as Record<string, unknown>;
    return {
      ok: sc.ok as boolean,
      totalChecked: sc.totalChecked as number,
      mismatchCount: sc.nonEmptyCount as number,
      mismatches: sc.nonEmpty as unknown[],
    };
  }
  return { ok: true, totalChecked: 0, error: 'No verification spec configured' };
}
