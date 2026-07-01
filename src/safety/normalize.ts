/**
 * Recursive JSON-like normaliser.
 *
 * Why this exists: Directus AI Assistant / remote MCP had a bug class
 * (GitHub issue #26891, PR #27005) where nested fields like `data`,
 * `query`, `filter`, `deep`, `keys`, `headers` would arrive at the
 * Directus server as stringified JSON instead of native objects.
 * Our sidecar MUST undo that before any validation.
 *
 * Rules:
 *   - If a string starts with `{`/`[` and ends with `}`/`]` and parses
 *     as JSON, replace it with the parsed value (recursively).
 *   - Arrays: recurse into each element.
 *   - Objects: recurse into each value (keep keys as-is).
 *   - All other primitives pass through unchanged.
 *
 * This function is pure and deterministic.
 */
export function normalizeJsonLike(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        return normalizeJsonLike(JSON.parse(trimmed));
      } catch {
        return value;
      }
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonLike(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [
        key,
        normalizeJsonLike(val),
      ]),
    );
  }

  return value;
}

/**
 * Fields that commonly arrive as stringified JSON from LLM clients.
 * Tool handlers should run these through `normalizeJsonLike` first.
 */
export const NESTED_JSON_FIELDS = [
  'data',
  'items',
  'operations',
  'keys',
  'query',
  'filter',
  'deep',
  'headers',
  'verify',
  'dedupe',
] as const;

/**
 * Normalise the well-known nested fields on an arguments object.
 * Leaves everything else untouched.
 */
export function normalizeToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if ((NESTED_JSON_FIELDS as readonly string[]).includes(k)) {
      out[k] = normalizeJsonLike(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

export function ensureArray<T = unknown>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value === undefined || value === null) return [];
  return [value as T];
}

/**
 * Merge two candidate inputs: prefer the structured form (`data`),
 * fall back to the stringified form (`data_json`) when missing.
 * Returns the chosen value BEFORE normalisation — caller is expected
 * to run `normalizeJsonLike` on the result.
 */
export function pickDataInput(structured: unknown, jsonString: unknown): unknown {
  if (structured !== undefined && structured !== null) return structured;
  if (jsonString !== undefined && jsonString !== null) return jsonString;
  return undefined;
}
