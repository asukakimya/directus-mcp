import type { AppConfig } from '../config.js';
import { deepEqual } from './diff.js';
import { McpUserError } from '../directus/errors.js';

/**
 * Verify the existing record matches the user-supplied expectations
 * BEFORE applying a mutation. This prevents "lost update" scenarios
 * where the LLM is operating on stale data.
 *
 * Default compare rules:
 *   - Strings: trimmed exact match (case-sensitive unless
 *     `VERIFY_CASE_INSENSITIVE=true`).
 *   - Numbers / booleans: strict equality.
 *   - Arrays / objects: deep equality.
 *   - null vs undefined are treated as equal.
 *
 * On mismatch we throw `VERIFY_FAILED` with a per-field diff so the
 * LLM can decide whether to re-read and retry.
 */
export type VerifyExpectation = Record<string, unknown>;

export interface VerifyResult {
  ok: boolean;
  mismatches: Array<{ field: string; expected: unknown; actual: unknown }>;
}

export function verifyRecord(
  config: AppConfig,
  record: Record<string, unknown> | null,
  expectations: VerifyExpectation,
): VerifyResult {
  const mismatches: VerifyResult['mismatches'] = [];
  const actual = record ?? {};

  for (const [field, expected] of Object.entries(expectations)) {
    const actualVal = (actual as Record<string, unknown>)[field];

    if (!valuesEqual(config, expected, actualVal)) {
      mismatches.push({ field, expected, actual: actualVal ?? null });
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}

export function assertVerify(
  config: AppConfig,
  record: Record<string, unknown> | null,
  expectations: VerifyExpectation,
  context: Record<string, unknown> = {},
): void {
  const result = verifyRecord(config, record, expectations);
  if (!result.ok) {
    throw new McpUserError(
      'VERIFY_FAILED',
      `Verify failed for ${result.mismatches.length} field(s)`,
      { ...context, mismatches: result.mismatches },
    );
  }
}

function valuesEqual(config: AppConfig, expected: unknown, actual: unknown): boolean {
  // null vs undefined collapse
  if (expected === null && (actual === null || actual === undefined)) return true;
  if (actual === null && (expected === null || expected === undefined)) return true;

  if (typeof expected === 'string' && typeof actual === 'string') {
    const a = expected.trim();
    const b = actual.trim();
    return config.verifyCaseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
  }

  return deepEqual(expected, actual);
}
