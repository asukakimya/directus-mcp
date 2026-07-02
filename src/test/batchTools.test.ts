import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DirectusRestClient } from '../../src/directus/rest.js';
import { SchemaService } from '../../src/directus/schemaService.js';
import { createAuditLog } from '../../src/safety/audit.js';
import { MemoryPlanStore } from '../../src/safety/plans.js';
import { applyPlansTool } from '../../src/tools/applyPlans.js';
import { cancelPlansTool } from '../../src/tools/cancelPlans.js';
import { verifyFieldsEmptyTool } from '../../src/tools/verifyFieldsEmpty.js';
import { updateItemTool } from '../../src/tools/updateItem.js';
import type { ToolContext } from '../../src/mcp/server.js';
import type { AppConfig } from '../../src/config.js';
import { pino } from 'pino';
import { expectErrorCode } from './helpers.js';

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    directusUrl: 'https://example.com',
    directusToken: 't',
    mcpTransport: 'stdio',
    mcpHttpPort: 3333,
    mcpRequireAuth: true,
    mcpAuthToken: 'test-token',
    mcpEndpointPath: '/mcp',
    mcpBindHost: '0.0.0.0',
    mcpAllowedOrigins: [],
    mcpAllowedHosts: [],
    allowedCollections: new Set<string>(['articles']),
    deniedCollectionPrefixes: ['directus_'],
    allowDelete: false,
    allowSchemaWrite: false,
    mutationDryRunDefault: true,
    mutationRequireVerify: false,
    mutationMaxBatchSize: 100,
    readDefaultLimit: 50,
    readMaxLimit: 500,
    allowWildcardFields: false,
    schemaCacheTtlSeconds: 300,
    verifyCaseInsensitive: false,
    schemaTextMaxFields: 80,
    readTextMaxRows: 10,
    readTextMaxChars: 12000,
    applyRequiresPlan: true,
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
    {
      collection: 'articles',
      field: 'tags',
      type: 'json',
      schema: { is_primary_key: false, is_nullable: true },
      meta: { interface: 'tags', readonly: false, special: null, options: null, hidden: false, required: false },
    },
  ],
};

const articlesRelationsResponse = { data: [] };

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

describe('apply_plans: batch plan apply', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('applies 3 plans in sequence, all OK', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
    });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    // Custom mock: return record with slug matching what we intend to write,
    // so read-back verification passes.
    spy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
      const path = url.pathname;
      const method = init?.method ?? 'GET';

      if (path.includes('/collections/articles')) {
        return new Response(JSON.stringify(articlesSchemaResponse), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path.includes('/fields/articles')) {
        return new Response(JSON.stringify(articlesFieldsResponse), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path.includes('/relations')) {
        return new Response(JSON.stringify(articlesRelationsResponse), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path.includes('/items/articles/')) {
        // Extract key from path.
        const match = path.match(/\/items\/articles\/(\d+)/);
        const key = match ? match[1] : '1';
        // Return record with slug matching the intended write so read-back passes.
        return new Response(
          JSON.stringify({ data: { id: Number(key), title: `Article ${key}`, slug: `slug-${key}` } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{"errors":[{"message":"no mock"}]}', { status: 404, headers: { 'content-type': 'application/json' } });
    });

    const ctx = buildContext();
    // Create 3 plans via dry-run.
    const planIds: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const dryRun = await updateItemTool.handler(ctx, {
        collection: 'articles',
        key: i,
        data: { slug: `slug-${i}` },
        dry_run: true,
      });
      planIds.push(dryRun.structuredContent.planId as string);
    }

    // Apply all 3 via apply_plans.
    const result = await applyPlansTool.handler(ctx, {
      plan_ids: planIds,
      confirm: true,
      stop_on_error: true,
    });

    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.total).toBe(3);
    expect(result.structuredContent.applied).toBe(3);
    expect(result.structuredContent.failed).toBe(0);
    expect(result.structuredContent.stopped).toBe(false);
    expect(result.structuredContent.allReadBackOk).toBe(true);
  });

  it('plan_ids_json as string array is accepted', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'A', slug: 'a' } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const dryRun = await updateItemTool.handler(ctx, {
      collection: 'articles',
      key: 1,
      data: { slug: 'a' },
      dry_run: true,
    });
    const planId = dryRun.structuredContent.planId as string;

    const result = await applyPlansTool.handler(ctx, {
      plan_ids_json: JSON.stringify([planId]),
      confirm: true,
    });

    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.total).toBe(1);
  });

  it('confirm=false → CONFIRM_TRUE_REQUIRED', async () => {
    const ctx = buildContext();
    await expectErrorCode(
      () => applyPlansTool.handler(ctx, { plan_ids: ['plan_x'], confirm: false }),
      'CONFIRM_TRUE_REQUIRED',
    );
  });

  it('empty plan_ids → INVALID_DATA_TYPE', async () => {
    const ctx = buildContext();
    await expectErrorCode(
      () => applyPlansTool.handler(ctx, { plan_ids: [], confirm: true }),
      'INVALID_DATA_TYPE',
    );
  });

  it('stop_on_error=true stops at first failure', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'A', slug: 'a' } } },
      '/items/articles/2': { body: { data: { id: 2, title: 'B', slug: 'b' } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    // Plan 1: valid.
    const d1 = await updateItemTool.handler(ctx, {
      collection: 'articles', key: 1, data: { slug: 'a' }, dry_run: true,
    });
    // Plan 2: non-existent plan_id.
    const planIds = [d1.structuredContent.planId as string, 'plan_nonexistent'];

    const result = await applyPlansTool.handler(ctx, {
      plan_ids: planIds,
      confirm: true,
      stop_on_error: true,
    });

    // First plan applied, second fails, stops.
    expect(result.structuredContent.stopped).toBe(true);
    expect(result.structuredContent.applied).toBe(1);
    expect(result.structuredContent.failed).toBe(1);
  });

  it('stop_on_error=false continues after failure', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'A', slug: 'a' } } },
      '/items/articles/3': { body: { data: { id: 3, title: 'C', slug: 'c' } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const d1 = await updateItemTool.handler(ctx, {
      collection: 'articles', key: 1, data: { slug: 'a' }, dry_run: true,
    });
    const d3 = await updateItemTool.handler(ctx, {
      collection: 'articles', key: 3, data: { slug: 'c' }, dry_run: true,
    });
    // Plan 2 is non-existent → fails. Plans 1 and 3 succeed.
    const planIds = [d1.structuredContent.planId as string, 'plan_nonexistent', d3.structuredContent.planId as string];

    const result = await applyPlansTool.handler(ctx, {
      plan_ids: planIds,
      confirm: true,
      stop_on_error: false,
    });

    expect(result.structuredContent.stopped).toBe(false);
    expect(result.structuredContent.applied).toBe(2);
    expect(result.structuredContent.failed).toBe(1);
  });
});

describe('cancel_plans: batch cancel', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('cancels 3 pending plans', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'A', slug: null } } },
      '/items/articles/2': { body: { data: { id: 2, title: 'B', slug: null } } },
      '/items/articles/3': { body: { data: { id: 3, title: 'C', slug: null } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const planIds: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const d = await updateItemTool.handler(ctx, {
        collection: 'articles', key: i, data: { slug: `s${i}` }, dry_run: true,
      });
      planIds.push(d.structuredContent.planId as string);
    }

    const result = await cancelPlansTool.handler(ctx, { plan_ids: planIds });

    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.cancelled).toBe(3);
    expect(result.structuredContent.failed).toBe(0);
  });

  it('non-existent plan_id is reported as failure', async () => {
    const ctx = buildContext();
    const result = await cancelPlansTool.handler(ctx, { plan_ids: ['plan_nonexistent'] });
    expect(result.structuredContent.ok).toBe(false);
    expect(result.structuredContent.cancelled).toBe(0);
    expect(result.structuredContent.failed).toBe(1);
  });

  it('plan_ids_json as JSON string array is accepted', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'A', slug: null } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const d = await updateItemTool.handler(ctx, {
      collection: 'articles', key: 1, data: { slug: 'a' }, dry_run: true,
    });

    const result = await cancelPlansTool.handler(ctx, {
      plan_ids_json: JSON.stringify([d.structuredContent.planId]),
    });

    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.cancelled).toBe(1);
  });
});

describe('verify_fields_empty: post-apply verification', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns ok=true when all fields are empty (null)', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles': {
        body: {
          data: [
            { id: 1, title: 'A', tags: null },
            { id: 2, title: 'B', tags: null },
          ],
        },
      },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await verifyFieldsEmptyTool.handler(ctx, {
      collection: 'articles',
      fields: ['tags'],
    });

    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.totalChecked).toBe(2);
    expect(result.structuredContent.nonEmptyCount).toBe(0);
  });

  it('returns ok=false and lists non-empty records when tags has values', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles': {
        body: {
          data: [
            { id: 1, title: 'A', tags: null },
            { id: 2, title: 'B', tags: ['urgent', 'review'] },
            { id: 3, title: 'C', tags: [] },
            { id: 4, title: 'D', tags: {} },
            { id: 5, title: 'E', tags: '' },
            { id: 6, title: 'F', tags: '   ' },
          ],
        },
      },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await verifyFieldsEmptyTool.handler(ctx, {
      collection: 'articles',
      fields: ['tags'],
    });

    expect(result.structuredContent.ok).toBe(false);
    expect(result.structuredContent.totalChecked).toBe(6);
    // Only record 2 has a non-empty tags array. Records 3,4,5,6 are all "empty".
    expect(result.structuredContent.nonEmptyCount).toBe(1);
    const nonEmpty = result.structuredContent.nonEmpty as Array<Record<string, unknown>>;
    expect(nonEmpty[0]!.id).toBe(2);
    expect(nonEmpty[0]!.tags).toEqual(['urgent', 'review']);
  });

  it('checks multiple fields', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles': {
        body: {
          data: [
            { id: 1, title: 'A', slug: null, tags: ['x'] },
            { id: 2, title: 'B', slug: 'b', tags: null },
          ],
        },
      },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await verifyFieldsEmptyTool.handler(ctx, {
      collection: 'articles',
      fields: ['slug', 'tags'],
    });

    expect(result.structuredContent.ok).toBe(false);
    expect(result.structuredContent.nonEmptyCount).toBe(2);
  });

  it('content text shows "VERIFY FIELDS EMPTY — OK" when clean', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles': {
        body: { data: [{ id: 1, title: 'A', tags: null }] },
      },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await verifyFieldsEmptyTool.handler(ctx, {
      collection: 'articles',
      fields: ['tags'],
    });

    expect(result.content[0]!.text).toContain('VERIFY FIELDS EMPTY — OK');
  });

  it('content text shows "NON-EMPTY FOUND" when records remain', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles': {
        body: { data: [{ id: 1, title: 'A', tags: ['x'] }] },
      },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await verifyFieldsEmptyTool.handler(ctx, {
      collection: 'articles',
      fields: ['tags'],
    });

    expect(result.content[0]!.text).toContain('NON-EMPTY FOUND');
    expect(result.content[0]!.text).toContain('Non-empty records: 1');
  });
});

describe('batch tool schema tolerance (LibreChat compatibility)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('update_items_same_data accepts keys_json as array (not string)', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles': { body: { data: [{ id: 1, title: 'A' }, { id: 2, title: 'B' }] } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext({ config: makeConfig({ mutationRequireVerify: false }) });
    // keys_json as ARRAY (not string) — LibreChat sometimes does this.
    const result = await (await import('../../src/tools/updateItemsSameData.js')).updateItemsSameDataTool.handler(ctx, {
      collection: 'articles',
      keys_json: [1, 2],
      data: { slug: 'shared' },
      dry_run: true,
    });

    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.planId).toBeDefined();
  });

  it('update_items_same_data accepts data_json as object (not string)', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles': { body: { data: [{ id: 1, title: 'A' }] } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext({ config: makeConfig({ mutationRequireVerify: false }) });
    const result = await (await import('../../src/tools/updateItemsSameData.js')).updateItemsSameDataTool.handler(ctx, {
      collection: 'articles',
      keys: [1],
      data_json: { slug: 'x' }, // object, not string
      dry_run: true,
    });

    expect(result.structuredContent.ok).toBe(true);
  });

  it('batch_update_items accepts items_json as array (not string)', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'A', slug: null } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext({ config: makeConfig({ mutationRequireVerify: false }) });
    // items_json as ARRAY (not string) — LibreChat sometimes does this.
    const result = await (await import('../../src/tools/batchUpdateItems.js')).batchUpdateItemsTool.handler(ctx, {
      collection: 'articles',
      items_json: [{ key: 1, data: { slug: 'x' } }],
      dry_run: true,
    });

    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.planId).toBeDefined();
  });

  it('create_items accepts items_json as array', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext({ config: makeConfig({ mutationRequireVerify: false }) });
    const result = await (await import('../../src/tools/createItems.js')).createItemsTool.handler(ctx, {
      collection: 'articles',
      items_json: [{ data: { title: 'New' } }],
      dry_run: true,
    });

    expect(result.structuredContent.ok).toBe(true);
  });
});

describe('verify_fields_empty: query.fields override protection', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('user-supplied query.fields is ignored — tool always uses its own fields list', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles': {
        body: {
          data: [
            { id: 1, title: 'A', tags: ['x'] },
          ],
        },
      },
    });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    // User tries to override fields with a different list.
    // Tool should ignore it and use ['id', 'tags'] (pk + requested).
    await verifyFieldsEmptyTool.handler(ctx, {
      collection: 'articles',
      fields: ['tags'],
      query: { fields: ['id', 'title'], limit: 5 },
    });

    // Check the URL that was called — fields should contain 'tags'.
    const calls = spy.mock.calls;
    const readUrl = calls.find(
      (c) => (c[1] as RequestInit)?.method === 'GET' && String((c[0] as URL | string)).includes('/items/articles'),
    );
    expect(readUrl).toBeDefined();
    const url = typeof readUrl![0] === 'string' ? readUrl![0] : (readUrl![0] as URL).toString();
    // fields should include 'tags' (our field), not just 'title'.
    expect(url).toContain('tags');
  });

  it('user-supplied limit is clamped to readMaxLimit', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles': { body: { data: [] } },
    });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext({ config: makeConfig({ readMaxLimit: 100 }) });
    await verifyFieldsEmptyTool.handler(ctx, {
      collection: 'articles',
      fields: ['tags'],
      query: { limit: 9999 },
    });

    const calls = spy.mock.calls;
    const readUrl = calls.find(
      (c) => (c[1] as RequestInit)?.method === 'GET' && String((c[0] as URL | string)).includes('/items/articles'),
    );
    const url = typeof readUrl![0] === 'string' ? readUrl![0] : (readUrl![0] as URL).toString();
    // limit should be clamped to 100, not 9999.
    expect(url).toContain('limit=100');
    expect(url).not.toContain('limit=9999');
  });
});

describe('apply_plans: readBackStatus tri-state', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('readBackStatus=ok when all plans have readBackOk=true', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
    });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    spy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
      const path = url.pathname;
      if (path.includes('/collections/articles')) return new Response(JSON.stringify(articlesSchemaResponse), { status: 200, headers: { 'content-type': 'application/json' } });
      if (path.includes('/fields/articles')) return new Response(JSON.stringify(articlesFieldsResponse), { status: 200, headers: { 'content-type': 'application/json' } });
      if (path.includes('/relations')) return new Response(JSON.stringify(articlesRelationsResponse), { status: 200, headers: { 'content-type': 'application/json' } });
      if (path.includes('/items/articles/')) {
        const match = path.match(/\/items\/articles\/(\d+)/);
        const key = match ? match[1] : '1';
        return new Response(JSON.stringify({ data: { id: Number(key), title: `A`, slug: `slug-${key}` } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{"errors":[{"message":"no mock"}]}', { status: 404, headers: { 'content-type': 'application/json' } });
    });

    const ctx = buildContext();
    const d1 = await updateItemTool.handler(ctx, { collection: 'articles', key: 1, data: { slug: 'slug-1' }, dry_run: true });
    const d2 = await updateItemTool.handler(ctx, { collection: 'articles', key: 2, data: { slug: 'slug-2' }, dry_run: true });

    const result = await applyPlansTool.handler(ctx, {
      plan_ids: [d1.structuredContent.planId as string, d2.structuredContent.planId as string],
      confirm: true,
    });

    expect(result.structuredContent.readBackStatus).toBe('ok');
    expect(result.structuredContent.allReadBackOk).toBe(true);
    expect(result.content[0]!.text).toContain('All read-back checks: OK');
  });

  it('readBackStatus=partial_or_not_verified when some plans have readBackOk=null', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'A', slug: 'slug-1' } } },
      '/items/articles': { body: { data: [{ id: 2, title: 'B' }, { id: 3, title: 'C' }] } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext({ config: makeConfig({ mutationRequireVerify: false }) });
    // Plan 1: update_item → readBackOk=true (mock returns matching slug)
    const d1 = await updateItemTool.handler(ctx, { collection: 'articles', key: 1, data: { slug: 'slug-1' }, dry_run: true });
    // Plan 2: update_items_same_data → readBackOk=null (bulk update doesn't verify)
    const { updateItemsSameDataTool } = await import('../../src/tools/updateItemsSameData.js');
    const d2 = await updateItemsSameDataTool.handler(ctx, {
      collection: 'articles',
      keys: [2, 3],
      data: { slug: 'shared' },
      dry_run: true,
    });

    const result = await applyPlansTool.handler(ctx, {
      plan_ids: [d1.structuredContent.planId as string, d2.structuredContent.planId as string],
      confirm: true,
    });

    expect(result.structuredContent.readBackStatus).toBe('partial_or_not_verified');
    expect(result.structuredContent.allReadBackOk).toBe(false);
    expect(result.content[0]!.text).toContain('PARTIAL / NOT VERIFIED');
  });

  it('readBackStatus=mismatch when at least one plan has readBackOk=false', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
    });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    let patchCount = 0;
    spy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
      const path = url.pathname;
      const method = init?.method ?? 'GET';
      if (path.includes('/collections/articles')) return new Response(JSON.stringify(articlesSchemaResponse), { status: 200, headers: { 'content-type': 'application/json' } });
      if (path.includes('/fields/articles')) return new Response(JSON.stringify(articlesFieldsResponse), { status: 200, headers: { 'content-type': 'application/json' } });
      if (path.includes('/relations')) return new Response(JSON.stringify(articlesRelationsResponse), { status: 200, headers: { 'content-type': 'application/json' } });
      if (path.includes('/items/articles/1') && method === 'PATCH') {
        patchCount++;
        return new Response(JSON.stringify({ data: { id: 1, title: 'A', slug: 'slug-1' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path.includes('/items/articles/1') && method === 'GET') {
        // After the PATCH happens, return CHANGED to trigger readback mismatch.
        // Before PATCH, return matching slug so verify/dry-run passes.
        const slug = patchCount > 0 ? 'CHANGED BY FLOW' : 'slug-1';
        return new Response(JSON.stringify({ data: { id: 1, title: 'A', slug } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{"errors":[{"message":"no mock"}]}', { status: 404, headers: { 'content-type': 'application/json' } });
    });

    const ctx = buildContext({ config: makeConfig({ mutationRequireVerify: false }) });
    const d1 = await updateItemTool.handler(ctx, { collection: 'articles', key: 1, data: { slug: 'slug-1' }, dry_run: true });

    const result = await applyPlansTool.handler(ctx, {
      plan_ids: [d1.structuredContent.planId as string],
      confirm: true,
    });

    expect(result.structuredContent.readBackStatus).toBe('mismatch');
    expect(result.structuredContent.allReadBackOk).toBe(false);
    expect(result.content[0]!.text).toContain('Read-back checks: MISMATCH');
  });
});
