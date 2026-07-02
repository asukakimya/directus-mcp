import { z } from 'zod';
import type { ToolContext } from '../mcp/server.js';
import { McpUserError } from '../directus/errors.js';
import { normalizeJsonLike, isPlainObject } from '../safety/normalize.js';
import { assertCollectionReadable } from '../safety/permissions.js';
import { readItemsWithGuards } from '../directus/mutations.js';

const Input = z.object({
  collection: z.string().min(1),
  expected: z.unknown().optional(),
  expected_json: z.unknown().optional(),
  query: z.unknown().optional(),
  query_json: z.unknown().optional(),
  limit: z.number().int().min(1).optional(),
});

interface FieldMismatch {
  key: string | number;
  display?: string;
  field: string;
  expected: unknown;
  actual: unknown;
}

export const verifyFieldsValueTool = {
  name: 'directus_verify_fields_value',
  description:
    'Verify that specified fields match expected values across records in a collection. Uses deep equality for objects/arrays. Use this after bulk updates (e.g., "set all tags to [test]") to confirm all records now have the expected values. Returns mismatches so the agent can re-process them.',
  inputSchema: Input,
  handler: async (ctx: ToolContext, rawArgs: unknown) => {
    const args = Input.parse(rawArgs);

    // Resolve expected.
    const rawExpected = args.expected_json !== undefined ? args.expected_json : args.expected;
    const expected = normalizeJsonLike(rawExpected) as Record<string, unknown> | undefined;
    if (!isPlainObject(expected) || Object.keys(expected).length === 0) {
      throw new McpUserError('INVALID_DATA_TYPE', 'expected must be a non-empty object (field → value)', { collection: args.collection });
    }

    assertCollectionReadable(ctx.config, args.collection);
    const schema = await ctx.schema.loadCollectionSchema(args.collection);
    const pk = schema.primaryKey ?? 'id';

    // Resolve query.
    const rawQuery = args.query_json !== undefined ? args.query_json : args.query;
    const userQuery = normalizeJsonLike(rawQuery);
    if (userQuery !== undefined && userQuery !== null && !isPlainObject(userQuery)) {
      throw new McpUserError('INVALID_QUERY', 'query must be an object', { query: userQuery });
    }
    const userQueryObj = (userQuery as Record<string, unknown> | undefined) ?? {};
    const { fields: _ignoredFields, ...safeUserQuery } = userQueryObj;
    void _ignoredFields;

    // Build query: PK + expected fields + display fields (company/title/name).
    // Only include display fields that actually exist in the schema.
    const displayCandidates = ['company', 'title', 'name'];
    const availableDisplayFields = displayCandidates.filter((f) => schema.fields[f]);
    const requestedFields = Array.from(new Set([pk, ...Object.keys(expected), ...availableDisplayFields]));
    const maxLimit = ctx.config.readMaxLimit;
    const userLimit = typeof safeUserQuery.limit === 'number' ? safeUserQuery.limit : args.limit;
    const query = {
      ...safeUserQuery,
      fields: requestedFields,
      limit: userLimit !== undefined ? Math.min(userLimit, maxLimit) : maxLimit,
    };

    const result = await readItemsWithGuards(ctx.client, ctx.config, schema, query);
    const records = extractRecords(result.data);

    const mismatches: FieldMismatch[] = [];
    let matchedCount = 0;

    for (const record of records) {
      if (!isPlainObject(record)) continue;
      const rec = record as Record<string, unknown>;
      const key = rec[pk] as string | number;
      const display = displayCandidates
        .map((f) => rec[f])
        .find((v) => typeof v === 'string' && v.length > 0) as string | undefined;

      let recordMatches = true;
      for (const [field, expectedValue] of Object.entries(expected)) {
        const actualValue = rec[field];
        if (!deepEqual(expectedValue, actualValue)) {
          mismatches.push({
            key,
            display,
            field,
            expected: expectedValue,
            actual: actualValue,
          });
          recordMatches = false;
        }
      }
      if (recordMatches) {
        matchedCount++;
      }
    }

    const ok = mismatches.length === 0;
    const lines: string[] = [];
    lines.push(`VERIFY FIELDS VALUE — ${ok ? 'OK' : 'MISMATCH FOUND'}`);
    lines.push(`Collection: ${args.collection}`);
    lines.push(`Expected: ${JSON.stringify(expected)}`);
    lines.push(`Records checked: ${records.length}`);
    lines.push(`Matched: ${matchedCount}`);
    lines.push(`Mismatches: ${mismatches.length}`);
    if (!ok) {
      lines.push('');
      lines.push('Mismatched records (need re-processing):');
      for (const m of mismatches.slice(0, 50)) {
        lines.push(`  [${m.key}]${m.display ? ` ${m.display}` : ''} field=${m.field} expected=${JSON.stringify(m.expected).slice(0, 80)} actual=${JSON.stringify(m.actual).slice(0, 80)}`);
      }
      if (mismatches.length > 50) {
        lines.push(`  ... and ${mismatches.length - 50} more`);
      }
    }
    lines.push('');
    lines.push('NEXT ACTION:');
    if (ok) {
      lines.push('- All records match expected values.');
      lines.push('- You can report success to the user.');
    } else {
      lines.push('- Some records do not match expected values.');
      lines.push('- Re-run dry-run + apply for the mismatched records.');
      lines.push('- Do not report full success.');
    }

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
      structuredContent: {
        ok,
        collection: args.collection,
        expected,
        totalChecked: records.length,
        matchedCount,
        mismatchCount: mismatches.length,
        mismatches,
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
 * Deep equality check. Handles primitives, arrays, objects.
 * Case-sensitive for strings. `["TEST"] !== ["test"]`.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as Record<string, unknown>).sort();
    const bKeys = Object.keys(b as Record<string, unknown>).sort();
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k, i) => k === bKeys[i] && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}
