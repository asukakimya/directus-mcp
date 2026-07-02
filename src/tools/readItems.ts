import { z } from 'zod';
import type { ToolContext } from '../mcp/server.js';
import { assertCollectionReadable } from '../safety/permissions.js';
import { normalizeJsonLike, isPlainObject } from '../safety/normalize.js';
import { readItemsWithGuards } from '../directus/mutations.js';
import { formatReadItemsTextV2, type OutputMode, type ReadPurpose } from '../safety/textFormat.js';
import { McpUserError } from '../directus/errors.js';
import { buildListPurposeFields } from '../safety/listFields.js';

const Input = z.object({
  collection: z.string().min(1),
  query: z.unknown().optional(),
  query_json: z.unknown().optional(),
  output_mode: z.enum(['auto', 'preview', 'compact_full', 'summary', 'count_only', 'json_full']).optional(),
  purpose: z.enum(['auto', 'list', 'detail', 'mutation_candidates', 'verification', 'count']).optional(),
});

export const readItemsTool = {
  name: 'directus_read_items',
  description:
    'List items in a Directus collection with a validated query. Supports fields, filter, sort, limit, offset, deep. Wildcard fields (*) are rejected by default. output_mode:"compact_full" renders all records in text (up to READ_COMPACT_FULL_MAX_ROWS). purpose:"list" auto-selects short display fields. For bulk mutations use directus_update_by_query_plan instead of manually enumerating records.',
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

    const outputMode = (args.output_mode ?? 'auto') as OutputMode;
    const purpose = (args.purpose ?? 'auto') as ReadPurpose;

    // If purpose is "list" and user didn't specify fields, auto-select
    // short display fields from schema (PK + display field + website/status).
    let effectiveQuery = query as Record<string, unknown> | undefined;
    if (purpose === 'list' && effectiveQuery && effectiveQuery.fields === undefined) {
      effectiveQuery = { ...effectiveQuery, fields: buildListPurposeFields(schema) };
    } else if (purpose === 'list' && !effectiveQuery) {
      effectiveQuery = { fields: buildListPurposeFields(schema) };
    }

    const result = await readItemsWithGuards(
      ctx.client,
      ctx.config,
      schema,
      effectiveQuery,
    );

    // Determine hasMore / nextOffset.
    const limit = typeof result.query.limit === 'number' ? result.query.limit : null;
    const offset = typeof result.query.offset === 'number' ? result.query.offset : 0;
    const hasMore = result.totalAvailable !== null
      ? offset + result.returnedRecords < result.totalAvailable
      : limit !== null && result.returnedRecords >= limit;
    const nextOffset = hasMore ? offset + result.returnedRecords : null;

    // Use V2 formatter.
    const { text, meta } = formatReadItemsTextV2({
      collection: args.collection,
      query: result.query,
      records: result.records,
      totalAvailable: result.totalAvailable,
      hasMore,
      nextOffset,
      outputMode,
      purpose,
      limits: ctx.config,
    });

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
        records: result.records,
        readMeta: meta,
      },
    };
  },
};
