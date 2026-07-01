import type { AppConfig } from '../config.js';
import type { CollectionSchema, FieldSchema } from '../directus/schema.js';
import { McpUserError } from '../directus/errors.js';

/**
 * Whitelist of Directus filter operators allowed by the sidecar.
 * Anything outside this list is rejected with INVALID_FILTER_OPERATOR.
 *
 * (See Directus filter rules documentation, section 1.4 of the spec.)
 */
export const ALLOWED_FILTER_OPERATORS = new Set<string>([
  '_eq',
  '_neq',
  '_in',
  '_nin',
  '_null',
  '_nnull',
  '_lt',
  '_lte',
  '_gt',
  '_gte',
  '_between',
  '_contains',
  '_icontains',
  '_starts_with',
  '_ends_with',
  '_empty',
  '_nempty',
  '_some',
  '_none',
  '_and',
  '_or',
]);

const KNOWN_QUERY_KEYS = new Set<string>([
  'fields',
  'filter',
  'search',
  'sort',
  'limit',
  'offset',
  'page',
  'aggregate',
  'groupBy',
  'deep',
  'alias',
  'export',
  'version',
  'functions',
  'backlink',
]);

export interface NormalizedQuery {
  query: Record<string, unknown>;
  warnings: string[];
}

/**
 * Validation mode:
 *   - `list`   — for `GET /items/{collection}`. Applies default `limit`,
 *                clamps to READ_MAX_LIMIT, applies safe default fields.
 *   - `single` — for `GET /items/{collection}/{key}`. Single-record reads
 *                do NOT take `limit` / `page` / `offset`; if the caller
 *                sends them, we REJECT (cleaner than silently ignoring —
 *                surfaces LLM mistakes). `fields` / `deep` / `version`
 *                are still supported.
 */
export type ReadQueryMode = 'list' | 'single';

/**
 * Validate and normalise a Directus read query.
 *
 * - Apply default `limit` if missing (list mode only); clamp to `READ_MAX_LIMIT`.
 * - Apply safe default `fields` (PK + first 10 scalar fields) when missing.
 * - Reject `*` (and `**`) wildcards unless `ALLOW_WILDCARD_FIELDS=true`.
 * - Reject unknown filter operators.
 * - Reject unknown top-level query keys (typo protection).
 * - Validate that first segment of dotted field paths exists in schema.
 * - In `single` mode: REJECT `limit` / `page` / `offset` (they are
 *   meaningless for single-record reads and indicate LLM confusion).
 */
export function normalizeAndValidateReadQuery(
  config: AppConfig,
  schema: CollectionSchema,
  rawQuery: Record<string, unknown> | undefined,
  mode: ReadQueryMode = 'list',
): NormalizedQuery {
  const warnings: string[] = [];
  const query: Record<string, unknown> = rawQuery ? { ...rawQuery } : {};

  // In single mode, reject pagination params early — they don't apply
  // to /items/{collection}/{key} and their presence means the LLM is
  // confused about which endpoint it's calling.
  if (mode === 'single') {
    for (const forbidden of ['limit', 'page', 'offset']) {
      if (query[forbidden] !== undefined) {
        throw new McpUserError(
          'INVALID_QUERY',
          `Query parameter '${forbidden}' is not allowed in single-item read mode (it applies to list reads only)`,
          { mode, param: forbidden },
        );
      }
    }
  }

  // ---- unknown top-level keys ----
  for (const key of Object.keys(query)) {
    if (!KNOWN_QUERY_KEYS.has(key)) {
      throw new McpUserError(
        'INVALID_QUERY',
        `Unknown query parameter '${key}'`,
        { key, allowed: Array.from(KNOWN_QUERY_KEYS) },
      );
    }
  }

  // ---- fields ----
  if (query.fields === undefined) {
    const safe = safeDefaultFields(schema);
    query.fields = safe;
    warnings.push(`fields not set; using safe default: ${JSON.stringify(safe)}`);
  } else {
    const fieldsArr = arrayFromQuery(query.fields);
    if (fieldsArr.length === 0) {
      const safe = safeDefaultFields(schema);
      query.fields = safe;
      warnings.push(`fields empty; using safe default: ${JSON.stringify(safe)}`);
    } else {
      for (const f of fieldsArr) {
        if (typeof f !== 'string') {
          throw new McpUserError('INVALID_QUERY', `field entry must be a string, got ${typeof f}`, { field: f });
        }
        if ((f === '*' || f === '**' || f.includes('.*')) && !config.allowWildcardFields) {
          throw new McpUserError(
            'INVALID_QUERY',
            `Wildcard fields are not allowed (field '${f}'). Set ALLOW_WILDCARD_FIELDS=true to permit.`,
            { field: f },
          );
        }
        // first segment must exist in schema (unless wildcard)
        const firstSegment: string = f.split('.', 1)[0] ?? '';
        if (!firstSegment) {
          throw new McpUserError('INVALID_QUERY', `Invalid field entry '${f}'`, { field: f });
        }
        if (firstSegment !== '*' && !schema.fields[firstSegment]) {
          throw new McpUserError(
            'UNKNOWN_FIELD',
            `Field '${firstSegment}' does not exist in collection '${schema.collection}'`,
            { collection: schema.collection, field: firstSegment },
          );
        }
      }
    }
  }

  // ---- limit (list mode only; single mode rejects earlier) ----
  if (mode === 'list') {
    if (query.limit === undefined) {
      query.limit = config.readDefaultLimit;
      warnings.push(`limit not set; using default ${config.readDefaultLimit}`);
    } else {
      let n = Number(query.limit);
      if (!Number.isFinite(n) || n < 0) {
        throw new McpUserError('INVALID_QUERY', `limit must be a non-negative number, got ${JSON.stringify(query.limit)}`, {
          limit: query.limit,
        });
      }
      n = Math.floor(n);
      if (n > config.readMaxLimit) {
        warnings.push(`limit ${n} exceeds READ_MAX_LIMIT ${config.readMaxLimit}; clamped`);
        n = config.readMaxLimit;
      }
      query.limit = n;
    }

    // ---- offset / page (list mode only) ----
    if (query.offset !== undefined) {
      const n = Number(query.offset);
      if (!Number.isFinite(n) || n < 0) {
        throw new McpUserError('INVALID_QUERY', `offset must be a non-negative number`, { offset: query.offset });
      }
      query.offset = Math.floor(n);
    }
    if (query.page !== undefined) {
      const n = Number(query.page);
      if (!Number.isFinite(n) || n < 1) {
        throw new McpUserError('INVALID_QUERY', `page must be a positive integer`, { page: query.page });
      }
      query.page = Math.floor(n);
    }
  }

  // ---- sort ----
  if (query.sort !== undefined) {
    const sorts = arrayFromQuery(query.sort);
    for (const s of sorts) {
      if (typeof s !== 'string') {
        throw new McpUserError('INVALID_QUERY', `sort entry must be a string`, { sort: s });
      }
      const field = s.startsWith('-') ? s.slice(1) : s;
      if (!schema.fields[field]) {
        throw new McpUserError('UNKNOWN_FIELD', `sort field '${field}' does not exist in '${schema.collection}'`, {
          collection: schema.collection,
          field,
        });
      }
    }
  }

  // ---- filter ----
  if (query.filter !== undefined) {
    validateFilter(query.filter, schema, '<root>');
  }

  // ---- deep ----
  if (query.deep !== undefined) {
    if (!isPlainObject(query.deep)) {
      throw new McpUserError('INVALID_QUERY', `deep must be an object`, { deep: query.deep });
    }
    for (const [relField] of Object.entries(query.deep as Record<string, unknown>)) {
      if (!schema.fields[relField]) {
        throw new McpUserError('UNKNOWN_FIELD', `deep references unknown relation field '${relField}'`, {
          collection: schema.collection,
          field: relField,
        });
      }
    }
  }

  return { query, warnings };
}

function arrayFromQuery(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null) return [];
  return [v];
}

function safeDefaultFields(schema: CollectionSchema): string[] {
  const out: string[] = [];
  if (schema.primaryKey) out.push(schema.primaryKey);
  let count = 0;
  for (const f of Object.values(schema.fields)) {
    if (count >= 10) break;
    if (f.isPrimaryKey) continue;
    if (isScalarField(f)) {
      out.push(f.field);
      count++;
    }
  }
  return out;
}

function isScalarField(f: FieldSchema): boolean {
  const scalarTypes = new Set([
    'string',
    'text',
    'integer',
    'bigInteger',
    'float',
    'decimal',
    'boolean',
    'date',
    'dateTime',
    'timestamp',
    'time',
    'uuid',
    'json',
    'hash',
  ]);
  return scalarTypes.has(f.type);
}

/**
 * Recursively validate a Directus filter expression.
 * Throws INVALID_FILTER_OPERATOR on unknown operators.
 */
function validateFilter(filter: unknown, schema: CollectionSchema, path: string): void {
  if (filter === null || typeof filter !== 'object') return;
  if (Array.isArray(filter)) {
    for (const f of filter) validateFilter(f, schema, path);
    return;
  }
  for (const [k, v] of Object.entries(filter as Record<string, unknown>)) {
    if (k === '_and' || k === '_or') {
      validateFilter(v, schema, `${path}.${k}`);
      continue;
    }
    if (k.startsWith('_')) {
      if (!ALLOWED_FILTER_OPERATORS.has(k)) {
        throw new McpUserError(
          'INVALID_FILTER_OPERATOR',
          `Filter operator '${k}' is not allowed (at ${path})`,
          { operator: k, path },
        );
      }
      continue;
    }
    // field name — validate nested filter
    validateFilter(v, schema, `${path}.${k}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}
