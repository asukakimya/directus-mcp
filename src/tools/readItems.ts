import { z } from 'zod';
import type { ToolContext } from '../mcp/server.js';
import { assertCollectionReadable } from '../safety/permissions.js';
import { normalizeJsonLike, isPlainObject } from '../safety/normalize.js';
import { readItemsWithGuards } from '../directus/mutations.js';
import { formatReadItemsText } from '../safety/textFormat.js';
import { McpUserError } from '../directus/errors.js';

const Input = z.object({
  collection: z.string().min(1),
  query: z.unknown().optional(),
  query_json: z.unknown().optional(),
});

export const readItemsTool = {
  name: 'directus_read_items',
  description:
    'List items in a Directus collection with a validated query. Supports fields, filter, sort, limit, offset, deep. Wildcard fields (*) are rejected by default. If you send query as a JSON string it will be parsed automatically.',
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
    const result = await readItemsWithGuards(
      ctx.client,
      ctx.config,
      schema,
      query as Record<string, unknown> | undefined,
    );

    const text = formatReadItemsText(
      args.collection,
      result.query,
      result.data,
      ctx.config,
    );

    return {
      content: [
        { type: 'text' as const, text },
      ],
      structuredContent: {
        ok: true,
        collection: args.collection,
        query: result.query,
        warnings: result.warnings,
        data: result.data,
      },
    };
  },
};
