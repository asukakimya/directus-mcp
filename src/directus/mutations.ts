import type { DirectusRestClient } from './rest.js';
import type { CollectionSchema } from './schema.js';
import { McpUserError } from './errors.js';
import {
  createItem as restCreateItem,
  deleteItem as restDeleteItem,
  deleteItems as restDeleteItems,
  readItem as restReadItem,
  readItems as restReadItems,
  updateItem as restUpdateItem,
  updateItemsSameData as restUpdateItemsSameData,
} from './client.js';
import { normalizeAndValidateReadQuery } from './query.js';
import { validateFields } from './validators.js';
import type { AppConfig } from '../config.js';
import { computeDiff, type MutationDiff } from '../safety/diff.js';
import { assertVerify } from '../safety/verify.js';
import { isPlainObject } from '../safety/normalize.js';

/* ----------------------------------------------------------------
 * Read operations
 * ---------------------------------------------------------------- */

export async function readItemsWithGuards(
  client: DirectusRestClient,
  config: AppConfig,
  schema: CollectionSchema,
  query: Record<string, unknown> | undefined,
): Promise<{
  data: unknown;
  query: Record<string, unknown>;
  warnings: string[];
  records: unknown[];
  directusMeta?: Record<string, unknown>;
  returnedRecords: number;
  totalAvailable: number | null;
}> {
  const { query: normalized, warnings } = normalizeAndValidateReadQuery(config, schema, query);
  const result = await restReadItems(client, schema.collection, normalized);
  const records = extractDataArray(result);
  const directusMeta = extractMeta(result);
  const totalAvailable = extractTotalCount(directusMeta, records.length, normalized);
  return {
    data: result,
    query: normalized,
    warnings,
    records,
    directusMeta,
    returnedRecords: records.length,
    totalAvailable,
  };
}

export async function readItemWithGuards(
  client: DirectusRestClient,
  config: AppConfig,
  schema: CollectionSchema,
  key: string | number,
  query: Record<string, unknown> | undefined,
): Promise<{ data: unknown; query: Record<string, unknown>; warnings: string[] }> {
  // Single-item read: 'single' mode rejects limit/page/offset.
  const { query: normalized, warnings } = normalizeAndValidateReadQuery(
    config,
    schema,
    query,
    'single',
  );
  const result = await restReadItem(client, schema.collection, key, normalized);
  return { data: result, query: normalized, warnings };
}

/* ----------------------------------------------------------------
 * Create
 * ---------------------------------------------------------------- */

export interface CreateItemResult {
  action: 'create';
  collection: string;
  dryRun: boolean;
  dedupeFilter?: Record<string, unknown>;
  created: unknown | null;
}

export async function createItemWithGuards(
  client: DirectusRestClient,
  config: AppConfig,
  schema: CollectionSchema,
  data: Record<string, unknown>,
  options: { dryRun?: boolean; dedupe?: Record<string, unknown> },
): Promise<CreateItemResult> {
  const dryRun = options.dryRun ?? config.mutationDryRunDefault;

  validateFields(schema, data, { mode: 'create', collection: schema.collection });

  // dedupe: if a record already matches the dedupe filter, refuse to create.
  if (options.dedupe && Object.keys(options.dedupe).length > 0) {
    const dedupeFilter = buildDedupeFilter(options.dedupe);
    const existing = await restReadItems(client, schema.collection, {
      filter: dedupeFilter,
      limit: 2,
      fields: [schema.primaryKey ?? 'id'],
    });
    const arr = extractDataArray(existing);
    if (arr.length > 0) {
      throw new McpUserError(
        'DUPLICATE_FOUND',
        `A record matching dedupe filter already exists in '${schema.collection}'`,
        { collection: schema.collection, dedupe: options.dedupe, matches: arr },
      );
    }
  }

  if (dryRun) {
    return {
      action: 'create',
      collection: schema.collection,
      dryRun: true,
      dedupeFilter: options.dedupe ? buildDedupeFilter(options.dedupe) : undefined,
      created: null,
    };
  }

  const created = await restCreateItem(client, schema.collection, data);
  return {
    action: 'create',
    collection: schema.collection,
    dryRun: false,
    dedupeFilter: options.dedupe ? buildDedupeFilter(options.dedupe) : undefined,
    created,
  };
}

export async function createItemsWithGuards(
  client: DirectusRestClient,
  config: AppConfig,
  schema: CollectionSchema,
  items: Array<{ data: Record<string, unknown>; dedupe?: Record<string, unknown> }>,
  options: { dryRun?: boolean; allowPartialApply?: boolean },
): Promise<{
  results: Array<
    | CreateItemResult
    | { error: { code: string; message: string; details: unknown } }
  >;
  summary: {
    total: number;
    ok: number;
    failed: number;
    dryRun: boolean;
    aborted: boolean;
    abortReason?: string;
  };
}> {
  const dryRun = options.dryRun ?? config.mutationDryRunDefault;
  // Default: all-or-nothing apply. When false, every create must pass
  // validation + dedupe preflight BEFORE any item is written.
  const allowPartialApply = options.allowPartialApply ?? false;

  const results: Array<
    | CreateItemResult
    | { error: { code: string; message: string; details: unknown } }
  > = [];

  // Preflight: when applying (dryRun=false) AND allowPartialApply=false,
  // run every create as dry-run first. If any item fails validation or
  // dedupe, abort the entire batch with `aborted: true` and return
  // per-item preflight errors. No writes happen.
  if (!dryRun && !allowPartialApply && items.length > 0) {
    const preflight: Array<
      | { error: { code: string; message: string; details: unknown } }
      | null
    > = [];
    let firstError: { error: { code: string; message: string; details: unknown } } | null = null;

    for (const item of items) {
      try {
        await createItemWithGuards(client, config, schema, item.data, {
          dryRun: true, // dry-run preflight
          dedupe: item.dedupe,
        });
        preflight.push(null);
      } catch (err) {
        const e = { error: errorToJson(err) };
        preflight.push(e);
        if (!firstError) firstError = e;
      }
    }

    if (firstError) {
      for (let i = 0; i < items.length; i++) {
        const pf = preflight[i];
        if (pf) {
          results.push(pf);
        } else {
          results.push({
            error: {
              code: 'ABORTED_BY_PREFLIGHT',
              message: 'item not created because another item in the batch failed preflight (all-or-nothing mode)',
              details: { firstErrorCode: firstError.error.code },
            },
          });
        }
      }
      return {
        results,
        summary: {
          total: items.length,
          ok: 0,
          failed: items.length,
          dryRun: false,
          aborted: true,
          abortReason: `preflight failed: ${firstError.error.code} — ${firstError.error.message}`,
        },
      };
    }
    // Preflight clean — proceed to actual creates below.
  }

  for (const item of items) {
    try {
      const r = await createItemWithGuards(client, config, schema, item.data, {
        dryRun,
        dedupe: item.dedupe,
      });
      results.push(r);
    } catch (err) {
      results.push({ error: errorToJson(err) });
    }
  }

  const ok = results.filter((r) => !('error' in r)).length;
  const failed = results.length - ok;
  return {
    results,
    summary: { total: items.length, ok, failed, dryRun, aborted: false },
  };
}

/* ----------------------------------------------------------------
 * Update
 * ---------------------------------------------------------------- */

export interface UpdateItemResult {
  action: 'update';
  collection: string;
  key: string | number;
  dryRun: boolean;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  diff: MutationDiff;
  written: boolean;
  verifyPassed: boolean;
}

export async function updateItemWithGuards(
  client: DirectusRestClient,
  config: AppConfig,
  schema: CollectionSchema,
  key: string | number,
  data: Record<string, unknown>,
  options: { dryRun?: boolean; verify?: Record<string, unknown> },
): Promise<UpdateItemResult> {
  const dryRun = options.dryRun ?? config.mutationDryRunDefault;

  if (!isPlainObject(data) || Object.keys(data).length === 0) {
    throw new McpUserError('INVALID_DATA_TYPE', 'update data must be a non-empty object', {
      collection: schema.collection,
      key,
    });
  }

  // When MUTATION_REQUIRE_VERIFY=true, every update must carry a non-empty
  // `verify` object so we can confirm the LLM is operating on fresh data.
  // This prevents "lost update" scenarios where the LLM writes against a
  // stale read.
  if (config.mutationRequireVerify) {
    if (!options.verify || Object.keys(options.verify).length === 0) {
      throw new McpUserError(
        'VERIFY_REQUIRED',
        `verify is required for update because MUTATION_REQUIRE_VERIFY=true (collection '${schema.collection}', key ${key})`,
        { collection: schema.collection, key },
      );
    }
  }

  validateFields(schema, data, { mode: 'update', collection: schema.collection });

  // 1) read before
  const beforeRaw = await restReadItem(client, schema.collection, key, { fields: ['*'] });
  const before = extractItem(beforeRaw);
  if (!before) {
    throw new McpUserError('NOT_FOUND', `Item ${key} not found in '${schema.collection}'`, {
      collection: schema.collection,
      key,
    });
  }

  // 2) verify
  let verifyPassed = true;
  if (options.verify && Object.keys(options.verify).length > 0) {
    assertVerify(config, before, options.verify, { collection: schema.collection, key });
  }

  // 3) diff
  const diff = computeDiff(before, data);

  if (dryRun) {
    return {
      action: 'update',
      collection: schema.collection,
      key,
      dryRun: true,
      before,
      after: { ...before, ...data },
      diff,
      written: false,
      verifyPassed,
    };
  }

  // 4) write
  const written = await restUpdateItem(client, schema.collection, key, data);

  // 5) after-read verify
  const afterRaw = await restReadItem(client, schema.collection, key, { fields: ['*'] });
  const after = extractItem(afterRaw) ?? (written as Record<string, unknown>);

  return {
    action: 'update',
    collection: schema.collection,
    key,
    dryRun: false,
    before,
    after,
    diff,
    written: true,
    verifyPassed,
  };
}

export async function updateItemsSameDataWithGuards(
  client: DirectusRestClient,
  config: AppConfig,
  schema: CollectionSchema,
  keys: Array<string | number>,
  data: Record<string, unknown>,
  options: { dryRun?: boolean },
): Promise<{
  before: Array<Record<string, unknown> | null>;
  after: unknown;
  diff: Record<string, MutationDiff>;
  dryRun: boolean;
  written: boolean;
}> {
  const dryRun = options.dryRun ?? config.mutationDryRunDefault;

  if (!isPlainObject(data) || Object.keys(data).length === 0) {
    throw new McpUserError('INVALID_DATA_TYPE', 'update data must be a non-empty object', {
      collection: schema.collection,
    });
  }

  // `update_items_same_data` does NOT accept a per-key `verify` payload.
  // When MUTATION_REQUIRE_VERIFY=true we refuse to run it — caller should
  // switch to `directus_batch_update_items` with per-key verify, or
  // explicitly disable require-verify for this call (not supported in v1
  // for safety reasons).
  if (config.mutationRequireVerify) {
    throw new McpUserError(
      'VERIFY_REQUIRED',
      `directus_update_items_same_data cannot be used when MUTATION_REQUIRE_VERIFY=true because it does not accept per-key verify. Use directus_batch_update_items with per-item verify instead.`,
      { collection: schema.collection, keys },
    );
  }

  validateFields(schema, data, { mode: 'update', collection: schema.collection });

  // read all before
  const pkField = schema.primaryKey ?? 'id';
  const beforeRaw = await restReadItems(client, schema.collection, {
    filter: { [pkField]: { _in: keys } },
    limit: keys.length,
    fields: ['*'],
  });
  const before = extractDataArray(beforeRaw).map((r) => (isPlainObject(r) ? r : null));

  if (before.length !== keys.length) {
    // some keys missing
    const foundIds = new Set(before.filter(Boolean).map((r) => String((r as Record<string, unknown>)[pkField])));
    const missing = keys.filter((k) => !foundIds.has(String(k)));
    throw new McpUserError('NOT_FOUND', `Some keys not found in '${schema.collection}'`, {
      collection: schema.collection,
      missing,
    });
  }

  const diff: Record<string, MutationDiff> = {};
  for (const b of before) {
    if (!b) continue;
    const k = String(b[pkField]);
    diff[k] = computeDiff(b, data);
  }

  if (dryRun) {
    return {
      before,
      after: null,
      diff,
      dryRun: true,
      written: false,
    };
  }

  const after = await restUpdateItemsSameData(client, schema.collection, keys, data);
  return {
    before,
    after,
    diff,
    dryRun: false,
    written: true,
  };
}

export async function batchUpdateItemsWithGuards(
  client: DirectusRestClient,
  config: AppConfig,
  schema: CollectionSchema,
  items: Array<{
    key: string | number;
    data: Record<string, unknown>;
    verify?: Record<string, unknown>;
  }>,
  options: { dryRun?: boolean; failFast?: boolean; allowPartialApply?: boolean },
): Promise<{
  results: Array<
    | UpdateItemResult
    | { key: string | number; error: { code: string; message: string; details: unknown } }
  >;
  summary: {
    total: number;
    ok: number;
    failed: number;
    dryRun: boolean;
    aborted: boolean;
    abortReason?: string;
  };
}> {
  const dryRun = options.dryRun ?? config.mutationDryRunDefault;
  const failFast = options.failFast ?? false;
  // Default: all-or-nothing apply. When false, the batch must pass a
  // preflight (every item's update would succeed as dry-run) BEFORE
  // any write happens. This prevents partial writes when an LLM sends
  // a batch where some items fail verify / validation mid-way through.
  const allowPartialApply = options.allowPartialApply ?? false;

  const results: Array<
    | UpdateItemResult
    | { key: string | number; error: { code: string; message: string; details: unknown } }
  > = [];

  // Preflight: when applying (dryRun=false) AND allowPartialApply=false,
  // run every item as dry-run first. If any item fails, abort the entire
  // batch with `aborted: true` and return per-item preflight errors.
  // No writes happen.
  if (!dryRun && !allowPartialApply && items.length > 0) {
    const preflight: Array<{
      key: string | number;
      error: { code: string; message: string; details: unknown } } | null
    > = [];
    let firstError: { key: string | number; error: { code: string; message: string; details: unknown } } | null = null;

    for (const item of items) {
      try {
        await updateItemWithGuards(client, config, schema, item.key, item.data, {
          dryRun: true, // dry-run preflight
          verify: item.verify,
        });
        preflight.push(null);
      } catch (err) {
        const e = { key: item.key, error: errorToJson(err) };
        preflight.push(e);
        if (!firstError) firstError = e;
      }
    }

    if (firstError) {
      // Build per-item results reflecting the preflight outcome.
      for (let i = 0; i < items.length; i++) {
        const pf = preflight[i];
        if (pf) {
          results.push(pf);
        } else {
          // This item would have succeeded but was not written because
          // of all-or-nothing semantics.
          results.push({
            key: items[i]!.key,
            error: {
              code: 'ABORTED_BY_PREFLIGHT',
              message: 'item not written because another item in the batch failed preflight (all-or-nothing mode)',
              details: { firstErrorKey: firstError.key, firstErrorCode: firstError.error.code },
            },
          });
        }
      }
      return {
        results,
        summary: {
          total: items.length,
          ok: 0,
          failed: items.length,
          dryRun: false,
          aborted: true,
          abortReason: `preflight failed at key ${firstError.key}: ${firstError.error.code} — ${firstError.error.message}`,
        },
      };
    }
    // Preflight clean — proceed to actual writes below.
  }

  for (const item of items) {
    try {
      const r = await updateItemWithGuards(client, config, schema, item.key, item.data, {
        dryRun,
        verify: item.verify,
      });
      results.push(r);
    } catch (err) {
      results.push({ key: item.key, error: errorToJson(err) });
      if (failFast) break;
    }
  }

  const ok = results.filter((r) => !('error' in r)).length;
  const failed = results.length - ok;
  return {
    results,
    summary: { total: items.length, ok, failed, dryRun, aborted: false },
  };
}

/* ----------------------------------------------------------------
 * Delete
 * ---------------------------------------------------------------- */

export interface DeleteItemResult {
  action: 'delete';
  collection: string;
  keys: Array<string | number>;
  dryRun: boolean;
  before: Array<Record<string, unknown> | null>;
  deleted: boolean;
}

export async function deleteItemsWithGuards(
  client: DirectusRestClient,
  config: AppConfig,
  schema: CollectionSchema,
  keys: Array<string | number>,
  options: {
    dryRun?: boolean;
    verify?: Array<{ key: string | number; [field: string]: unknown }>;
    confirm?: string;
  },
): Promise<DeleteItemResult> {
  if (!config.allowDelete) {
    throw new McpUserError(
      'DELETE_DISABLED',
      `Delete is disabled on this MCP instance (collection '${schema.collection}')`,
      { collection: schema.collection },
    );
  }
  const expectedConfirm = `DELETE ${schema.collection}:${keys.join(',')}`;
  if (options.confirm !== expectedConfirm) {
    throw new McpUserError(
      'CONFIRMATION_REQUIRED',
      `Delete requires confirm='${expectedConfirm}'`,
      { collection: schema.collection, keys, expected: expectedConfirm },
    );
  }

  const dryRun = options.dryRun ?? config.mutationDryRunDefault;

  // read before
  const pkField = schema.primaryKey ?? 'id';
  const beforeRaw = await restReadItems(client, schema.collection, {
    filter: { [pkField]: { _in: keys } },
    limit: keys.length,
    fields: ['*'],
  });
  const before = extractDataArray(beforeRaw).map((r) => (isPlainObject(r) ? r : null));

  if (before.length !== keys.length) {
    const foundIds = new Set(before.filter(Boolean).map((r) => String((r as Record<string, unknown>)[pkField])));
    const missing = keys.filter((k) => !foundIds.has(String(k)));
    throw new McpUserError('NOT_FOUND', `Some keys not found for delete in '${schema.collection}'`, {
      collection: schema.collection,
      missing,
    });
  }

  // verify
  if (options.verify && options.verify.length > 0) {
    for (const v of options.verify) {
      const k = v.key;
      const record = before.find((b) => b && String(b[pkField]) === String(k));
      if (!record) {
        throw new McpUserError('NOT_FOUND', `Verify: item ${k} not found in '${schema.collection}'`, {
          collection: schema.collection,
          key: k,
        });
      }
      const { key: _k, ...rest } = v;
      assertVerify(config, record, rest as Record<string, unknown>, { collection: schema.collection, key: k });
    }
  }

  if (dryRun) {
    return {
      action: 'delete',
      collection: schema.collection,
      keys,
      dryRun: true,
      before,
      deleted: false,
    };
  }

  if (keys.length === 1) {
    await restDeleteItem(client, schema.collection, keys[0]!);
  } else {
    await restDeleteItems(client, schema.collection, keys);
  }

  return {
    action: 'delete',
    collection: schema.collection,
    keys,
    dryRun: false,
    before,
    deleted: true,
  };
}

/* ----------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------- */

function buildDedupeFilter(dedupe: Record<string, unknown>): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(dedupe)) {
    filter[k] = { _eq: v };
  }
  return filter;
}

function extractDataArray(response: unknown): Record<string, unknown>[] {
  if (Array.isArray(response)) return response.filter(isPlainObject);
  if (response && typeof response === 'object') {
    const r = response as { data?: unknown };
    if (Array.isArray(r.data)) return r.data.filter(isPlainObject);
  }
  return [];
}

function extractItem(response: unknown): Record<string, unknown> | null {
  if (isPlainObject(response)) {
    // If response has a `data` key, return it (null if data is null/undefined).
    if ('data' in response) {
      const data = (response as Record<string, unknown>).data;
      if (isPlainObject(data)) return data;
      return null;
    }
    // No `data` key — treat the response itself as the record.
    return response;
  }
  return null;
}

function extractMeta(response: unknown): Record<string, unknown> | undefined {
  if (isPlainObject(response) && 'meta' in response) {
    const meta = (response as Record<string, unknown>).meta;
    if (isPlainObject(meta)) return meta as Record<string, unknown>;
  }
  return undefined;
}

function extractTotalCount(
  meta: Record<string, unknown> | undefined,
  recordCount: number,
  query: Record<string, unknown>,
): number | null {
  // Directus meta may have total_count or filter_count.
  if (meta) {
    if (typeof meta.total_count === 'number') return meta.total_count;
    if (typeof meta.filter_count === 'number') return meta.filter_count;
  }
  // If no meta, estimate from record count vs limit.
  const limit = typeof query.limit === 'number' ? query.limit : undefined;
  if (limit !== undefined && recordCount < limit) {
    return recordCount;
  }
  return null;
}

function errorToJson(err: unknown): { code: string; message: string; details: unknown } {
  if (err instanceof McpUserError) {
    return { code: err.errorCode, message: err.message, details: err.details };
  }
  if (err instanceof Error) {
    return { code: 'DIRECTUS_API_ERROR', message: err.message, details: {} };
  }
  return { code: 'DIRECTUS_API_ERROR', message: String(err), details: {} };
}

/* ----------------------------------------------------------------
 * Read-back verification helpers (used by directus_apply_plan)
 * ---------------------------------------------------------------- */

/**
 * Auto-generate a verify object from a record by extracting the specified
 * verify_fields. This is used when the caller passes `verify_fields`
 * instead of an explicit `verify` object — the MCP reads the current
 * record and builds the verify object server-side, preventing the model
 * from guessing wrong verify values.
 *
 * Returns null if the record is null (not found).
 */
export function buildVerifyFromRecord(
  record: Record<string, unknown> | null,
  verifyFields: string[],
): Record<string, unknown> | null {
  if (!record) return null;
  const verify: Record<string, unknown> = {};
  for (const field of verifyFields) {
    if (field in record) {
      verify[field] = record[field];
    }
  }
  return verify;
}

/**
 * Read a record and auto-generate a verify object from verify_fields.
 * Used by update_item / batch_update_items / update_by_query_plan when
 * the caller passes `verify_fields` instead of `verify`.
 */
export async function autoGenerateVerify(
  client: DirectusRestClient,
  schema: CollectionSchema,
  key: string | number,
  verifyFields: string[],
): Promise<Record<string, unknown>> {
  // Validate verify fields exist in schema before reading.
  for (const field of verifyFields) {
    if (!schema.fields[field]) {
      throw new McpUserError('UNKNOWN_FIELD', `Unknown verify field '${field}' for collection '${schema.collection}'`, {
        collection: schema.collection,
        field,
      });
    }
  }

  // Read only PK + verify fields — no wildcard, no unnecessary long fields.
  const pk = schema.primaryKey ?? 'id';
  const readFields = Array.from(new Set([pk, ...verifyFields]));
  const raw = await restReadItem(client, schema.collection, key, { fields: readFields });
  const record = extractItem(raw);
  if (!record) {
    throw new McpUserError('NOT_FOUND', `Cannot auto-generate verify: item ${key} not found in '${schema.collection}'`, {
      collection: schema.collection,
      key,
    });
  }
  const verify = buildVerifyFromRecord(record, verifyFields);
  if (!verify || Object.keys(verify).length === 0) {
    throw new McpUserError('INVALID_QUERY', `Cannot auto-generate verify: none of verify_fields ${JSON.stringify(verifyFields)} exist in record ${key}`, {
      collection: schema.collection,
      key,
      verifyFields,
    });
  }
  return verify;
}

/**
 * After an update, re-read the record and verify that each changed
 * field now contains the value we intended to write.
 * Returns `true` if all changed fields match, `false` on mismatch.
 */
export async function readBackVerify(
  client: DirectusRestClient,
  schema: CollectionSchema,
  key: string | number,
  intendedData: Record<string, unknown>,
): Promise<{ ok: boolean; mismatches: Array<{ field: string; expected: unknown; actual: unknown }> }> {
  const raw = await restReadItem(client, schema.collection, key, { fields: ['*'] });
  const record = extractItem(raw);
  if (!record) {
    return { ok: false, mismatches: [{ field: '__record__', expected: 'exists', actual: 'null' }] };
  }
  const mismatches: Array<{ field: string; expected: unknown; actual: unknown }> = [];
  for (const [field, expected] of Object.entries(intendedData)) {
    const actual = record[field];
    if (!deepEqualSimple(expected, actual)) {
      mismatches.push({ field, expected, actual });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * After a delete, try to read — expect not found.
 */
export async function readBackDelete(
  client: DirectusRestClient,
  collection: string,
  key: string | number,
): Promise<boolean> {
  try {
    const raw = await restReadItem(client, collection, key, { fields: ['*'] });
    const record = extractItem(raw);
    // If we got data back, delete failed.
    return record === null;
  } catch {
    // 404 or error = record is gone = delete succeeded
    return true;
  }
}

function deepEqualSimple(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqualSimple(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as Record<string, unknown>).sort();
    const bKeys = Object.keys(b as Record<string, unknown>).sort();
    return aKeys.length === bKeys.length && aKeys.every((k, i) => k === bKeys[i] && deepEqualSimple((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}
