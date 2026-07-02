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
import { cancelPlanTool } from '../tools/cancelPlan.js';
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
  createItemTool,
  createItemsTool,
  updateItemTool,
  updateItemsSameDataTool,
  batchUpdateItemsTool,
  deleteItemsTool,
  dryRunMutationTool,
  applyPlanTool,
  cancelPlanTool,
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
  if (err instanceof McpUserError) {
    return `[${err.errorCode}] ${err.message}`;
  }
  if (err instanceof DirectusApiError) {
    return `Directus API error ${err.status} ${err.method} ${err.url}`;
  }
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return String(err);
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
