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

  // Header line: action / collection / dry-run / outcome
  const outcome = result.aborted
    ? 'ABORTED'
    : result.ok
      ? 'OK'
      : 'FAILED';
  parts.push(
    `${result.action.toUpperCase()} ${result.collection} — ${outcome} (dryRun=${result.dryRun})`,
  );

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

  return truncateText(parts.join('\n'), limits.readTextMaxChars);
}
