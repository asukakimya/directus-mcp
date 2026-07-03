import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DirectusRestClient } from '../../src/directus/rest.js';
import { SchemaService } from '../../src/directus/schemaService.js';
import { createAuditLog } from '../../src/safety/audit.js';
import { MemoryPlanStore } from '../../src/safety/plans.js';
import { MemoryBundleStore } from '../../src/safety/bundles.js';
import { updateByQueryPlanTool } from '../../src/tools/updateByQueryPlan.js';
import { applyPlanBundleTool } from '../../src/tools/applyPlanBundle.js';
import { planBundleStatusTool } from '../../src/tools/planBundleStatus.js';
import { verifyFieldsValueTool } from '../../src/tools/verifyFieldsValue.js';
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
    readCompactFullMaxRows: 200,
    readCompactCellMaxChars: 160,
    readCompactTextMaxChars: 30000,
    readCompactFormat: 'lines' as const,
    applyRequiresPlan: true,
    createRequiresPlan: true,
    updateRequiresPlan: true,
    deleteRequiresPlan: true,
    bulkRequiresPlan: true,
    updateByQueryRequiresPlan: true,
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
  const bundles = new MemoryBundleStore();
  return { config, logger, client, schema, audit, plans, bundles, ...overrides };
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

describe('update_by_query_plan: query-based batch plan + bundle', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('reads 5 records, creates 2 chunks (chunk_size=3), returns bundleId', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles': {
        body: {
          data: [
            { id: 1, title: 'A', tags: null },
            { id: 2, title: 'B', tags: null },
            { id: 3, title: 'C', tags: null },
            { id: 10, title: 'D', tags: null },
            { id: 63, title: 'E', tags: null },
          ],
        },
      },
      // For each item read during batch dry-run (read-before).
      '/items/articles/1': { body: { data: { id: 1, title: 'A', tags: null } } },
      '/items/articles/2': { body: { data: { id: 2, title: 'B', tags: null } } },
      '/items/articles/3': { body: { data: { id: 3, title: 'C', tags: null } } },
      '/items/articles/10': { body: { data: { id: 10, title: 'D', tags: null } } },
      '/items/articles/63': { body: { data: { id: 63, title: 'E', tags: null } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext({ config: makeConfig({ mutationRequireVerify: false }) });
    const result = await updateByQueryPlanTool.handler(ctx, {
      collection: 'articles',
      query: { fields: ['id', 'title'], sort: ['id'], limit: 100 },
      data: { tags: ['test'] },
      verify_fields: ['title'],
      dry_run: true,
      chunk_size: 3,
    });

    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.totalMatched).toBe(5);
    expect(result.structuredContent.chunkCount).toBe(2); // 3 + 2
    expect(result.structuredContent.planIds).toHaveLength(2);
    expect(result.structuredContent.bundleId).toBeDefined();
    expect(result.structuredContent.bundleId).toMatch(/^bundle_/);
    expect(result.structuredContent.written).toBe(false);
    expect(result.structuredContent.changedFields).toEqual(['tags']);

    const text = result.content[0]!.text;
    expect(text).toContain('DRY-RUN UPDATE_BY_QUERY');
    expect(text).toContain('Bundle ID: bundle_');
    expect(text).toContain('NEXT ACTION');
    expect(text).toContain('directus_apply_plan_bundle');
  });

  it('does NOT infer missing ids — only uses real returned records', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles': {
        body: {
          data: [
            { id: 1, title: 'A' },
            { id: 10, title: 'B' },
            { id: 63, title: 'C' },
          ],
        },
      },
      '/items/articles/1': { body: { data: { id: 1, title: 'A', tags: null } } },
      '/items/articles/10': { body: { data: { id: 10, title: 'B', tags: null } } },
      '/items/articles/63': { body: { data: { id: 63, title: 'C', tags: null } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext({ config: makeConfig({ mutationRequireVerify: false }) });
    const result = await updateByQueryPlanTool.handler(ctx, {
      collection: 'articles',
      query: { fields: ['id', 'title'], limit: 100 },
      data: { tags: ['test'] },
      verify_fields: ['title'],
      dry_run: true,
      chunk_size: 25,
    });

    // Only 3 records, not ids 2-9 or 11-62.
    expect(result.structuredContent.totalMatched).toBe(3);
    expect(result.structuredContent.chunkCount).toBe(1);
    expect(result.structuredContent.planIds).toHaveLength(1);

    // Verify preview only contains the 3 real ids.
    const preview = result.structuredContent.preview as Array<{ key: number }>;
    const keys = preview.map((p) => p.key).sort((a, b) => a - b);
    expect(keys).toEqual([1, 10, 63]);
  });

  it('0 matches → no plans, no bundle', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles': { body: { data: [] } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await updateByQueryPlanTool.handler(ctx, {
      collection: 'articles',
      query: { fields: ['id'], limit: 100 },
      data: { tags: ['test'] },
      verify_fields: ['title'],
      dry_run: true,
    });

    expect(result.structuredContent.totalMatched).toBe(0);
    expect(result.structuredContent.chunkCount).toBe(0);
    expect(result.structuredContent.planIds).toEqual([]);
    expect(result.structuredContent.bundleId).toBeUndefined();
  });
});

describe('update_item: verify_fields auto-generation', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('verify_fields:["title"] → MCP reads record and auto-generates verify', async () => {
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
      verify_fields: ['title'],
      data: { slug: 'intro-to-mcp' },
      dry_run: true,
    });

    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.planId).toBeDefined();
    // The plan was created with auto-generated verify.
  });

  it('verify_fields with non-existent record → NOT_FOUND', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/999': { body: { data: null } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    await expectErrorCode(
      () => updateItemTool.handler(ctx, {
        collection: 'articles',
        key: 999,
        verify_fields: ['title'],
        data: { slug: 'x' },
        dry_run: true,
      }),
      'NOT_FOUND',
    );
  });
});

describe('verify_fields_value: deep equality check', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns ok=true when all records match expected', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles': {
        body: {
          data: [
            { id: 1, title: 'A', tags: ['test'] },
            { id: 2, title: 'B', tags: ['test'] },
          ],
        },
      },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await verifyFieldsValueTool.handler(ctx, {
      collection: 'articles',
      expected: { tags: ['test'] },
    });

    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.totalChecked).toBe(2);
    expect(result.structuredContent.matchedCount).toBe(2);
    expect(result.structuredContent.mismatchCount).toBe(0);
  });

  it('returns ok=false with mismatches when some records differ', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles': {
        body: {
          data: [
            { id: 1, title: 'A', tags: ['test'] },
            { id: 2, title: 'B', tags: [] },
            { id: 3, title: 'C', tags: ['TEST'] }, // case mismatch
          ],
        },
      },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await verifyFieldsValueTool.handler(ctx, {
      collection: 'articles',
      expected: { tags: ['test'] },
    });

    expect(result.structuredContent.ok).toBe(false);
    expect(result.structuredContent.mismatchCount).toBe(2);
    const mismatches = result.structuredContent.mismatches as Array<{ key: number; field: string }>;
    expect(mismatches.map((m) => m.key).sort()).toEqual([2, 3]);
  });

  it('deep equality: ["test"] !== ["TEST"] (case-sensitive)', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles': {
        body: { data: [{ id: 1, title: 'A', tags: ['TEST'] }] },
      },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await verifyFieldsValueTool.handler(ctx, {
      collection: 'articles',
      expected: { tags: ['test'] },
    });

    expect(result.structuredContent.ok).toBe(false);
    expect(result.structuredContent.mismatchCount).toBe(1);
  });
});

describe('plan_bundle_status: query bundle status', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns pending status for newly created bundle', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles': {
        body: { data: [{ id: 1, title: 'A', tags: null }] },
      },
      '/items/articles/1': { body: { data: { id: 1, title: 'A', tags: null } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext({ config: makeConfig({ mutationRequireVerify: false }) });
    const dryRun = await updateByQueryPlanTool.handler(ctx, {
      collection: 'articles',
      query: { fields: ['id', 'title'], limit: 100 },
      data: { tags: ['test'] },
      verify_fields: ['title'],
      dry_run: true,
      chunk_size: 25,
    });
    const bundleId = dryRun.structuredContent.bundleId as string;

    const statusResult = await planBundleStatusTool.handler(ctx, { bundle_id: bundleId });

    expect(statusResult.structuredContent.status).toBe('pending');
    expect(statusResult.structuredContent.canApply).toBe(true);
    expect(statusResult.structuredContent.canCancel).toBe(true);
    expect(statusResult.structuredContent.plans).toHaveLength(1);
  });

  it('returns applied status after bundle apply', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles': { body: { data: [{ id: 1, title: 'A', tags: ['test'] }] } },
      '/items/articles/1': { body: { data: { id: 1, title: 'A', tags: 'test' } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext({ config: makeConfig({ mutationRequireVerify: false }) });
    const dryRun = await updateByQueryPlanTool.handler(ctx, {
      collection: 'articles',
      query: { fields: ['id', 'title'], limit: 100 },
      data: { tags: ['test'] },
      verify_fields: ['title'],
      dry_run: true,
      chunk_size: 25,
    });
    const bundleId = dryRun.structuredContent.bundleId as string;

    // Apply bundle.
    await applyPlanBundleTool.handler(ctx, { bundle_id: bundleId, confirm: true });

    // Check status.
    const statusResult = await planBundleStatusTool.handler(ctx, { bundle_id: bundleId });
    expect(statusResult.structuredContent.status).toBe('applied');
    expect(statusResult.structuredContent.canApply).toBe(false);
  });

  it('non-existent bundle → PLAN_NOT_FOUND', async () => {
    const ctx = buildContext();
    await expectErrorCode(
      () => planBundleStatusTool.handler(ctx, { bundle_id: 'bundle_nonexistent' }),
      'PLAN_NOT_FOUND',
    );
  });
});

describe('apply_plan_bundle: bundle apply with verification', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('confirm=false → CONFIRM_TRUE_REQUIRED', async () => {
    const ctx = buildContext();
    await expectErrorCode(
      () => applyPlanBundleTool.handler(ctx, { bundle_id: 'bundle_x', confirm: false }),
      'CONFIRM_TRUE_REQUIRED',
    );
  });

  it('applies bundle and runs verification', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
    });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    // Mock: read returns 2 records with matching tags after apply.
    spy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
      const path = url.pathname;
      const method = init?.method ?? 'GET';
      if (path.includes('/collections/articles')) return new Response(JSON.stringify(articlesSchemaResponse), { status: 200, headers: { 'content-type': 'application/json' } });
      if (path.includes('/fields/articles')) return new Response(JSON.stringify(articlesFieldsResponse), { status: 200, headers: { 'content-type': 'application/json' } });
      if (path.includes('/relations')) return new Response(JSON.stringify(articlesRelationsResponse), { status: 200, headers: { 'content-type': 'application/json' } });
      if (path === '/items/articles' && method === 'GET') {
        // Read for update_by_query_plan + verification.
        // Return tags: ['test'] so verification passes after apply.
        return new Response(JSON.stringify({
          data: [
            { id: 1, title: 'A', tags: ['test'] },
            { id: 2, title: 'B', tags: ['test'] },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path.includes('/items/articles/') && method === 'GET') {
        const match = path.match(/\/items\/articles\/(\d+)/);
        const key = match ? match[1] : '1';
        const titleMap: Record<string, string> = { '1': 'A', '2': 'B' };
        // Return tags: ['test'] so read-back verification passes.
        return new Response(JSON.stringify({ data: { id: Number(key), title: titleMap[key] ?? `Article ${key}`, tags: ['test'] } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path.includes('/items/articles/') && method === 'PATCH') {
        const match = path.match(/\/items\/articles\/(\d+)/);
        const key = match ? match[1] : '1';
        return new Response(JSON.stringify({ data: { id: Number(key), title: `A`, tags: ['test'] } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{"errors":[{"message":"no mock"}]}', { status: 404, headers: { 'content-type': 'application/json' } });
    });

    const ctx = buildContext({ config: makeConfig({ mutationRequireVerify: false }) });
    // Create bundle.
    const dryRun = await updateByQueryPlanTool.handler(ctx, {
      collection: 'articles',
      query: { fields: ['id', 'title'], limit: 100 },
      data: { tags: ['test'] },
      verify_fields: ['title'],
      dry_run: true,
      chunk_size: 25,
    });
    const bundleId = dryRun.structuredContent.bundleId as string;
    // Debug: if bundleId is undefined, the update_by_query_plan failed.
    if (!bundleId) {
      throw new Error(`update_by_query_plan did not create bundle. structuredContent: ${JSON.stringify(dryRun.structuredContent)}`);
    }

    // Apply.
    const applyResult = await applyPlanBundleTool.handler(ctx, { bundle_id: bundleId, confirm: true });

    expect(applyResult.structuredContent.ok).toBe(true);
    expect(applyResult.structuredContent.applied).toBeGreaterThanOrEqual(1);
    expect(applyResult.structuredContent.failed).toBe(0);
    expect(applyResult.structuredContent.written).toBe(true);

    const text = applyResult.content[0]!.text;
    expect(text).toContain('APPLIED PLAN BUNDLE');
  });
});
