import { describe, it, expect } from 'vitest';
import { computeDiff, deepEqual, hasAnyChange } from '../../src/safety/diff.js';
import { verifyRecord, assertVerify } from '../../src/safety/verify.js';
import type { AppConfig } from '../../src/config.js';
import { expectErrorCode } from './helpers.js';

const config: AppConfig = {
  directusUrl: 'https://example.com',
  directusToken: 't',
  mcpTransport: 'stdio',
  mcpHttpPort: 3333,
  mcpRequireAuth: true,
  mcpAuthToken: 'test-token',
  allowedCollections: new Set<string>(['articles']),
  deniedCollectionPrefixes: ['directus_'],
  allowDelete: false,
  allowSchemaWrite: false,
  mutationDryRunDefault: true,
  mutationRequireVerify: true,
  mutationMaxBatchSize: 100,
  readDefaultLimit: 50,
  readMaxLimit: 500,
  allowWildcardFields: false,
  schemaCacheTtlSeconds: 300,
  verifyCaseInsensitive: false,
    schemaTextMaxFields: 80,
    readTextMaxRows: 10,
    readTextMaxChars: 12000,
  logLevel: 'info',
};

describe('deepEqual', () => {
  it('compares primitives', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual(1, '1')).toBe(false);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual(true, true)).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
  });
  it('compares arrays', () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
  });
  it('compares objects', () => {
    expect(deepEqual({ a: 1 }, { a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});

describe('computeDiff', () => {
  it('returns diff with changed flag per field', () => {
    const before = { id: 1, title: 'Intro to MCP', website: null };
    const patch = { slug: 'intro-to-mcp' };
    const diff = computeDiff(before, patch);
    expect(diff.slug.changed).toBe(true);
    expect(diff.slug.before).toBe(null);
    expect(diff.slug.after).toBe('intro-to-mcp');
  });
  it('marks no-change fields with changed=false', () => {
    const before = { id: 1, title: 'Intro to MCP' };
    const patch = { title: 'Intro to MCP' };
    const diff = computeDiff(before, patch);
    expect(diff.title.changed).toBe(false);
  });
  it('handles null before', () => {
    const patch = { title: 'Intro to MCP' };
    const diff = computeDiff(null, patch);
    expect(diff.title.before).toBe(null);
    expect(diff.title.after).toBe('Intro to MCP');
    expect(diff.title.changed).toBe(true);
  });
});

describe('hasAnyChange', () => {
  it('returns true when any field changed', () => {
    const diff = computeDiff({ a: 1, b: 2 }, { a: 1, b: 3 });
    expect(hasAnyChange(diff)).toBe(true);
  });
  it('returns false when no field changed', () => {
    const diff = computeDiff({ a: 1, b: 2 }, { a: 1, b: 2 });
    expect(hasAnyChange(diff)).toBe(false);
  });
});

describe('verifyRecord', () => {
  it('passes when expectations match', () => {
    const r = verifyRecord(config, { id: 1, title: 'Intro to MCP' }, { title: 'Intro to MCP' });
    expect(r.ok).toBe(true);
    expect(r.mismatches).toHaveLength(0);
  });
  it('fails when expectations do not match', () => {
    const r = verifyRecord(config, { id: 1, title: 'Intro to MCP' }, { title: 'Directus Deep Dive' });
    expect(r.ok).toBe(false);
    expect(r.mismatches).toHaveLength(1);
    expect(r.mismatches[0]?.field).toBe('title');
  });
  it('trims strings before compare', () => {
    const r = verifyRecord(config, { title: '  Intro to MCP  ' }, { title: 'Intro to MCP' });
    expect(r.ok).toBe(true);
  });
  it('case-insensitive when configured', () => {
    const caseInsensitive: AppConfig = { ...config, verifyCaseInsensitive: true };
    const r = verifyRecord(caseInsensitive, { title: 'INTRO TO MCP' }, { title: 'intro to mcp' });
    expect(r.ok).toBe(true);
  });
  it('case-sensitive by default', () => {
    const r = verifyRecord(config, { title: 'INTRO TO MCP' }, { title: 'intro to mcp' });
    expect(r.ok).toBe(false);
  });
  it('assertVerify throws on mismatch', () => {
    expectErrorCode(
      () => assertVerify(config, { title: 'Intro to MCP' }, { title: 'Directus Deep Dive' }, { collection: 'articles', key: 1 }),
      'VERIFY_FAILED',
    );
  });
  it('assertVerify does not throw on match', () => {
    expect(() =>
      assertVerify(config, { title: 'Intro to MCP' }, { title: 'Intro to MCP' }, { collection: 'articles', key: 1 }),
    ).not.toThrow();
  });
});
