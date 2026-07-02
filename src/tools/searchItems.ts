import { z } from 'zod';
import type { ToolContext } from '../mcp/server.js';
import { assertCollectionReadable } from '../safety/permissions.js';
import { normalizeJsonLike } from '../safety/normalize.js';
import { readItemsWithGuards } from '../directus/mutations.js';
import { formatReadItemsTextV2, type OutputMode, type ReadPurpose } from '../safety/textFormat.js';
import { McpUserError } from '../directus/errors.js';
import { buildListPurposeFields, autoSelectSearchFields } from '../safety/listFields.js';

const Input = z.object({
  collection: z.string().min(1),
  search: z.string().min(1),
  search_fields: z.array(z.string().min(1)).optional(),
  search_fields_json: z.unknown().optional(),
  fields: z.array(z.string().min(1)).optional(),
  fields_json: z.unknown().optional(),
  limit: z.number().int().positive().max(100).optional(),
  output_mode: z.enum(['auto', 'preview', 'compact_full', 'summary', 'count_only']).optional(),
  purpose: z.enum(['auto', 'list', 'detail', 'mutation_candidates', 'verification', 'count']).optional(),
});

/**
 * Generic search tool: search any collection by text across specified fields.
 *
 * If search_fields is not provided, auto-selects searchable string fields from schema.
 * If fields is not provided, auto-selects short display fields (same as purpose:"list").
 *
 * This is a generic Directus tool — no domain-specific logic.
 */
export const searchItemsTool = {
  name: 'directus_search_items',
  description:
    'Search items in any Directus collection by text across specified fields. Uses _icontains filter. If search_fields not provided, auto-selects searchable string fields from schema. If fields not provided, auto-selects short display fields. Supports output_mode and purpose like directus_read_items. search_fields_json and fields_json accept JSON strings for LibreChat compatibility.',
  inputSchema: Input,
  handler: async (ctx: ToolContext, rawArgs: unknown) => {
    const args = Input.parse(rawArgs);

    assertCollectionReadable(ctx.config, args.collection);
    const schema = await ctx.schema.loadCollectionSchema(args.collection);
    const pk = schema.primaryKey ?? 'id';

    // Resolve search_fields — support *_json fallback for LibreChat.
    const rawSearchFields = args.search_fields_json !== undefined ? args.search_fields_json : args.search_fields;
    let searchFields: string[] | undefined;
    if (rawSearchFields !== undefined) {
      const normalized = normalizeJsonLike(rawSearchFields);
      if (!Array.isArray(normalized)) {
        throw new McpUserError('INVALID_QUERY', 'search_fields must be an array of strings', { search_fields: rawSearchFields });
      }
      searchFields = normalized.filter((f): f is string => typeof f === 'string' && f.length > 0);
    }

    // Auto-select search fields if not provided.
    if (!searchFields || searchFields.length === 0) {
      searchFields = autoSelectSearchFields(schema);
    }
    if (searchFields.length === 0) {
      throw new McpUserError('INVALID_QUERY', `No searchable string fields found in collection '${args.collection}'. Provide search_fields explicitly.`, {
        collection: args.collection,
      });
    }

    // Validate search fields exist in schema.
    for (const f of searchFields) {
      if (!schema.fields[f]) {
        throw new McpUserError('UNKNOWN_FIELD', `Search field '${f}' does not exist in collection '${args.collection}'`, {
          collection: args.collection,
          field: f,
        });
      }
    }

    // Resolve output fields — support *_json fallback for LibreChat.
    const rawFields = args.fields_json !== undefined ? args.fields_json : args.fields;
    let outputFields: string[] | undefined;
    if (rawFields !== undefined) {
      const normalized = normalizeJsonLike(rawFields);
      if (!Array.isArray(normalized)) {
        throw new McpUserError('INVALID_QUERY', 'fields must be an array of strings', { fields: rawFields });
      }
      outputFields = normalized.filter((f): f is string => typeof f === 'string' && f.length > 0);
    }

    // Auto-select output fields if not provided.
    if (!outputFields || outputFields.length === 0) {
      outputFields = buildListPurposeFields(schema);
    }

    // Build _or filter across search fields.
    const filter = {
      _or: searchFields.map((f) => ({
        [f]: { _icontains: args.search },
      })),
    };

    const limit = args.limit ?? 20;
    const outputMode = (args.output_mode ?? 'compact_full') as OutputMode;
    const purpose = (args.purpose ?? 'list') as ReadPurpose;

    const result = await readItemsWithGuards(
      ctx.client,
      ctx.config,
      schema,
      {
        fields: outputFields,
        filter,
        limit,
        sort: [pk],
      },
    );

    // Determine hasMore / nextOffset.
    const hasMore = result.totalAvailable !== null
      ? result.returnedRecords < result.totalAvailable
      : result.returnedRecords >= limit;
    const nextOffset = hasMore ? result.returnedRecords : null;

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

    // Replace tool name and add search-specific header.
    const finalText = text
      .replace('TOOL_RESULT: directus_read_items', 'TOOL_RESULT: directus_search_items')
      .replace(/^(COLLECTION: .+)$/m, `$1\nSEARCH: ${args.search}\nSEARCH_FIELDS: ${searchFields.join(', ')}`)
      + '\n\nNEXT_ACTION:\n- You may use these search results to decide which record to inspect next.\n- For full details of a selected record, call directus_read_item with explicit fields.\n- Do not infer hidden or omitted fields.';

    return {
      content: [
        { type: 'text' as const, text: finalText },
      ],
      structuredContent: {
        ok: true,
        collection: args.collection,
        search: args.search,
        searchFields,
        query: result.query,
        warnings: result.warnings,
        data: result.data,
        records: result.records,
        readMeta: meta,
      },
    };
  },
};
