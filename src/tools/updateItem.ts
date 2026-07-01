import { z } from 'zod';
import type { ToolContext } from '../mcp/server.js';
import { assertCollectionMutable } from '../safety/permissions.js';
import { normalizeJsonLike, isPlainObject } from '../safety/normalize.js';
import { updateItemWithGuards } from '../directus/mutations.js';
import { McpUserError } from '../directus/errors.js';

const Input = z.object({
  collection: z.string().min(1),
  key: z.union([z.string(), z.number()]),
  data: z.unknown().optional(),
  data_json: z.string().optional(),
  verify: z.unknown().optional(),
  verify_json: z.string().optional(),
  dry_run: z.boolean().optional(),
});

export const updateItemTool = {
  name: 'directus_update_item',
  description:
    'Update a single item by primary key. Reads the record first, runs optional verify check, validates fields, computes diff, and (unless dry_run=true) writes via PATCH. After-write re-read returns the updated record. Returns before/after/diff.',
  inputSchema: Input,
  handler: async (ctx: ToolContext, rawArgs: unknown) => {
    const args = Input.parse(rawArgs);

    const rawData = args.data_json !== undefined ? args.data_json : args.data;
    const data = normalizeJsonLike(rawData);
    if (!isPlainObject(data)) {
      throw new McpUserError('INVALID_DATA_TYPE', 'data must be a JSON object', {
        collection: args.collection,
        key: args.key,
      });
    }

    const rawVerify = args.verify_json !== undefined ? args.verify_json : args.verify;
    const verify = normalizeJsonLike(rawVerify);
    if (verify !== undefined && verify !== null && !isPlainObject(verify)) {
      throw new McpUserError('INVALID_DATA_TYPE', 'verify must be a JSON object', {
        collection: args.collection,
        key: args.key,
      });
    }

    assertCollectionMutable(ctx.config, args.collection);
    const schema = await ctx.schema.loadCollectionSchema(args.collection);

    const result = await updateItemWithGuards(ctx.client, ctx.config, schema, args.key, data, {
      dryRun: args.dry_run,
      verify: verify as Record<string, unknown> | undefined,
    });

    ctx.audit.record({
      ts: new Date().toISOString(),
      action: result.dryRun ? 'dry_run' : 'update',
      collection: args.collection,
      keys: [args.key],
      dryRun: result.dryRun,
      ok: true,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: result.dryRun
            ? `Dry-run update on ${args.collection}:${args.key} (wouldWrite=${result.diff ? Object.values(result.diff).some((d) => d.changed) : false}).`
            : `Updated ${args.collection}:${args.key}.`,
        },
      ],
      structuredContent: {
        ok: true,
        ...result,
      },
    };
  },
};
