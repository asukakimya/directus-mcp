/**
 * Compact text formatters for MCP `content.text` payloads.
 *
 * WHY: LibreChat (and some other MCP clients) surface `content.text` to the
 * LLM but do NOT reliably surface `structuredContent`. If `content.text` is
 * just a short label like "Read items from products.", the LLM cannot see
 * the actual data and has to guess. These formatters put the real result —
 * compact, token-bounded — into `content.text` so the LLM can reason about
 * it without depending on structuredContent surfacing.
 *
 * Each formatter accepts a `limits` object so the same code path can be
 * unit-tested with small limits.
 */

export interface TextLimits {
  schemaTextMaxFields: number;
  readTextMaxRows: number;
  readTextMaxChars: number;
}

/**
 * Truncate a string to `maxChars`, appending a clear truncation marker
 * if it was cut. Always leaves room for the marker.
 */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = `\n…[truncated, ${text.length - maxChars + 20} more chars]`;
  return text.slice(0, Math.max(0, maxChars - marker.length)) + marker;
}

/* ----------------------------------------------------------------
 * Schema
 * ---------------------------------------------------------------- */

export interface FieldTextInfo {
  field: string;
  type: string;
  readonly: boolean;
  required: boolean;
  isPrimaryKey: boolean;
  hasRelation: boolean;
  defaultValue?: unknown;
  interface?: string | null;
  special?: string[] | null;
}

export interface RelationTextInfo {
  field: string;
  type: string;
  relatedCollection?: string;
  junctionCollection?: string;
}

export interface CollectionTextInfo {
  collection: string;
  singleton: boolean;
  primaryKey: string | null;
  fields: FieldTextInfo[];
  relations: RelationTextInfo[];
}

export function formatSchemaDetailText(
  collections: CollectionTextInfo[],
  limits: TextLimits,
): string {
  const parts: string[] = [];
  for (const c of collections) {
    parts.push(`Collection: ${c.collection}`);
    parts.push(`Primary key: ${c.primaryKey ?? '(unknown)'}`);
    parts.push(`Singleton: ${c.singleton ? 'yes' : 'no'}`);

    parts.push('Fields:');
    const fieldLines = c.fields.slice(0, limits.schemaTextMaxFields).map((f) => {
      const tags: string[] = [f.type];
      if (f.isPrimaryKey) tags.push('primary');
      if (f.readonly) tags.push('readonly');
      if (f.required) tags.push('required');
      if (f.hasRelation) tags.push('relation');
      if (f.interface) tags.push(`iface:${f.interface}`);
      if (f.special && f.special.length > 0) tags.push(`special:${f.special.join('+')}`);
      if (f.defaultValue !== undefined && f.defaultValue !== null) {
        tags.push(`default:${JSON.stringify(f.defaultValue)}`);
      }
      return `- ${f.field}: ${tags.join(' ')}`;
    });
    if (c.fields.length > limits.schemaTextMaxFields) {
      fieldLines.push(
        `…[+${c.fields.length - limits.schemaTextMaxFields} more fields truncated]`,
      );
    }
    parts.push(fieldLines.join('\n'));

    if (c.relations.length > 0) {
      parts.push('Relations:');
      const relLines = c.relations.map((r) => {
        const target = r.relatedCollection ?? r.junctionCollection ?? '?';
        return `- ${r.field} (${r.type}) -> ${target}`;
      });
      parts.push(relLines.join('\n'));
    }
    parts.push(''); // blank line between collections
  }
  return truncateText(parts.join('\n').trimEnd(), limits.readTextMaxChars);
}

export function formatSchemaOverviewText(
  collections: Array<{
    collection: string;
    singleton: boolean;
    primaryKey: string | null;
    fieldCount: number;
    relationCount: number;
  }>,
  limits: TextLimits,
): string {
  if (collections.length === 0) {
    return 'No collections visible to the configured token.';
  }
  const lines = collections.map(
    (c) =>
      `- ${c.collection} (pk=${c.primaryKey ?? '?'}, singleton=${c.singleton ? 'yes' : 'no'}, fields=${c.fieldCount}, relations=${c.relationCount})`,
  );
  return truncateText(
    `Collections (${collections.length}):\n${lines.join('\n')}`,
    limits.readTextMaxChars,
  );
}

/* ----------------------------------------------------------------
 * Records (read_items / read_item)
 * ---------------------------------------------------------------- */

/**
 * Pull the `data` array out of a Directus response. Directus returns
 * either `{ data: [...] }` or (for single item) `{ data: {...} }`.
 */
export function extractRecords(response: unknown): unknown[] {
  if (Array.isArray(response)) return response;
  if (response && typeof response === 'object') {
    const r = response as { data?: unknown };
    if (Array.isArray(r.data)) return r.data;
    if (r.data && typeof r.data === 'object') return [r.data];
  }
  return [];
}

export function formatReadItemsText(
  collection: string,
  query: Record<string, unknown>,
  response: unknown,
  limits: TextLimits,
): string {
  const records = extractRecords(response);
  const limit = query.limit;
  const fields = query.fields;
  const filter = query.filter;
  const sort = query.sort;

  const header: string[] = [`Collection: ${collection}`];
  header.push(`Count: ${records.length}`);
  const queryBits: string[] = [];
  if (fields !== undefined) queryBits.push(`fields=${JSON.stringify(fields)}`);
  if (filter !== undefined) queryBits.push(`filter=${JSON.stringify(filter)}`);
  if (sort !== undefined) queryBits.push(`sort=${JSON.stringify(sort)}`);
  if (limit !== undefined) queryBits.push(`limit=${limit}`);
  if (queryBits.length > 0) header.push(`Query: ${queryBits.join(', ')}`);

  if (records.length === 0) {
    header.push('Data: (0 items returned)');
    return header.join('\n');
  }

  const sliced = records.slice(0, limits.readTextMaxRows);
  const bodyLines: string[] = [];
  for (let i = 0; i < sliced.length; i++) {
    const r = sliced[i];
    const json = typeof r === 'object' && r !== null
      ? JSON.stringify(r)
      : String(r);
    bodyLines.push(`[${i}] ${json}`);
  }
  if (records.length > limits.readTextMaxRows) {
    bodyLines.push(
      `…[${records.length - limits.readTextMaxRows} more rows truncated]`,
    );
  }
  header.push('Data:');
  return truncateText(`${header.join('\n')}\n${bodyLines.join('\n')}`, limits.readTextMaxChars);
}

export function formatReadItemText(
  collection: string,
  key: string | number,
  response: unknown,
  limits: TextLimits,
): string {
  const records = extractRecords(response);
  const record = records[0];
  if (!record) {
    return `Collection: ${collection}\nKey: ${key}\nData: (item not found or empty)`;
  }
  const json = typeof record === 'object' && record !== null
    ? JSON.stringify(record, null, 2)
    : String(record);
  return truncateText(
    `Collection: ${collection}\nKey: ${key}\nData:\n${json}`,
    limits.readTextMaxChars,
  );
}

/* ----------------------------------------------------------------
 * Mutation results (create / update / delete / dry-run)
 * ---------------------------------------------------------------- */

export interface MutationTextSummary {
  action: 'create' | 'update' | 'delete' | 'dry_run';
  collection: string;
  dryRun: boolean;
  aborted?: boolean;
  abortReason?: string;
  ok: boolean;
  /** When true, this is the result of directus_apply_plan (real write happened). */
  applied?: boolean;
  /** Plan ID for dry-run responses (so model can call directus_apply_plan). */
  planId?: string;
  /** Plan expiry timestamp. */
  planExpiresAt?: string;
  /** Read-back verification result after apply. */
  readBackOk?: boolean | null;
  readBackMismatches?: Array<{ field: string; expected: unknown; actual: unknown }>;
  summary?: {
    total?: number;
    ok?: number;
    failed?: number;
    dryRun?: boolean;
  };
  before?: unknown;
  after?: unknown;
  diff?: Record<string, { before: unknown; after: unknown; changed: boolean }>;
  error?: { code: string; message: string; details?: unknown };
  results?: Array<unknown>;
  changedFields?: string[];
}

function formatDiff(
  diff: Record<string, { before: unknown; after: unknown; changed: boolean }>,
): string {
  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const [k, v] of Object.entries(diff)) {
    if (v.changed) {
      changed.push(`  ${k}: ${JSON.stringify(v.before)} -> ${JSON.stringify(v.after)}`);
    } else {
      unchanged.push(`  ${k}: (no change)`);
    }
  }
  const out: string[] = [];
  if (changed.length > 0) {
    out.push('Diff (changed):');
    out.push(changed.join('\n'));
  }
  if (unchanged.length > 0) {
    out.push('Diff (unchanged):');
    out.push(unchanged.join('\n'));
  }
  return out.join('\n');
}

export function formatMutationText(
  result: MutationTextSummary,
  limits: TextLimits,
): string {
  const parts: string[] = [];

  // Header line — status prefix + action + collection + outcome.
  // The prefix is the CRITICAL signal for the model:
  //   DRY-RUN  = nothing was written
  //   APPLIED  = real write happened
  //   APPLIED_WITH_WARNING = real write happened but post-write verification failed
  //   ABORTED  = nothing was written (preflight failed)
  //   FAILED   = nothing was written (error)
  // When a warning is present (applied + readback mismatch), the prefix
  // becomes "APPLIED" but the outcome shows "WARNING" instead of "OK" —
  // this is the critical signal that the write happened but something is off.
  const hasWarning = !!result.error && result.applied;
  const prefix = result.applied
    ? 'APPLIED'
    : result.aborted
      ? 'ABORTED'
      : result.dryRun
        ? 'DRY-RUN'
        : result.ok
          ? 'OK'
          : 'FAILED';
  const writtenFlag = result.applied
    ? 'written=true'
    : result.dryRun
      ? 'NOT WRITTEN'
      : result.aborted
        ? 'NOT WRITTEN'
        : result.ok
          ? 'written=true'
          : 'NOT WRITTEN';
  const headerBits = [`${prefix} ${result.action.toUpperCase()} ${result.collection}`];
  if (hasWarning) {
    headerBits.push('— WARNING');
  } else if (result.ok || result.applied) {
    headerBits.push('— OK');
  } else {
    headerBits.push('— FAILED');
  }
  headerBits.push(`(dryRun=${result.dryRun})`);
  if (writtenFlag) headerBits.push(writtenFlag);
  parts.push(headerBits.join(' '));

  // Plan info (dry-run responses)
  if (result.planId) {
    parts.push(`Plan ID: ${result.planId}`);
    if (result.planExpiresAt) {
      parts.push(`Plan expires at: ${result.planExpiresAt}`);
    }
  }

  // Read-back verification (apply responses)
  if (result.readBackOk !== undefined) {
    if (result.readBackOk === true) {
      parts.push('Read-back verification: OK');
    } else if (result.readBackOk === false) {
      parts.push('Read-back verification: MISMATCH');
      if (result.readBackMismatches && result.readBackMismatches.length > 0) {
        const mmLines = result.readBackMismatches.map((m) => `  ${m.field}: expected=${JSON.stringify(m.expected)} actual=${JSON.stringify(m.actual)}`);
        parts.push(mmLines.join('\n'));
      }
    } else {
      parts.push('Read-back verification: (not performed for this operation type)');
    }
  }

  // Batch summary
  if (result.summary) {
    const s = result.summary;
    parts.push(
      `Summary: total=${s.total ?? '?'} ok=${s.ok ?? '?'} failed=${s.failed ?? '?'}${result.aborted ? ' aborted=true' : ''}`,
    );
  }
  if (result.aborted && result.abortReason) {
    parts.push(`Abort reason: ${result.abortReason}`);
  }

  // Changed fields (compact)
  if (result.changedFields && result.changedFields.length > 0) {
    parts.push(`Changed fields: ${result.changedFields.join(', ')}`);
  }

  // Error
  if (result.error) {
    parts.push(
      `Error: ${result.error.code} — ${result.error.message}` +
        (result.error.details ? `\nDetails: ${JSON.stringify(result.error.details)}` : ''),
    );
  }

  // Before / after / diff (single-item update)
  if (result.before !== undefined) {
    parts.push(`Before: ${JSON.stringify(result.before)}`);
  }
  if (result.after !== undefined && result.after !== null) {
    parts.push(`After: ${JSON.stringify(result.after)}`);
  }
  if (result.diff && Object.keys(result.diff).length > 0) {
    parts.push(formatDiff(result.diff));
  }

  // Per-item results (batch)
  if (Array.isArray(result.results) && result.results.length > 0) {
    const head = result.results.slice(0, Math.min(limits.readTextMaxRows, result.results.length));
    parts.push(`Per-item results (${result.results.length} total, showing first ${head.length}):`);
    for (let i = 0; i < head.length; i++) {
      const r = head[i] as Record<string, unknown>;
      const ok = !('error' in r);
      const key = (r.key as string | number | undefined) ?? i;
      if (ok) {
        const diff = r.diff as Record<string, { changed: boolean }> | undefined;
        const changedFields = diff
          ? Object.entries(diff).filter(([, v]) => v.changed).map(([k]) => k)
          : [];
        parts.push(`  [${key}] OK${changedFields.length > 0 ? ` changed: ${changedFields.join(',')}` : ''}`);
      } else {
        const err = r.error as { code: string; message: string };
        parts.push(`  [${key}] FAIL: ${err.code} — ${err.message}`);
      }
    }
    if (result.results.length > head.length) {
      parts.push(`  …[${result.results.length - head.length} more items truncated]`);
    }
  }

  // Next-action hint for dry-run (critical for preventing model hallucination).
  if (result.dryRun && result.planId && result.ok) {
    parts.push('');
    parts.push('⚠ DRY-RUN ONLY — hiçbir veri yazılmadı.');
    parts.push(`Kullanıcı onay verirse şu tool çağrılmalı:`);
    parts.push(`directus_apply_plan({ "plan_id": "${result.planId}", "confirm": true })`);
    parts.push(`Başarı mesajı ancak directus_apply_plan sonucunda applied:true / written:true görüldükten sonra verilebilir.`);
  }

  return truncateText(parts.join('\n'), limits.readTextMaxChars);
}
