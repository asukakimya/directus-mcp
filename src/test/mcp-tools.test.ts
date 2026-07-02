import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DirectusRestClient } from '../../src/directus/rest.js';
import { SchemaService } from '../../src/directus/schemaService.js';
import { createAuditLog } from '../../src/safety/audit.js';
import { MemoryPlanStore } from '../../src/safety/plans.js';
import { schemaOverviewTool } from '../../src/tools/schemaOverview.js';
import { schemaDetailTool } from '../../src/tools/schemaDetail.js';
import { createItemTool } from '../../src/tools/createItem.js';
import { createItemsTool } from '../../src/tools/createItems.js';
import { readItemsTool } from '../../src/tools/readItems.js';
import { updateItemTool } from '../../src/tools/updateItem.js';
import { updateItemsSameDataTool } from '../../src/tools/updateItemsSameData.js';
import { batchUpdateItemsTool } from '../../src/tools/batchUpdateItems.js';
import { deleteItemsTool } from '../../src/tools/deleteItems.js';
import { dryRunMutationTool } from '../../src/tools/dryRunMutation.js';
import { applyPlanTool } from '../../src/tools/applyPlan.js';
import { cancelPlanTool } from '../../src/tools/cancelPlan.js';
import type { ToolContext } from '../../src/mcp/server.js';
import type { AppConfig } from '../../src/config.js';
import { pino } from 'pino';
import { expectErrorCode } from './helpers.js';

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    directusUrl: 'https://example.com',
    directusToken: 'tok',
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

const articlesSchemaResponse = {
  data: {
    collection: 'articles',
    meta: { singleton: false, primary_key: 'id' },
    schema: { name: 'articles' },
  },
};

const articlesFieldsResponse = {
  data: [
    {
      collection: 'articles',
      field: 'id',
      type: 'integer',
      schema: { is_primary_key: true, is_nullable: false },
      meta: { interface: 'input', readonly: true, special: null, options: null, hidden: false, required: false },
    },
    {
      collection: 'articles',
      field: 'title',
      type: 'string',
      schema: { is_primary_key: false, is_nullable: false },
      meta: { interface: 'input', readonly: false, special: null, options: null, hidden: false, required: true },
    },
    {
      collection: 'articles',
      field: 'slug',
      type: 'string',
      schema: { is_primary_key: false, is_nullable: true },
      meta: { interface: 'input', readonly: false, special: null, options: null, hidden: false, required: false },
    },
  ],
};

const articlesRelationsResponse = { data: [] };
const collectionsListResponse = {
  data: [
    { collection: 'articles', meta: { singleton: false, primary_key: 'id' }, schema: { name: 'articles' } },
  ],
};

function buildContext(overrides: Partial<ToolContext> = {}): ToolContext {
  const config = makeConfig();
  const logger = pino({ level: 'silent' });
  const client = new DirectusRestClient(config.directusUrl, config.directusToken);
  const schema = new SchemaService(client, 60000);
  const audit = createAuditLog(logger, config);
  const plans = new MemoryPlanStore();
  return { config, logger, client, schema, audit, plans, ...overrides };
}

function mockFetch(responseByPath: Record<string, { status?: number; body: unknown }>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    const path = url.pathname;
    // match longest prefix first
    const matchKey = Object.keys(responseByPath)
      .sort((a, b) => b.length - a.length)
      .find((k) => path.includes(k));
    if (!matchKey) {
      return new Response(JSON.stringify({ errors: [{ message: `no mock for ${path}` }] }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    const r = responseByPath[matchKey]!;
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('schema_overview tool', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('lists collections excluding system', async () => {
    const fetchMock = mockFetch({
      '/collections': { body: collectionsListResponse },
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await schemaOverviewTool.handler(ctx, { include_system: false });
    expect(result.structuredContent.ok).toBe(true);
    const arr = result.structuredContent.collections as Array<{ collection: string }>;
    expect(arr.some((c) => c.collection === 'articles')).toBe(true);
  });
});

describe('schema_detail tool', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns schema for requested collection', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await schemaDetailTool.handler(ctx, { collections: ['articles'] });
    expect(result.structuredContent.ok).toBe(true);
    const schemas = result.structuredContent.schemas as Record<string, { primaryKey: string }>;
    expect(schemas.articles?.primaryKey).toBe('id');
  });
});

describe('create_item tool (regression for spec §1.7 bug)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('parses data_json stringified JSON and runs as dry-run by default', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    // LLM sent data as JSON string — the wrapper should normalise it.
    const result = await createItemTool.handler(ctx, {
      collection: 'articles',
      data_json: '{"title":"Intro to MCP","slug":"https://example.com/intro"}',
    });

    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.dryRun).toBe(true);
    // Should NOT have called POST /items (dry-run).
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const postCalls = calls.filter((c) => (c[1] as RequestInit)?.method === 'POST');
    expect(postCalls.length).toBe(0);
  });

  it('rejects unknown field even in dry-run', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    await expectErrorCode(
      () => createItemTool.handler(ctx, {
        collection: 'articles',
        data: { title: 'Intro to MCP', bogus_field: 1 },
        dry_run: true,
      }),
      'UNKNOWN_FIELD',
    );
  });

  it('rejects directus_ collection mutation', async () => {
    const ctx = buildContext({ config: makeConfig({ allowedCollections: new Set<string>(['directus_users']) }) });
    await expectErrorCode(
      () => createItemTool.handler(ctx, {
        collection: 'directus_users',
        data: { first_name: 'X' },
        dry_run: true,
      }),
      'SYSTEM_COLLECTION_DENIED',
    );
  });
});

describe('update_item tool', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('dry-run returns diff with before/after', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'Intro to MCP', slug: null } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await updateItemTool.handler(ctx, {
      collection: 'articles',
      key: 1,
      verify: { title: 'Intro to MCP' },
      data: { slug: 'https://example.com/intro' },
      dry_run: true,
    });

    expect(result.structuredContent.dryRun).toBe(true);
    expect(result.structuredContent.before).toEqual({ id: 1, title: 'Intro to MCP', slug: null });
    expect(result.structuredContent.after).toEqual({
      id: 1,
      title: 'Intro to MCP',
      slug: 'https://example.com/intro',
    });
    const diff = result.structuredContent.diff as Record<string, { changed: boolean }>;
    expect(diff.slug.changed).toBe(true);
  });

  it('verify failure aborts update', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'Directus Deep Dive', slug: null } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    await expectErrorCode(
      () => updateItemTool.handler(ctx, {
        collection: 'articles',
        key: 1,
        verify: { title: 'Intro to MCP' }, // mismatch!
        data: { slug: 'https://example.com/intro' },
        dry_run: false,
      }),
      'VERIFY_FAILED',
    );
  });

  it('rejects unknown field in update data', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'Intro to MCP' } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    // Disable requireVerify so the field-validation check is the first error.
    const ctx = buildContext({ config: makeConfig({ mutationRequireVerify: false }) });
    await expectErrorCode(
      () => updateItemTool.handler(ctx, {
        collection: 'articles',
        key: 1,
        data: { bogus: 1 },
        dry_run: true,
      }),
      'UNKNOWN_FIELD',
    );
  });

  it('parses stringified data (regression for #26891)', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'Intro to MCP', slug: null } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    // Disable requireVerify to isolate the stringified-JSON parsing concern.
    const ctx = buildContext({ config: makeConfig({ mutationRequireVerify: false }) });
    // data sent as JSON string — should be parsed before validation.
    const result = await updateItemTool.handler(ctx, {
      collection: 'articles',
      key: 1,
      data: '{"slug":"https://example.com/intro"}',
      dry_run: true,
    });
    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.dryRun).toBe(true);
  });
});

describe('batch_update_items tool', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('dry-run returns per-item results', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'Intro to MCP', slug: null } } },
      '/items/articles/2': { body: { data: { id: 2, title: 'Directus Deep Dive', slug: null } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await batchUpdateItemsTool.handler(ctx, {
      collection: 'articles',
      items: [
        { key: 1, verify: { title: 'Intro to MCP' }, data: { slug: 'https://example.com/intro' } },
        { key: 2, verify: { title: 'Directus Deep Dive' }, data: { slug: 'https://example.com/deep-dive' } },
      ],
      dry_run: true,
    });

    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.summary).toEqual({ total: 2, ok: 2, failed: 0, dryRun: true, aborted: false });
  });

  it('parses items_json stringified JSON (regression for #26891)', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'Intro to MCP', slug: null } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await batchUpdateItemsTool.handler(ctx, {
      collection: 'articles',
      items_json: '[{"key":1,"verify":{"title":"Intro to MCP"},"data":{"slug":"https://example.com/intro"}}]',
      dry_run: true,
    });
    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.summary).toEqual({ total: 1, ok: 1, failed: 0, dryRun: true, aborted: false });
  });

  it('reports partial success when one item fails verify', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'Intro to MCP', slug: null } } },
      '/items/articles/2': { body: { data: { id: 2, title: 'WRONG', slug: null } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await batchUpdateItemsTool.handler(ctx, {
      collection: 'articles',
      items: [
        { key: 1, verify: { title: 'Intro to MCP' }, data: { slug: 'a' } },
        { key: 2, verify: { title: 'Directus Deep Dive' }, data: { slug: 'b' } },
      ],
      dry_run: true,
      fail_fast: false,
    });
    expect(result.structuredContent.ok).toBe(false);
    expect(result.structuredContent.summary).toEqual({ total: 2, ok: 1, failed: 1, dryRun: true, aborted: false });
  });
});

describe('delete_items tool', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('rejects with DELETE_DISABLED when allowDelete=false', async () => {
    const ctx = buildContext();
    await expectErrorCode(
      () => deleteItemsTool.handler(ctx, {
        collection: 'articles',
        keys: [1],
        confirm: 'DELETE articles:1',
        dry_run: true,
      }),
      'DELETE_DISABLED',
    );
  });

  it('requires confirm token', async () => {
    const ctx = buildContext({ config: makeConfig({ allowDelete: true }) });
    await expectErrorCode(
      () => deleteItemsTool.handler(ctx, {
        collection: 'articles',
        keys: [1, 2],
        dry_run: true,
      }),
      'CONFIRMATION_REQUIRED',
    );
  });

  it('dry-run after confirm passes', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles': { body: { data: [{ id: 1, title: 'Intro to MCP' }] } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext({ config: makeConfig({ allowDelete: true }) });
    const result = await deleteItemsTool.handler(ctx, {
      collection: 'articles',
      keys: [1],
      confirm: 'DELETE articles:1',
      dry_run: true,
    });
    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.dryRun).toBe(true);
    expect(result.structuredContent.deleted).toBe(false);
  });
});

describe('dry_run_mutation tool', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('plans multiple update operations', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'Intro to MCP', slug: null } } },
      '/items/articles/2': { body: { data: { id: 2, title: 'Directus Deep Dive', slug: null } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await dryRunMutationTool.handler(ctx, {
      operations: [
        { action: 'update', collection: 'articles', key: 1, verify: { title: 'Intro to MCP' }, data: { slug: 'https://example.com/intro' } },
        { action: 'update', collection: 'articles', key: 2, verify: { title: 'Directus Deep Dive' }, data: { slug: 'https://example.com/deep-dive' } },
      ],
    });

    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.dryRun).toBe(true);
    const ops = result.structuredContent.operations as Array<unknown>;
    expect(ops.length).toBe(2);
  });

  it('rejects non-update action', async () => {
    const ctx = buildContext();
    await expectErrorCode(
      () => dryRunMutationTool.handler(ctx, {
        operations: [{ action: 'delete', collection: 'articles', key: 1 }],
      }),
      'INVALID_QUERY',
    );
  });
});

describe('MUTATION_REQUIRE_VERIFY enforcement', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('update_item without verify is rejected with VERIFY_REQUIRED', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'Intro to MCP', slug: null } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext(); // mutationRequireVerify: true (default)
    await expectErrorCode(
      () => updateItemTool.handler(ctx, {
        collection: 'articles',
        key: 1,
        data: { slug: 'intro-to-mcp' },
        // no verify!
        dry_run: true,
      }),
      'VERIFY_REQUIRED',
    );
  });

  it('update_item with empty verify object is rejected', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'Intro to MCP', slug: null } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    await expectErrorCode(
      () => updateItemTool.handler(ctx, {
        collection: 'articles',
        key: 1,
        data: { slug: 'intro-to-mcp' },
        verify: {},
        dry_run: true,
      }),
      'VERIFY_REQUIRED',
    );
  });

  it('update_item with non-empty verify passes when requireVerify=true', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'Intro to MCP', slug: null } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await updateItemTool.handler(ctx, {
      collection: 'articles',
      key: 1,
      verify: { title: 'Intro to MCP' },
      data: { slug: 'intro-to-mcp' },
      dry_run: true,
    });
    expect(result.structuredContent.ok).toBe(true);
  });

  it('update_item without verify is allowed when requireVerify=false', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'Intro to MCP', slug: null } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext({ config: makeConfig({ mutationRequireVerify: false }) });
    const result = await updateItemTool.handler(ctx, {
      collection: 'articles',
      key: 1,
      data: { slug: 'intro-to-mcp' },
      dry_run: true,
    });
    expect(result.structuredContent.ok).toBe(true);
  });

  it('update_items_same_data is refused when requireVerify=true', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles': { body: { data: [{ id: 1, title: 'A' }, { id: 2, title: 'B' }] } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    await expectErrorCode(
      () => updateItemsSameDataTool.handler(ctx, {
        collection: 'articles',
        keys: [1, 2],
        data: { slug: 'shared' },
        dry_run: true,
      }),
      'VERIFY_REQUIRED',
    );
  });

  it('update_items_same_data works when requireVerify=false', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles': { body: { data: [{ id: 1, title: 'A' }, { id: 2, title: 'B' }] } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext({ config: makeConfig({ mutationRequireVerify: false }) });
    const result = await updateItemsSameDataTool.handler(ctx, {
      collection: 'articles',
      keys: [1, 2],
      data: { slug: 'shared' },
      dry_run: true,
    });
    expect(result.structuredContent.ok).toBe(true);
  });

  it('batch_update_items per-item verify missing → that item fails with VERIFY_REQUIRED', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'Intro to MCP', slug: null } } },
      '/items/articles/2': { body: { data: { id: 2, title: 'Directus Deep Dive', slug: null } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await batchUpdateItemsTool.handler(ctx, {
      collection: 'articles',
      items: [
        { key: 1, verify: { title: 'Intro to MCP' }, data: { slug: 'a' } },
        { key: 2, /* no verify */ data: { slug: 'b' } },
      ],
      dry_run: true,
      fail_fast: false,
    });
    expect(result.structuredContent.ok).toBe(false);
    expect(result.structuredContent.summary).toEqual({ total: 2, ok: 1, failed: 1, dryRun: true, aborted: false });
  });
});

describe('all-or-nothing preflight (batch_update_items apply)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('apply (dry_run=false) with one failing item → ABORTS entire batch, zero writes', async () => {
    // Item 1: verify passes. Item 2: verify FAILS (title mismatch).
    // In all-or-nothing mode: item 1 should NOT be written either.
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'Intro to MCP', slug: null } } },
      '/items/articles/2': { body: { data: { id: 2, title: 'WRONG TITLE', slug: null } } },
    });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await batchUpdateItemsTool.handler(ctx, {
      collection: 'articles',
      items: [
        { key: 1, verify: { title: 'Intro to MCP' }, data: { slug: 'a' } },
        { key: 2, verify: { title: 'Directus Deep Dive' }, data: { slug: 'b' } },
      ],
      dry_run: false,
      // allow_partial_apply defaults to false → all-or-nothing
    });

    expect(result.structuredContent.summary.aborted).toBe(true);
    expect(result.structuredContent.summary.ok).toBe(0);
    expect(result.structuredContent.summary.failed).toBe(2);
    expect(result.structuredContent.summary.dryRun).toBe(false);
    expect(result.structuredContent.summary.abortReason).toMatch(/VERIFY_FAILED/);

    // CRITICAL: no PATCH should have been issued to Directus.
    const patchCalls = spy.mock.calls.filter((c) => (c[1] as RequestInit)?.method === 'PATCH');
    expect(patchCalls.length).toBe(0);
  });

  it('apply with allow_partial_apply=true → writes successful items, reports failures', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'Intro to MCP', slug: null } } },
      '/items/articles/2': { body: { data: { id: 2, title: 'WRONG TITLE', slug: null } } },
    });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await batchUpdateItemsTool.handler(ctx, {
      collection: 'articles',
      items: [
        { key: 1, verify: { title: 'Intro to MCP' }, data: { slug: 'a' } },
        { key: 2, verify: { title: 'Directus Deep Dive' }, data: { slug: 'b' } },
      ],
      dry_run: false,
      allow_partial_apply: true,
    });

    expect(result.structuredContent.summary.aborted).toBe(false);
    expect(result.structuredContent.summary.ok).toBe(1);
    expect(result.structuredContent.summary.failed).toBe(1);

    const patchCalls = spy.mock.calls.filter((c) => (c[1] as RequestInit)?.method === 'PATCH');
    expect(patchCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('apply with all items valid → writes all, not aborted', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'Intro to MCP', slug: null } } },
      '/items/articles/2': { body: { data: { id: 2, title: 'Directus Deep Dive', slug: null } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await batchUpdateItemsTool.handler(ctx, {
      collection: 'articles',
      items: [
        { key: 1, verify: { title: 'Intro to MCP' }, data: { slug: 'a' } },
        { key: 2, verify: { title: 'Directus Deep Dive' }, data: { slug: 'b' } },
      ],
      dry_run: false,
    });

    expect(result.structuredContent.summary.aborted).toBe(false);
    expect(result.structuredContent.summary.ok).toBe(2);
    expect(result.structuredContent.summary.failed).toBe(0);
  });

  it('dry_run=true does NOT run preflight (just per-item dry-run)', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'Intro to MCP', slug: null } } },
      '/items/articles/2': { body: { data: { id: 2, title: 'WRONG', slug: null } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await batchUpdateItemsTool.handler(ctx, {
      collection: 'articles',
      items: [
        { key: 1, verify: { title: 'Intro to MCP' }, data: { slug: 'a' } },
        { key: 2, verify: { title: 'Directus Deep Dive' }, data: { slug: 'b' } },
      ],
      dry_run: true,
    });

    expect(result.structuredContent.summary.aborted).toBe(false);
    expect(result.structuredContent.summary.ok).toBe(1);
    expect(result.structuredContent.summary.failed).toBe(1);
    expect(result.structuredContent.summary.dryRun).toBe(true);
  });
});

describe('all-or-nothing preflight (create_items apply)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('apply with one item missing required field → ABORTS entire batch, zero creates', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
    });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext({ config: makeConfig({ mutationRequireVerify: false }) });
    const result = await createItemsTool.handler(ctx, {
      collection: 'articles',
      items: [
        { data: { title: 'Article 1' } },
        { data: { slug: 'no-title' } }, // INVALID: title required, missing
      ],
      dry_run: false,
    });

    expect(result.structuredContent.summary.aborted).toBe(true);
    expect(result.structuredContent.summary.ok).toBe(0);
    expect(result.structuredContent.summary.failed).toBe(2);
    expect(result.structuredContent.summary.abortReason).toMatch(/REQUIRED_FIELD_MISSING/);

    const postCalls = spy.mock.calls.filter((c) => (c[1] as RequestInit)?.method === 'POST');
    expect(postCalls.length).toBe(0);
  });

  it('apply with all valid items → creates all', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles': { body: { data: [{ id: 1 }, { id: 2 }] } },
    });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext({ config: makeConfig({ mutationRequireVerify: false }) });
    const result = await createItemsTool.handler(ctx, {
      collection: 'articles',
      items: [
        { data: { title: 'Article 1' } },
        { data: { title: 'Article 2' } },
      ],
      dry_run: false,
    });

    expect(result.structuredContent.summary.aborted).toBe(false);
    expect(result.structuredContent.summary.ok).toBe(2);
    expect(result.structuredContent.summary.failed).toBe(0);

    const postCalls = spy.mock.calls.filter((c) => (c[1] as RequestInit)?.method === 'POST');
    expect(postCalls.length).toBe(2);
  });

  it('apply with allow_partial_apply=true → creates valid items, reports failures', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles': { body: { data: { id: 1 } } },
    });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext({ config: makeConfig({ mutationRequireVerify: false }) });
    const result = await createItemsTool.handler(ctx, {
      collection: 'articles',
      items: [
        { data: { title: 'Article 1' } },
        { data: { slug: 'no-title' } }, // invalid
      ],
      dry_run: false,
      allow_partial_apply: true,
    });

    expect(result.structuredContent.summary.aborted).toBe(false);
    expect(result.structuredContent.summary.ok).toBe(1);
    expect(result.structuredContent.summary.failed).toBe(1);

    const postCalls = spy.mock.calls.filter((c) => (c[1] as RequestInit)?.method === 'POST');
    expect(postCalls.length).toBe(1);
  });
});

describe('content.text contains real result data (not just label)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('schema_detail: content.text contains collection name, primary key, field lines', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await schemaDetailTool.handler(ctx, { collections: ['articles'] });
    const text = result.content[0]!.text;
    expect(text).toContain('Collection: articles');
    expect(text).toContain('Primary key: id');
    expect(text).toContain('Fields:');
    expect(text).toContain('- id:');
    expect(text).toContain('primary');
    expect(text).toContain('- title:');
    expect(text).toContain('required');
  });

  it('read_items: content.text contains collection, count, query, data rows', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles': {
        body: {
          data: [
            { id: 1, title: 'Intro to MCP' },
            { id: 2, title: 'Directus Deep Dive' },
          ],
        },
      },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await readItemsTool.handler(ctx, {
      collection: 'articles',
      query: { fields: ['id', 'title'], limit: 10 },
    });
    const text = result.content[0]!.text;
    expect(text).toContain('Collection: articles');
    expect(text).toContain('Count: 2');
    expect(text).toContain('Query:');
    expect(text).toContain('[0]');
    expect(text).toContain('"id":1');
    expect(text).toContain('"title":"Intro to MCP"');
  });

  it('read_items empty result: content.text says "0 items returned"', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles': { body: { data: [] } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await readItemsTool.handler(ctx, {
      collection: 'articles',
      query: { fields: ['id'], limit: 10 },
    });
    const text = result.content[0]!.text;
    expect(text).toContain('Count: 0');
    expect(text).toContain('(0 items returned)');
  });

  it('update_item dry-run: content.text contains before/after/diff', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'Intro to MCP', slug: null } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await updateItemTool.handler(ctx, {
      collection: 'articles',
      key: 1,
      verify: { title: 'Intro to MCP' },
      data: { slug: 'intro-to-mcp' },
      dry_run: true,
    });
    const text = result.content[0]!.text;
    expect(text).toContain('DRY-RUN UPDATE articles — OK (dryRun=true)');
    expect(text).toContain('Before:');
    expect(text).toContain('After:');
    expect(text).toContain('Diff (changed):');
    expect(text).toContain('slug:');
  });

  it('batch_update_items aborted: content.text contains ABORTED + abortReason', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'Intro to MCP', slug: null } } },
      '/items/articles/2': { body: { data: { id: 2, title: 'WRONG', slug: null } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await batchUpdateItemsTool.handler(ctx, {
      collection: 'articles',
      items: [
        { key: 1, verify: { title: 'Intro to MCP' }, data: { slug: 'a' } },
        { key: 2, verify: { title: 'Directus Deep Dive' }, data: { slug: 'b' } },
      ],
      dry_run: false,
    });
    const text = result.content[0]!.text;
    expect(text).toContain('ABORTED');
    expect(text).toContain('Abort reason:');
    expect(text).toContain('VERIFY_FAILED');
  });

  it('schema_overview: content.text contains collection list with pk', async () => {
    const fetchMock = mockFetch({
      '/collections': { body: collectionsListResponse },
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await schemaOverviewTool.handler(ctx, { include_system: false });
    const text = result.content[0]!.text;
    expect(text).toContain('Collections (');
    expect(text).toContain('articles');
    expect(text).toContain('pk=id');
  });

  it('create_item dry-run: content.text contains CREATE + dryRun + after', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await createItemTool.handler(ctx, {
      collection: 'articles',
      data: { title: 'New Article' },
      dry_run: true,
    });
    const text = result.content[0]!.text;
    expect(text).toContain('CREATE articles');
    expect(text).toContain('dryRun=true');
  });
});
