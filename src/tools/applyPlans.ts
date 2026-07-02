import { z } from 'zod';
import type { ToolContext } from '../mcp/server.js';
import { McpUserError } from '../directus/errors.js';
import { normalizeJsonLike } from '../safety/normalize.js';
import { applyPlanTool } from './applyPlan.js';

const Input = z.object({
  plan_ids: z.array(z.string()).optional(),
  // LibreChat sometimes passes arrays/objects to *_json fields instead of strings.
  plan_ids_json: z.unknown().optional(),
  confirm: z.boolean(),
  /** When true (default), stop at first error. When false, continue and report per-plan. */
  stop_on_error: z.boolean().optional(),
});

interface PlanApplyResult {
  planId: string;
  ok: boolean;
  applied?: boolean;
  written?: boolean;
  readBackOk?: boolean | null;
  operation?: string;
  collection?: string;
  key?: string | number;
  warning?: { code: string; message: string; details?: unknown };
  error?: { code: string; message: string; details?: unknown };
}

export const applyPlansTool = {
  name: 'directus_apply_plans',
  description:
    'Apply multiple previously-created dry-run mutation plans in sequence. Each plan was created by a mutation tool with dry_run=true. Requires confirm=true. By default (stop_on_error=true), stops at the first failed plan; set stop_on_error=false to continue and report per-plan results. Returns a summary table with per-plan outcomes.',
  inputSchema: Input,
  handler: async (ctx: ToolContext, rawArgs: unknown) => {
    const args = Input.parse(rawArgs);

    if (args.confirm !== true) {
      throw new McpUserError(
        'CONFIRM_TRUE_REQUIRED',
        'directus_apply_plans requires confirm=true to proceed with real writes.',
        {},
      );
    }

    // Resolve plan_ids from either plan_ids or plan_ids_json.
    let planIds: string[] | undefined = args.plan_ids;
    const rawJson = args.plan_ids_json;
    if (rawJson !== undefined) {
      const normalized = normalizeJsonLike(rawJson);
      if (Array.isArray(normalized)) {
        planIds = normalized.map((s, i) => {
          if (typeof s !== 'string') {
            throw new McpUserError('INVALID_DATA_TYPE', `plan_ids_json[${i}] must be a string`, { index: i });
          }
          return s;
        });
      } else if (typeof normalized === 'string') {
        // Single plan id string — wrap in array.
        planIds = [normalized];
      }
    }

    if (!planIds || planIds.length === 0) {
      throw new McpUserError('INVALID_DATA_TYPE', 'plan_ids (or plan_ids_json) must be a non-empty array', {});
    }

    const stopOnError = args.stop_on_error ?? true;
    const results: PlanApplyResult[] = [];
    let appliedCount = 0;
    let failedCount = 0;
    let warningCount = 0;
    let stopped = false;

    for (const planId of planIds) {
      try {
        // Reuse the single-plan apply tool's handler logic by calling it
        // directly. This ensures identical validation + read-back behavior.
        const singleResult = await applyPlanTool.handler(ctx, { plan_id: planId, confirm: true });
        const sc = singleResult.structuredContent as Record<string, unknown>;
        const ok = sc.ok === true;
        const hasWarning = !!sc.warning;
        results.push({
          planId,
          ok,
          applied: sc.applied as boolean | undefined,
          written: sc.written as boolean | undefined,
          readBackOk: sc.readBackOk as boolean | null | undefined,
          operation: sc.operation as string | undefined,
          collection: sc.collection as string | undefined,
          key: sc.key as string | number | undefined,
          warning: sc.warning as { code: string; message: string; details?: unknown } | undefined,
        });
        if (ok && !hasWarning) {
          appliedCount++;
        } else if (hasWarning) {
          appliedCount++;
          warningCount++;
        } else {
          failedCount++;
          if (stopOnError) {
            stopped = true;
            break;
          }
        }
      } catch (err) {
        const errorInfo = err instanceof McpUserError
          ? { code: err.errorCode, message: err.message, details: err.details }
          : err instanceof Error
            ? { code: 'DIRECTUS_API_ERROR', message: err.message, details: {} }
            : { code: 'DIRECTUS_API_ERROR', message: String(err), details: {} };
        results.push({ planId, ok: false, error: errorInfo });
        failedCount++;
        if (stopOnError) {
          stopped = true;
          break;
        }
      }
    }

    const total = planIds.length;

    // Tri-state read-back status:
    //   - 'ok'                       → every plan had readBackOk === true
    //   - 'partial_or_not_verified'  → no mismatches, but some plans had null/undefined
    //                                  (e.g., update_items_same_data which doesn't verify)
    //   - 'mismatch'                 → at least one plan had readBackOk === false
    const hasMismatch = results.some((r) => r.readBackOk === false);
    const hasUnverified = results.some((r) => r.readBackOk === null || r.readBackOk === undefined);
    const readBackStatus: 'ok' | 'partial_or_not_verified' | 'mismatch' = hasMismatch
      ? 'mismatch'
      : hasUnverified
        ? 'partial_or_not_verified'
        : 'ok';
    const allReadBackOk = readBackStatus === 'ok';

    const readBackText =
      readBackStatus === 'ok'
        ? 'All read-back checks: OK'
        : readBackStatus === 'partial_or_not_verified'
          ? 'Read-back checks: PARTIAL / NOT VERIFIED FOR SOME PLANS'
          : 'Read-back checks: MISMATCH';

    // Build summary text.
    const lines: string[] = [];
    lines.push('APPLY PLANS SUMMARY');
    lines.push(`Total: ${total}`);
    lines.push(`Applied: ${appliedCount}`);
    lines.push(`Failed: ${failedCount}`);
    lines.push(`Warnings: ${warningCount}`);
    if (stopped) {
      lines.push(`Stopped early (stop_on_error=true)`);
    }
    lines.push(readBackText);
    lines.push('');
    lines.push('Per-plan results:');
    for (const r of results) {
      const status = r.warning
        ? `WARNING (${r.warning.code})`
        : r.error
          ? `FAIL (${r.error.code})`
          : r.ok
            ? 'OK'
            : 'FAIL';
      lines.push(`  [${r.planId}] ${r.operation ?? '?'} ${r.collection ?? ''} ${r.key !== undefined ? `key=${r.key}` : ''} — ${status}`);
    }

    ctx.audit.record({
      ts: new Date().toISOString(),
      action: 'update',
      collection: '<multi>',
      keys: [],
      dryRun: false,
      ok: failedCount === 0,
      message: `apply_plans: ${appliedCount}/${total} applied, ${warningCount} warnings, ${failedCount} failed${stopped ? ' (stopped)' : ''}`,
    });

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
      structuredContent: {
        ok: failedCount === 0,
        total,
        applied: appliedCount,
        failed: failedCount,
        warnings: warningCount,
        stopped,
        allReadBackOk,
        readBackStatus,
        results,
      },
    };
  },
};
