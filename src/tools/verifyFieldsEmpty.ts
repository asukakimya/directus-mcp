import { z } from 'zod';
import type { ToolContext } from '../mcp/server.js';
import { McpUserError } from '../directus/errors.js';
import { normalizeJsonLike, isPlainObject } from '../safety/normalize.js';
import { assertCollectionReadable } from '../safety/permissions.js';
import { readItemsWithGuards } from '../directus/mutations.js';

const Input = z.object({
  collection: z.string().min(1),
  fields: z.array(z.string().min(1)).min(1),
  query: z.unknown().optional(),
  query_json: z.unknown().optional(),
});

/**
 * Check whether specified fields are "empty" across records in a collection.
 *
 * WHY: Directus JSON/array field filters (`_nnull`, `_nempty`) are not always
 * reliable — JSON columns may store `"null"`, `"[]"`, `"{}"`, or whitespace
 * strings that Directus considers non-null/non-empty. The only safe way to
 * verify "are these fields really clean?" after a bulk update is to read the
 * records and check client-side.
 *
 * "Empty" means: null, undefined, "", whitespace-only string, [], or {}.
 * Anything else is "non-empty" and reported.
 */
export const verifyFieldsEmptyTool = {
  name: 'directus_verify_fields_empty',
  description:
    'Verify that specified fields are empty across records in a collection. Use this after bulk updates (e.g., "clear all tags") to confirm no records still have non-empty values. Directus JSON/array filters (_nnull, _nempty) are NOT reliable for JSON fields — this tool reads records and checks client-side. Returns non-empty records so the agent can re-process them.',
  inputSchema: Input,
  handler: async (ctx: ToolContext, rawArgs: unknown) => {
    const args = Input.parse(rawArgs);

    assertCollectionReadable(ctx.config, args.collection);
    const schema = await ctx.schema.loadCollectionSchema(args.collection);

    // Build query: include PK + the fields to check.
    const pk = schema.primaryKey ?? 'id';
    const requestedFields = Array.from(new Set([pk, ...args.fields]));

    // User-provided query (filter/sort/limit/page/offset) — but we MUST
    // NOT let the user override our `fields` list, otherwise the tool could
    // fail to fetch the very fields it's supposed to verify. Strip `fields`
    // from userQuery before merging, and clamp `limit` to readMaxLimit.
    const rawQuery = args.query_json !== undefined ? args.query_json : args.query;
    const userQuery = normalizeJsonLike(rawQuery);
    if (userQuery !== undefined && userQuery !== null && !isPlainObject(userQuery)) {
      throw new McpUserError('INVALID_QUERY', 'query must be an object', { query: userQuery });
    }
    const userQueryObj = (userQuery as Record<string, unknown> | undefined) ?? {};
    // Strip `fields` — our requestedFields always wins.
    const { fields: _ignoredFields, ...safeUserQuery } = userQueryObj;
    void _ignoredFields;
    const userLimit = typeof safeUserQuery.limit === 'number' ? safeUserQuery.limit : undefined;
    const query = {
      ...safeUserQuery,
      fields: requestedFields,
      limit:
        userLimit !== undefined
          ? Math.min(userLimit, ctx.config.readMaxLimit)
          : ctx.config.readMaxLimit,
    };

    const result = await readItemsWithGuards(ctx.client, ctx.config, schema, query);
    const records = extractRecords(result.data);

    const nonEmpty: Array<Record<string, unknown>> = [];
    for (const record of records) {
      if (!isPlainObject(record)) continue;
      const nonEmptyFields: Record<string, unknown> = {};
      for (const field of args.fields) {
        const value = (record as Record<string, unknown>)[field];
        if (!isEmpty(value)) {
          nonEmptyFields[field] = value;
        }
      }
      if (Object.keys(nonEmptyFields).length > 0) {
        nonEmpty.push({
          [pk]: (record as Record<string, unknown>)[pk],
          ...nonEmptyFields,
          ...(typeof (record as Record<string, unknown>).company === 'string' ? { company: (record as Record<string, unknown>).company } : {}),
          ...(typeof (record as Record<string, unknown>).title === 'string' ? { title: (record as Record<string, unknown>).title } : {}),
          ...(typeof (record as Record<string, unknown>).name === 'string' ? { name: (record as Record<string, unknown>).name } : {}),
        });
      }
    }

    const ok = nonEmpty.length === 0;
    const lines: string[] = [];
    lines.push(`VERIFY FIELDS EMPTY — ${ok ? 'OK' : 'NON-EMPTY FOUND'}`);
    lines.push(`Collection: ${args.collection}`);
    lines.push(`Fields checked: ${args.fields.join(', ')}`);
    lines.push(`Records checked: ${records.length}`);
    lines.push(`Non-empty records: ${nonEmpty.length}`);
    if (!ok) {
      lines.push('');
      lines.push('Non-empty records (need re-processing):');
      for (const r of nonEmpty) {
        const fieldSummary = args.fields
          .filter((f) => r[f] !== undefined)
          .map((f) => `${f}=${JSON.stringify(r[f]).slice(0, 80)}`)
          .join(', ');
        lines.push(`  [${r[pk] ?? '?'}] ${fieldSummary}`);
      }
    }

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
      structuredContent: {
        ok,
        collection: args.collection,
        fieldsChecked: args.fields,
        totalChecked: records.length,
        nonEmptyCount: nonEmpty.length,
        nonEmpty,
        query: result.query,
      },
    };
  },
};

function extractRecords(response: unknown): unknown[] {
  if (Array.isArray(response)) return response;
  if (response && typeof response === 'object') {
    const r = response as { data?: unknown };
    if (Array.isArray(r.data)) return r.data;
    if (r.data && typeof r.data === 'object') return [r.data];
  }
  return [];
}

/**
 * "Empty" = null, undefined, "", whitespace-only string, [], or {}.
 * Everything else is non-empty.
 */
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}
