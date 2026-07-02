import { z } from 'zod';
import type { ToolContext } from '../mcp/server.js';
import { McpUserError } from '../directus/errors.js';
import { normalizeJsonLike } from '../safety/normalize.js';

const Input = z.object({
  plan_ids: z.array(z.string()).optional(),
  plan_ids_json: z.unknown().optional(),
});

interface PlanCancelResult {
  planId: string;
  ok: boolean;
  status?: string;
  error?: { code: string; message: string; details?: unknown };
}

export const cancelPlansTool = {
  name: 'directus_cancel_plans',
  description:
    'Cancel multiple pending dry-run mutation plans in one call. Already-applied/expired plans are reported as errors. Useful when the user rejects a batch of proposed changes.',
  inputSchema: Input,
  handler: async (ctx: ToolContext, rawArgs: unknown) => {
    const args = Input.parse(rawArgs);

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
        planIds = [normalized];
      }
    }

    if (!planIds || planIds.length === 0) {
      throw new McpUserError('INVALID_DATA_TYPE', 'plan_ids (or plan_ids_json) must be a non-empty array', {});
    }

    const results: PlanCancelResult[] = [];
    let cancelledCount = 0;
    let failedCount = 0;

    for (const planId of planIds) {
      try {
        const plan = await ctx.plans.get(planId);
        if (!plan) {
          results.push({ planId, ok: false, error: { code: 'PLAN_NOT_FOUND', message: `Plan ${planId} not found`, details: {} } });
          failedCount++;
          continue;
        }
        if (plan.status === 'applied' || plan.status === 'applied_with_warning' || plan.status === 'failed_after_write') {
          results.push({
            planId,
            ok: false,
            status: plan.status,
            error: { code: 'PLAN_ALREADY_APPLIED', message: `Plan ${planId} was already applied and cannot be cancelled.`, details: { status: plan.status } },
          });
          failedCount++;
          continue;
        }
        if (plan.status === 'expired') {
          results.push({
            planId,
            ok: false,
            status: plan.status,
            error: { code: 'PLAN_EXPIRED', message: `Plan ${planId} has expired and cannot be cancelled.`, details: {} },
          });
          failedCount++;
          continue;
        }
        if (plan.status === 'cancelled') {
          // Already cancelled — idempotent success.
          results.push({ planId, ok: true, status: 'cancelled' });
          cancelledCount++;
          continue;
        }
        await ctx.plans.markCancelled(planId);
        results.push({ planId, ok: true, status: 'cancelled' });
        cancelledCount++;
      } catch (err) {
        const errorInfo = err instanceof McpUserError
          ? { code: err.errorCode, message: err.message, details: err.details }
          : err instanceof Error
            ? { code: 'DIRECTUS_API_ERROR', message: err.message, details: {} }
            : { code: 'DIRECTUS_API_ERROR', message: String(err), details: {} };
        results.push({ planId, ok: false, error: errorInfo });
        failedCount++;
      }
    }

    const lines: string[] = [];
    lines.push('CANCEL PLANS SUMMARY');
    lines.push(`Total: ${planIds.length}`);
    lines.push(`Cancelled: ${cancelledCount}`);
    lines.push(`Failed: ${failedCount}`);
    lines.push('');
    lines.push('Per-plan results:');
    for (const r of results) {
      const status = r.ok ? 'CANCELLED' : `FAIL (${r.error?.code ?? 'UNKNOWN'})`;
      lines.push(`  [${r.planId}] — ${status}`);
    }

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
      structuredContent: {
        ok: failedCount === 0,
        total: planIds.length,
        cancelled: cancelledCount,
        failed: failedCount,
        results,
      },
    };
  },
};
