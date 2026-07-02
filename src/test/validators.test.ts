import { describe, it, expect } from 'vitest';
import { normalizeAndValidateReadQuery, ALLOWED_FILTER_OPERATORS } from '../../src/directus/query.js';
import { validateFields } from '../../src/directus/validators.js';
import type { CollectionSchema } from '../../src/directus/schema.js';
import type { AppConfig } from '../../src/config.js';
import { expectErrorCode } from './helpers.js';

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    directusUrl: 'https://example.com',
    directusToken: 't',
    mcpTransport: 'stdio',
    mcpRequireAuth: true,
    mcpAuthToken: 'test-token',
    mcpHttpPort: 3333,
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
    applyRequiresPlan: false,
    planStore: 'memory' as const,
    planStoreDir: '/tmp/test-plans',
    planTtlSeconds: 900,
    planMaxBytes: 1048576,
    logLevel: 'info',
    ...overrides,
  };
}

function makeSchema(): CollectionSchema {
  return {
    collection: 'articles',
    singleton: false,
    primaryKey: 'id',
    fields: {
      // PK fields are not marked readonly in Directus meta; they're
      // auto-generated. Our validator detects PK via isPrimaryKey.
      id: { field: 'id', type: 'integer', readonly: false, required: false, isPrimaryKey: true },
      title: { field: 'title', type: 'string', readonly: false, required: true },
      slug: { field: 'slug', type: 'string', readonly: false, required: false },
      status: { field: 'status', type: 'string', readonly: false, required: false },
      user_created: { field: 'user_created', type: 'uuid', readonly: true, required: false },
      date_created: { field: 'date_created', type: 'timestamp', readonly: true, required: false },
    },
    relations: [],
  };
}

describe('normalizeAndValidateReadQuery', () => {
  it('applies default limit and safe default fields when none provided', () => {
    const cfg = makeConfig();
    const schema = makeSchema();
    const { query, warnings } = normalizeAndValidateReadQuery(cfg, schema, undefined);
    expect(query.limit).toBe(50);
    expect(Array.isArray(query.fields)).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('clamps limit to readMaxLimit', () => {
    const cfg = makeConfig({ readMaxLimit: 100 });
    const schema = makeSchema();
    const { query, warnings } = normalizeAndValidateReadQuery(cfg, schema, {
      fields: ['id'],
      limit: 1000,
    });
    expect(query.limit).toBe(100);
    expect(warnings.some((w) => w.includes('clamped'))).toBe(true);
  });

  it('rejects wildcard fields by default', () => {
    const cfg = makeConfig();
    const schema = makeSchema();
    expectErrorCode(
      () => normalizeAndValidateReadQuery(cfg, schema, { fields: ['*'] }),
      'INVALID_QUERY',
    );
  });

  it('accepts wildcard fields when ALLOW_WILDCARD_FIELDS=true', () => {
    const cfg = makeConfig({ allowWildcardFields: true });
    const schema = makeSchema();
    const { query } = normalizeAndValidateReadQuery(cfg, schema, { fields: ['*'] });
    expect(query.fields).toEqual(['*']);
  });

  it('rejects unknown field in fields', () => {
    const cfg = makeConfig();
    const schema = makeSchema();
    expectErrorCode(
      () => normalizeAndValidateReadQuery(cfg, schema, { fields: ['nonexistent'] }),
      'UNKNOWN_FIELD',
    );
  });

  it('accepts dotted relation field when first segment is known', () => {
    const cfg = makeConfig();
    const schema = makeSchema();
    // add a relation field to schema
    schema.fields['category'] = { field: 'category', type: 'integer', readonly: false, required: false };
    const { query } = normalizeAndValidateReadQuery(cfg, schema, { fields: ['category.id', 'category.name'] });
    expect(query.fields).toEqual(['category.id', 'category.name']);
  });

  it('rejects unknown filter operator', () => {
    const cfg = makeConfig();
    const schema = makeSchema();
    expectErrorCode(
      () => normalizeAndValidateReadQuery(cfg, schema, {
        fields: ['id'],
        filter: { title: { _regex: '.*' } },
      }),
      'INVALID_FILTER_OPERATOR',
    );
  });

  it('accepts whitelisted filter operators', () => {
    const cfg = makeConfig();
    const schema = makeSchema();
    const { query } = normalizeAndValidateReadQuery(cfg, schema, {
      fields: ['id'],
      filter: { title: { _icontains: 'Intro to MCP' } },
    });
    expect((query.filter as Record<string, unknown>).title).toEqual({ _icontains: 'Intro to MCP' });
  });

  it('rejects unknown top-level query keys', () => {
    const cfg = makeConfig();
    const schema = makeSchema();
    expectErrorCode(
      () => normalizeAndValidateReadQuery(cfg, schema, { fields: ['id'], bogus: true }),
      'INVALID_QUERY',
    );
  });

  it('rejects sort on unknown field', () => {
    const cfg = makeConfig();
    const schema = makeSchema();
    expectErrorCode(
      () => normalizeAndValidateReadQuery(cfg, schema, { fields: ['id'], sort: 'nonexistent' }),
      'UNKNOWN_FIELD',
    );
  });

  it('accepts sort with leading minus', () => {
    const cfg = makeConfig();
    const schema = makeSchema();
    const { query } = normalizeAndValidateReadQuery(cfg, schema, {
      fields: ['id'],
      sort: '-title',
    });
    expect(query.sort).toBe('-title');
  });

  it('ALLOWED_FILTER_OPERATORS contains all spec operators', () => {
    const required = [
      '_eq', '_neq', '_in', '_nin', '_null', '_nnull', '_lt', '_lte', '_gt', '_gte',
      '_between', '_contains', '_icontains', '_starts_with', '_ends_with', '_empty',
      '_nempty', '_some', '_none', '_and', '_or',
    ];
    for (const op of required) {
      expect(ALLOWED_FILTER_OPERATORS.has(op)).toBe(true);
    }
  });
});

describe('normalizeAndValidateReadQuery — single mode (read_item)', () => {
  const cfg = makeConfig();
  const schema = makeSchema();

  it('rejects limit in single mode', () => {
    expectErrorCode(
      () => normalizeAndValidateReadQuery(cfg, schema, { fields: ['id'], limit: 10 }, 'single'),
      'INVALID_QUERY',
    );
  });

  it('rejects page in single mode', () => {
    expectErrorCode(
      () => normalizeAndValidateReadQuery(cfg, schema, { fields: ['id'], page: 1 }, 'single'),
      'INVALID_QUERY',
    );
  });

  it('rejects offset in single mode', () => {
    expectErrorCode(
      () => normalizeAndValidateReadQuery(cfg, schema, { fields: ['id'], offset: 0 }, 'single'),
      'INVALID_QUERY',
    );
  });

  it('accepts fields-only query in single mode', () => {
    const { query, warnings } = normalizeAndValidateReadQuery(
      cfg,
      schema,
      { fields: ['id', 'title'] },
      'single',
    );
    expect(query.fields).toEqual(['id', 'title']);
    expect(query.limit).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('does NOT inject default limit in single mode', () => {
    const { query } = normalizeAndValidateReadQuery(cfg, schema, undefined, 'single');
    expect(query.limit).toBeUndefined();
  });

  it('does inject default limit in list mode', () => {
    const { query } = normalizeAndValidateReadQuery(cfg, schema, undefined, 'list');
    expect(query.limit).toBe(cfg.readDefaultLimit);
  });

  it('accepts deep in single mode (relation expand)', () => {
    schema.fields['author'] = { field: 'author', type: 'integer', readonly: false, required: false };
    const { query } = normalizeAndValidateReadQuery(
      cfg,
      schema,
      { fields: ['id', 'author.name'], deep: { author: { _limit: 1 } } },
      'single',
    );
    expect(query.deep).toBeDefined();
    expect(query.limit).toBeUndefined();
  });
});

describe('validateFields', () => {
  it('rejects unknown fields in create', () => {
    const schema = makeSchema();
    expectErrorCode(
      () => validateFields(schema, { title: 'X', bogus: 1 }, { mode: 'create', collection: 'articles' }),
      'UNKNOWN_FIELD',
    );
  });

  it('rejects readonly fields in update', () => {
    const schema = makeSchema();
    expectErrorCode(
      () => validateFields(schema, { user_created: 'abc' }, { mode: 'update', collection: 'articles' }),
      'READONLY_FIELD',
    );
  });

  it('rejects date_created / user_created / date_updated / user_updated', () => {
    const schema = makeSchema();
    for (const f of ['date_created', 'user_created', 'date_updated', 'user_updated']) {
      schema.fields[f] = { field: f, type: 'timestamp', readonly: false, required: false };
      expectErrorCode(
        () => validateFields(schema, { [f]: '2024-01-01' }, { mode: 'update', collection: 'articles' }),
        'READONLY_FIELD',
      );
    }
  });

  it('rejects primary key update', () => {
    const schema = makeSchema();
    expectErrorCode(
      () => validateFields(schema, { id: 99 }, { mode: 'update', collection: 'articles' }),
      'PRIMARY_KEY_UPDATE_DENIED',
    );
  });

  it('rejects required-field-missing on create', () => {
    const schema = makeSchema();
    expectErrorCode(
      () => validateFields(schema, { slug: 'https://x.com' }, { mode: 'create', collection: 'articles' }),
      'REQUIRED_FIELD_MISSING',
    );
  });

  it('passes when all required fields are present on create', () => {
    const schema = makeSchema();
    expect(() =>
      validateFields(schema, { title: 'Intro to MCP' }, { mode: 'create', collection: 'articles' }),
    ).not.toThrow();
  });

  it('passes update on non-readonly, non-pk fields', () => {
    const schema = makeSchema();
    expect(() =>
      validateFields(schema, { slug: 'https://x.com' }, { mode: 'update', collection: 'articles' }),
    ).not.toThrow();
  });
});
