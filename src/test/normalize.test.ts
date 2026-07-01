import { describe, it, expect } from 'vitest';
import { normalizeJsonLike, normalizeToolArgs, isPlainObject, ensureArray, pickDataInput } from '../../src/safety/normalize.js';

describe('normalizeJsonLike', () => {
  it('parses a stringified JSON object', () => {
    expect(normalizeJsonLike({ data: '{"website":"x"}' })).toEqual({ data: { website: 'x' } });
  });

  it('parses a stringified JSON array', () => {
    expect(normalizeJsonLike({ data: '[{"id":1}]' })).toEqual({ data: [{ id: 1 }] });
  });

  it('parses nested stringified JSON inside arrays', () => {
    expect(
      normalizeJsonLike([
        { key: 1, data: '{"slug":"intro-to-mcp"}' },
      ]),
    ).toEqual([{ key: 1, data: { slug: 'intro-to-mcp' } }]);
  });

  it('parses query_json as object', () => {
    expect(normalizeJsonLike({ query: '{"fields":["id"]}' })).toEqual({ query: { fields: ['id'] } });
  });

  it('passes through invalid JSON strings unchanged', () => {
    expect(normalizeJsonLike('{not valid json}')).toBe('{not valid json}');
  });

  it('passes through non-JSON-looking strings unchanged', () => {
    expect(normalizeJsonLike('hello world')).toBe('hello world');
  });

  it('recurses into nested objects', () => {
    expect(
      normalizeJsonLike({
        outer: { inner: '{"a":1}' },
      }),
    ).toEqual({ outer: { inner: { a: 1 } } });
  });

  it('recurses into arrays', () => {
    expect(normalizeJsonLike(['{"a":1}', '{"b":2}'])).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('handles primitives', () => {
    expect(normalizeJsonLike(42)).toBe(42);
    expect(normalizeJsonLike(true)).toBe(true);
    expect(normalizeJsonLike(null)).toBe(null);
    expect(normalizeJsonLike(undefined)).toBe(undefined);
  });

  it('does not break on JSON string that looks like array but is plain text', () => {
    expect(normalizeJsonLike('[hello]')).toBe('[hello]');
  });

  it('parses the regression-test payload (stringified items_json)', () => {
    const input = {
      collection: 'articles',
      items_json:
        '[{"key":1,"verify":{"title":"Intro to MCP"},"data":{"slug":"intro-to-mcp"}}]',
      dry_run: true,
    };
    const out = normalizeJsonLike(input) as {
      items_json: Array<{ key: number; verify: { title: string }; data: { slug: string } }>;
    };
    expect(out.items_json).toEqual([
      { key: 1, verify: { title: 'Intro to MCP' }, data: { slug: 'intro-to-mcp' } },
    ]);
  });
});

describe('normalizeToolArgs', () => {
  it('normalises only known nested fields, leaves others untouched', () => {
    const out = normalizeToolArgs({
      data: '{"x":1}',
      collection: 'articles',
      arbitrary: '{"y":2}',
    });
    expect(out.data).toEqual({ x: 1 });
    expect(out.collection).toBe('articles');
    expect(out.arbitrary).toBe('{"y":2}');
  });
});

describe('isPlainObject', () => {
  it('accepts plain objects', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });
  it('rejects arrays and primitives', () => {
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
    expect(isPlainObject(42)).toBe(false);
    expect(isPlainObject('str')).toBe(false);
  });
});

describe('ensureArray', () => {
  it('wraps non-arrays', () => {
    expect(ensureArray(1)).toEqual([1]);
    expect(ensureArray('a')).toEqual(['a']);
  });
  it('returns arrays unchanged', () => {
    expect(ensureArray([1, 2])).toEqual([1, 2]);
  });
  it('returns empty array for null/undefined', () => {
    expect(ensureArray(null)).toEqual([]);
    expect(ensureArray(undefined)).toEqual([]);
  });
});

describe('pickDataInput', () => {
  it('prefers structured form', () => {
    expect(pickDataInput({ a: 1 }, '{"a":1}')).toEqual({ a: 1 });
  });
  it('falls back to JSON string form when structured is missing', () => {
    expect(pickDataInput(undefined, '{"a":1}')).toBe('{"a":1}');
  });
  it('returns undefined when both missing', () => {
    expect(pickDataInput(undefined, undefined)).toBe(undefined);
  });
});
