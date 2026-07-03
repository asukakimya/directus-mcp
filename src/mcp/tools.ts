import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './server.js';
import { schemaOverviewTool } from '../tools/schemaOverview.js';
import { schemaDetailTool } from '../tools/schemaDetail.js';
import { readItemsTool } from '../tools/readItems.js';
import { readItemTool } from '../tools/readItem.js';
import { createItemTool } from '../tools/createItem.js';
import { createItemsTool } from '../tools/createItems.js';
import { updateItemTool } from '../tools/updateItem.js';
import { updateItemsSameDataTool } from '../tools/updateItemsSameData.js';
import { batchUpdateItemsTool } from '../tools/batchUpdateItems.js';
import { deleteItemsTool } from '../tools/deleteItems.js';
import { dryRunMutationTool } from '../tools/dryRunMutation.js';
import { applyPlanTool } from '../tools/applyPlan.js';
import { applyPlansTool } from '../tools/applyPlans.js';
import { applyPlanBundleTool } from '../tools/applyPlanBundle.js';
import { cancelPlanTool } from '../tools/cancelPlan.js';
import { cancelPlansTool } from '../tools/cancelPlans.js';
import { planBundleStatusTool } from '../tools/planBundleStatus.js';
import { verifyFieldsEmptyTool } from '../tools/verifyFieldsEmpty.js';
import { verifyFieldsValueTool } from '../tools/verifyFieldsValue.js';
import { updateByQueryPlanTool } from '../tools/updateByQueryPlan.js';
import { searchItemsTool } from '../tools/searchItems.js';
import { McpUserError, type ErrorCode } from '../directus/errors.js';
import { DirectusApiError } from '../directus/rest.js';
import { normalizeJsonLike } from '../safety/normalize.js';
import type { ZodTypeAny, ZodObject, ZodRawShape } from 'zod';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: ZodObject<ZodRawShape>;
  handler: (ctx: ToolContext, args: unknown) => Promise<ToolOutput>;
}

interface ToolOutput {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
}

const TOOL_DEFS: Array<ToolDef> = [
  schemaOverviewTool,
  schemaDetailTool,
  readItemsTool,
  readItemTool,
  searchItemsTool,
  createItemTool,
  createItemsTool,
  updateItemTool,
  updateItemsSameDataTool,
  batchUpdateItemsTool,
  deleteItemsTool,
  dryRunMutationTool,
  applyPlanTool,
  applyPlansTool,
  applyPlanBundleTool,
  cancelPlanTool,
  cancelPlansTool,
  planBundleStatusTool,
  verifyFieldsEmptyTool,
  verifyFieldsValueTool,
  updateByQueryPlanTool,
];

/**
 * Register every directus_* tool onto the McpServer.
 *
 * Each tool is wrapped so that:
 *   - Input is normalised FIRST (recursively) so stringified JSON
 *     values like `data: "{\"x\":1}"` are parsed before zod runs.
 *   - McpUserError → structured error response with `ok: false`.
 *   - DirectusApiError → DIRECTUS_API_ERROR.
 *   - Other Errors → DIRECTUS_API_ERROR (defensive).
 */
export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  for (const def of TOOL_DEFS) {
    const shape: ZodRawShape = def.inputSchema.shape;
    server.tool(
      def.name,
      def.description,
      shape,
      async (rawArgs: Record<string, unknown>) => {
        try {
          // Step 1: recursively normalise any stringified JSON fields
          // (e.g. `data: "{\"x\":1}"` -> `data: { x: 1 }`). Each tool
          // handler runs its own zod parse afterwards.
          const normalised = normalizeJsonLike(rawArgs) as Record<string, unknown>;
          const result = await def.handler(ctx, normalised);
          return {
            content: result.content,
            structuredContent: result.structuredContent as Record<string, unknown>,
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: describeError(err) }],
            structuredContent: toErrorStructured(err),
            isError: true,
          };
        }
      },
    );
  }
}

function describeError(err: unknown): string {
  let baseMsg: string;
  if (err instanceof McpUserError) {
    baseMsg = `[${err.errorCode}] ${err.message}`;
  } else if (err instanceof DirectusApiError) {
    baseMsg = `Directus API error ${err.status} ${err.method} ${err.url}`;
  } else if (err instanceof Error) {
    baseMsg = `${err.name}: ${err.message}`;
  } else {
    baseMsg = String(err);
  }

  // Add NEXT_ACTION hints for common error codes to guide low-param models.
  if (err instanceof McpUserError) {
    const nextAction = getNextActionForError(err);
    if (nextAction) {
      return `${baseMsg}\n\nNEXT_ACTION:\n${nextAction}`;
    }
  }

  return baseMsg;
}

function getNextActionForError(err: McpUserError): string | null {
  switch (err.errorCode) {
    case 'VERIFY_REQUIRED':
      return '- If this is a single update, call update tool with verify_fields:["company"] or a verify object matching current record values.\n- Do not use {"ai_info": true}.\n- If this is a bulk update, prefer directus_update_by_query_plan with verify_fields.';
    case 'VERIFY_FAILED':
      return '- The verify object does not match the current record.\n- Re-read the target record or use verify_fields to let MCP generate verify.\n- Do not assume markdown/special characters caused this error.';
    case 'APPLY_REQUIRES_PLAN':
      if (typeof err.details.tool === 'string') {
        return `- Call ${err.details.tool} with dry_run:true.\n- Then call directus_apply_plan after user approval.`;
      }
      return '- First call mutation with dry_run:true.\n- Use returned plan_id or bundle_id.\n- On approval, call apply_plan or apply_plan_bundle.';
    case 'PLAN_ALREADY_APPLIED':
      return '- Do not apply this plan again.\n- Verify the target state.\n- If target state is correct, report already applied and verified.';
    case 'PLAN_ALREADY_IN_PROGRESS':
      return '- Another apply is in progress for this plan. Wait and check status.';
    case 'UNKNOWN_FIELD':
      return '- Check field names against directus_schema_detail.\n- Do not guess field names.';
    case 'INVALID_DATA_TYPE':
      return '- Do not repeat the same payload.\n- Try *_json fallback or use server-side query plan tool.';
    default:
      return null;
  }
}

function toErrorStructured(err: unknown): {
  ok: false;
  error: { code: ErrorCode | string; message: string; details: unknown };
} {
  if (err instanceof McpUserError) {
    return { ok: false, error: err.toJSON() };
  }
  if (err instanceof DirectusApiError) {
    const mcp = err.toMcpError();
    return { ok: false, error: mcp.toJSON() };
  }
  if (err instanceof Error) {
    return {
      ok: false,
      error: {
        code: 'DIRECTUS_API_ERROR',
        message: err.message,
        details: { name: err.name },
      },
    };
  }
  return {
    ok: false,
    error: {
      code: 'DIRECTUS_API_ERROR',
      message: String(err),
      details: {},
    },
  };
}

// suppress unused-import warning in case ZodTypeAny is referenced only by types above
export type _ZodTypeAny = ZodTypeAny;
