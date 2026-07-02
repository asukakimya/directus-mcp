import { z } from 'zod';
import type { ToolContext } from '../mcp/server.js';
import { McpUserError } from '../directus/errors.js';

const Input = z.object({
  plan_id: z.string().min(1),
});

export const cancelPlanTool = {
  name: 'directus_cancel_plan',
  description:
    'Cancel a pending dry-run mutation plan. Once cancelled, the plan cannot be applied. Useful when the user rejects the proposed change. Already-applied or expired plans cannot be cancelled (they are already terminal).',
  inputSchema: Input,
  handler: async (ctx: ToolContext, rawArgs: unknown) => {
    const args = Input.parse(rawArgs);

    const plan = await ctx.plans.get(args.plan_id);
    if (!plan) {
      throw new McpUserError('PLAN_NOT_FOUND', `Plan ${args.plan_id} not found`, { planId: args.plan_id });
    }

    if (plan.status === 'applied') {
      throw new McpUserError('PLAN_ALREADY_APPLIED', `Plan ${plan.id} was already applied and cannot be cancelled.`, { planId: plan.id });
    }
    if (plan.status === 'expired') {
      throw new McpUserError('PLAN_EXPIRED', `Plan ${plan.id} has expired and cannot be cancelled.`, { planId: plan.id });
    }
    if (plan.status === 'cancelled') {
      // Already cancelled — idempotent.
      return {
        content: [{ type: 'text' as const, text: `Plan ${plan.id} was already cancelled.` }],
        structuredContent: { ok: true, planId: plan.id, status: 'cancelled', alreadyCancelled: true },
      };
    }

    await ctx.plans.markCancelled(plan.id);

    ctx.audit.record({
      ts: new Date().toISOString(),
      action: 'dry_run',
      collection: plan.collection,
      keys: plan.summary.affectedKeys ?? [],
      dryRun: true,
      ok: true,
      message: `plan ${plan.id} cancelled`,
    });

    return {
      content: [
        { type: 'text' as const, text: `CANCELLED plan ${plan.id} (operation: ${plan.operation}, collection: ${plan.collection}). No writes will happen for this plan.` },
      ],
      structuredContent: {
        ok: true,
        planId: plan.id,
        status: 'cancelled',
        operation: plan.operation,
        collection: plan.collection,
      },
    };
  },
};
