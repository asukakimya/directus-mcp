import { z } from 'zod';
import type { ToolContext } from '../mcp/server.js';
import { assertCollectionMutable } from '../safety/permissions.js';
import { normalizeJsonLike, isPlainObject } from '../safety/normalize.js';
import { createItemWithGuards } from '../directus/mutations.js';
import { McpUserError } from '../directus/errors.js';

const Input = z.object({
  collection: z.string().min(1),
  data: z.unknown().optional(),
  data_json: z.string().optional(),
  dedupe: z.unknown().optional(),
  dedupe_json: z.string().optional(),
  dry_run: z.boolean().optional(),
});

export const createItemTool = {
  name: 'directus_create_item',
  description:
    'Create a single item. Validates fields against schema, runs dedupe check if provided, and supports dry_run. By default dry_run=true (set dry_run=false to actually write). data may be sent as object or as JSON string in data_json.',
  inputSchema: Input,
  handler: async (ctx: ToolContext, rawArgs: unknown) => {
    const args = Input.parse(rawArgs);

    const rawData = args.data_json !== undefined ? args.data_json : args.data;
    const data = normalizeJsonLike(rawData);
    if (!isPlainObject(data)) {
      throw new McpUserError('INVALID_DATA_TYPE', 'data must be a JSON object', { collection: args.collection });
    }

    const rawDedupe = args.dedupe_json !== undefined ? args.dedupe_json : args.dedupe;
    const dedupe = normalizeJsonLike(rawDedupe);
    if (dedupe !== undefined && dedupe !== null && !isPlainObject(dedupe)) {
      throw new McpUserError('INVALID_DATA_TYPE', 'dedupe must be a JSON object', { collection: args.collection });
    }

    assertCollectionMutable(ctx.config, args.collection);
    const schema = await ctx.schema.loadCollectionSchema(args.collection);

    const result = await createItemWithGuards(ctx.client, ctx.config, schema, data, {
      dryRun: args.dry_run,
      dedupe: dedupe as Record<string, unknown> | undefined,
    });

    ctx.audit.record({
      ts: new Date().toISOString(),
      action: 'create',
      collection: args.collection,
      keys: [],
      dryRun: result.dryRun,
      ok: true,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: result.dryRun
            ? `Dry-run create on ${args.collection}: would write.`
            : `Created item in ${args.collection}.`,
        },
      ],
      structuredContent: {
        ok: true,
        ...result,
      },
    };
  },
};
