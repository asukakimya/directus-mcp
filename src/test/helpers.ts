import { expect } from 'vitest';
import { McpUserError } from '../directus/errors.js';

/**
 * Assert that a (sync or async) function throws an McpUserError with the
 * expected `errorCode`. Handles both sync throws and rejected promises.
 */
export async function expectErrorCode(
  fn: () => unknown | Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    const r = fn();
    if (r instanceof Promise) {
      await r;
    }
  } catch (err) {
    if (err instanceof McpUserError) {
      expect(err.errorCode).toBe(code);
      return;
    }
    throw err;
  }
  throw new Error(`expected function to throw ${code}, but it did not throw`);
}
