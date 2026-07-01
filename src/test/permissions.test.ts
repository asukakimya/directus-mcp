import { describe, it, expect } from 'vitest';
import {
  isCollectionAllowed,
  isSystemCollection,
  assertCollectionReadable,
  assertCollectionMutable,
  assertDeleteAllowed,
  assertBatchSize,
} from '../../src/safety/permissions.js';
import { expectErrorCode } from './helpers.js';
import type { AppConfig } from '../../src/config.js';

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    directusUrl: 'https://example.com',
    directusToken: 't',
    mcpTransport: 'stdio',
    mcpHttpPort: 3333,
    mcpRequireAuth: true,
    mcpAuthToken: 'test-token',
    allowedCollections: new Set<string>(['articles', 'authors']),
    deniedCollectionPrefixes: ['directus_'],
    allowDelete: false,
    allowSchemaWrite: false,
    mutationDryRunDefault: true,
    mutationRequireVerify: true,
    mutationMaxBatchSize: 5,
    readDefaultLimit: 50,
    readMaxLimit: 500,
    allowWildcardFields: false,
    schemaCacheTtlSeconds: 300,
    verifyCaseInsensitive: false,
    logLevel: 'info',
    ...overrides,
  };
}

describe('isSystemCollection', () => {
  it('detects directus_ prefixed collections', () => {
    expect(isSystemCollection('directus_users')).toBe(true);
    expect(isSystemCollection('directus_flows')).toBe(true);
  });
  it('does not flag custom collections', () => {
    expect(isSystemCollection('articles')).toBe(false);
  });
});

describe('isCollectionAllowed', () => {
  it('returns false for directus_ prefixed regardless of allowlist', () => {
    const cfg = makeConfig();
    expect(isCollectionAllowed(cfg, 'directus_users')).toBe(false);
  });
  it('returns true for allowlisted collections', () => {
    const cfg = makeConfig();
    expect(isCollectionAllowed(cfg, 'articles')).toBe(true);
  });
  it('returns false for non-allowlisted collections', () => {
    const cfg = makeConfig();
    expect(isCollectionAllowed(cfg, 'reviews')).toBe(false);
  });
  it('returns true for any non-directus collection when allowlist is empty', () => {
    const cfg = makeConfig({ allowedCollections: new Set<string>() });
    expect(isCollectionAllowed(cfg, 'articles')).toBe(true);
    expect(isCollectionAllowed(cfg, 'reviews')).toBe(true);
    expect(isCollectionAllowed(cfg, 'directus_users')).toBe(false);
  });
});

describe('assertCollectionReadable', () => {
  it('throws COLLECTION_NOT_ALLOWED for non-allowlisted', () => {
    const cfg = makeConfig();
    expectErrorCode(() => assertCollectionReadable(cfg, 'reviews'), 'COLLECTION_NOT_ALLOWED');
  });
  it('passes for allowlisted', () => {
    const cfg = makeConfig();
    expect(() => assertCollectionReadable(cfg, 'articles')).not.toThrow();
  });
});

describe('assertCollectionMutable', () => {
  it('rejects system collections with SYSTEM_COLLECTION_DENIED even when allowlisted', () => {
    const cfg = makeConfig({ allowedCollections: new Set<string>(['directus_users']) });
    expectErrorCode(() => assertCollectionMutable(cfg, 'directus_users'), 'SYSTEM_COLLECTION_DENIED');
  });
  it('rejects system collections even when allowlist is empty', () => {
    const cfg = makeConfig({ allowedCollections: new Set<string>() });
    expectErrorCode(() => assertCollectionMutable(cfg, 'directus_users'), 'SYSTEM_COLLECTION_DENIED');
  });
  it('passes for allowlisted non-system collections', () => {
    const cfg = makeConfig();
    expect(() => assertCollectionMutable(cfg, 'articles')).not.toThrow();
  });
});

describe('assertDeleteAllowed', () => {
  it('throws DELETE_DISABLED when allowDelete=false', () => {
    const cfg = makeConfig({ allowDelete: false });
    expectErrorCode(() => assertDeleteAllowed(cfg, 'articles'), 'DELETE_DISABLED');
  });
  it('passes when allowDelete=true', () => {
    const cfg = makeConfig({ allowDelete: true });
    expect(() => assertDeleteAllowed(cfg, 'articles')).not.toThrow();
  });
});

describe('assertBatchSize', () => {
  it('rejects zero / negative / non-integer', () => {
    const cfg = makeConfig();
    expectErrorCode(() => assertBatchSize(cfg, 0), 'INVALID_QUERY');
    expectErrorCode(() => assertBatchSize(cfg, -1), 'INVALID_QUERY');
    expectErrorCode(() => assertBatchSize(cfg, 1.5), 'INVALID_QUERY');
  });
  it('rejects sizes above mutationMaxBatchSize', () => {
    const cfg = makeConfig({ mutationMaxBatchSize: 5 });
    expectErrorCode(() => assertBatchSize(cfg, 6), 'BATCH_LIMIT_EXCEEDED');
  });
  it('accepts sizes within limit', () => {
    const cfg = makeConfig({ mutationMaxBatchSize: 5 });
    expect(() => assertBatchSize(cfg, 5)).not.toThrow();
    expect(() => assertBatchSize(cfg, 1)).not.toThrow();
  });
});
