import { z } from 'zod';
import type { ToolContext } from '../mcp/server.js';
import { assertCollectionReadable } from '../safety/permissions.js';
import { normalizeJsonLike, isPlainObject } from '../safety/normalize.js';
import { readItemWithGuards } from '../directus/mutations.js';
import { formatReadItemText } from '../safety/textFormat.js';
import { McpUserError } from '../directus/errors.js';

const Input = z.object({
  collection: z.string().min(1),
  key: z.union([z.string(), z.number()]),
  query: z.unknown().optional(),
  query_json: z.string().optional(),
});

export const readItemTool = {
  name: 'directus_read_item',
  description:
    'Read a single item by primary key. Returns the full record (or only the requested fields if query.fields is set).',
  inputSchema: Input,
  handler: async (ctx: ToolContext, rawArgs: unknown) => {
    const args = Input.parse(rawArgs);

    const rawQuery = args.query_json !== undefined ? args.query_json : args.query;
    const query = normalizeJsonLike(rawQuery);
    if (query !== undefined && query !== null && !isPlainObject(query)) {
      throw new McpUserError('INVALID_QUERY', 'query must be an object', { query });
    }

    assertCollectionReadable(ctx.config, args.collection);
    const schema = await ctx.schema.loadCollectionSchema(args.collection);
    const result = await readItemWithGuards(
      ctx.client,
      ctx.config,
      schema,
      args.key,
      query as Record<string, unknown> | undefined,
    );

    const text = formatReadItemText(args.collection, args.key, result.data, ctx.config);

    return {
      content: [
        { type: 'text' as const, text },
      ],
      structuredContent: {
        ok: true,
        collection: args.collection,
        key: args.key,
        query: result.query,
        warnings: result.warnings,
        data: result.data,
      },
    };
  },
};
