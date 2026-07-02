import { z } from 'zod';
import type { ToolContext } from '../mcp/server.js';
import { McpUserError } from '../directus/errors.js';
import { computeBundleStatus } from '../safety/bundles.js';

const Input = z.object({
  bundle_id: z.string().min(1),
});

export const planBundleStatusTool = {
  name: 'directus_plan_bundle_status',
  description:
    'Check the status of a plan bundle. Returns the bundle status (pending/partially_applied/applied/expired/cancelled/failed), per-plan statuses, and whether the bundle can still be applied or cancelled. Use this to check if a bundle was already applied before calling directus_apply_plan_bundle.',
  inputSchema: Input,
  handler: async (ctx: ToolContext, rawArgs: unknown) => {
    const args = Input.parse(rawArgs);

    const bundle = await ctx.bundles.get(args.bundle_id);
    if (!bundle) {
      throw new McpUserError('PLAN_NOT_FOUND', `Bundle ${args.bundle_id} not found`, { bundleId: args.bundle_id });
    }

    const status = await computeBundleStatus(bundle, ctx.plans);

    const lines: string[] = [];
    lines.push(`BUNDLE STATUS — ${status.status.toUpperCase()}`);
    lines.push(`Bundle ID: ${bundle.id}`);
    lines.push(`Collection: ${bundle.collection}`);
    lines.push(`Operation: ${bundle.operation}`);
    lines.push(`Plans: ${bundle.planIds.length}`);
    lines.push(`Can apply: ${status.canApply}`);
    lines.push(`Can cancel: ${status.canCancel}`);
    lines.push('');
    lines.push('Per-plan status:');
    for (const p of status.plans) {
      lines.push(`  [${p.planId}] ${p.status}${p.appliedAt ? ` (applied at ${p.appliedAt})` : ''}`);
    }
    lines.push('');
    lines.push('NEXT ACTION:');
    if (status.canApply) {
      lines.push(`- To apply: directus_apply_plan_bundle({ "bundle_id": "${bundle.id}", "confirm": true })`);
    } else if (status.status === 'applied') {
      lines.push('- Bundle already fully applied. No action needed.');
    } else if (status.status === 'expired') {
      lines.push('- Bundle has expired. Run the dry-run again to create a new bundle.');
    } else if (status.status === 'cancelled') {
      lines.push('- Bundle was cancelled. No action needed.');
    } else if (status.status === 'failed') {
      lines.push('- Bundle has failed plans. Check per-plan status above.');
    }

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
      structuredContent: {
        ok: true,
        bundleId: bundle.id,
        status: status.status,
        collection: bundle.collection,
        operation: bundle.operation,
        planIds: bundle.planIds,
        plans: status.plans,
        canApply: status.canApply,
        canCancel: status.canCancel,
        summary: bundle.summary,
      },
    };
  },
};
