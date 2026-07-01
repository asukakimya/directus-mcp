/**
 * Dry-run helpers.
 *
 * A "dry-run" means we run all read-side operations (read-before,
 * verify, validate, diff) but skip the actual write. The result is
 * a structured payload that tells the LLM exactly what would happen
 * if the operation were applied.
 */

export interface DryRunResult<TItem = Record<string, unknown>> {
  dryRun: true;
  before: TItem | null;
  after: TItem | null; // predicted (for update) or expected (for create)
  diff?: Record<string, { before: unknown; after: unknown; changed: boolean }>;
  wouldWrite: boolean;
}

export function dryRunFromDiff(
  before: Record<string, unknown> | null,
  diff: Record<string, { before: unknown; after: unknown; changed: boolean }>,
): DryRunResult {
  const after: Record<string, unknown> = { ...(before ?? {}) };
  for (const [k, d] of Object.entries(diff)) {
    after[k] = d.after;
  }
  const wouldWrite = Object.values(diff).some((d) => d.changed);
  return {
    dryRun: true,
    before: before ?? null,
    after,
    diff,
    wouldWrite,
  };
}
