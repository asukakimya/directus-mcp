/**
 * Diff utilities used by update dry-run / apply.
 *
 * A `MutationDiff` only includes fields that the caller asked to change.
 * For each field we record `before`, `after`, and `changed` (whether
 * the new value differs from the existing one). Fields whose `after`
 * equals `before` are reported with `changed: false` so the LLM can
 * see that no-op writes are intentional.
 */

export interface FieldDiff {
  before: unknown;
  after: unknown;
  changed: boolean;
}

export type MutationDiff = Record<string, FieldDiff>;

/**
 * Compare two values using JSON-serialisation equality. This treats
 * `[] === []`, `{ a: 1 } === { a: 1 }`, and `1 === '1'` as different.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) =>
      deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      ),
    );
  }
  return false;
}

/**
 * Build a diff between an existing record and the requested patch.
 * Only keys present in `patch` are reported.
 */
export function computeDiff(
  before: Record<string, unknown> | null,
  patch: Record<string, unknown>,
): MutationDiff {
  const beforeObj = before ?? {};
  const out: MutationDiff = {};
  for (const [k, after] of Object.entries(patch)) {
    const beforeVal = (beforeObj as Record<string, unknown>)[k];
    out[k] = {
      before: beforeVal ?? null,
      after,
      changed: !deepEqual(beforeVal ?? null, after),
    };
  }
  return out;
}

export function hasAnyChange(diff: MutationDiff): boolean {
  return Object.values(diff).some((d) => d.changed);
}
