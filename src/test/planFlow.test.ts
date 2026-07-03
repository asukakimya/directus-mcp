import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DirectusRestClient } from '../../src/directus/rest.js';
import { SchemaService } from '../../src/directus/schemaService.js';
import { createAuditLog } from '../../src/safety/audit.js';
import { MemoryPlanStore } from '../../src/safety/plans.js';
import { updateItemTool } from '../../src/tools/updateItem.js';
import { createItemTool } from '../../src/tools/createItem.js';
import { deleteItemsTool } from '../../src/tools/deleteItems.js';
import { batchUpdateItemsTool } from '../../src/tools/batchUpdateItems.js';
import { applyPlanTool } from '../../src/tools/applyPlan.js';
import { cancelPlanTool } from '../../src/tools/cancelPlan.js';
import type { ToolContext } from '../../src/mcp/server.js';
import type { AppConfig } from '../../src/config.js';
import { pino } from 'pino';
import { expectErrorCode } from './helpers.js';

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const applyRequiresPlan = overrides.applyRequiresPlan ?? true;
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
    applyRequiresPlan,
    createRequiresPlan: overrides.createRequiresPlan ?? applyRequiresPlan,
    updateRequiresPlan: overrides.updateRequiresPlan ?? applyRequiresPlan,
    deleteRequiresPlan: overrides.deleteRequiresPlan ?? applyRequiresPlan,
    bulkRequiresPlan: overrides.bulkRequiresPlan ?? applyRequiresPlan,
    updateByQueryRequiresPlan: overrides.updateByQueryRequiresPlan ?? true,
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

describe('Plan flow: dry-run → apply', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('dry-run creates a plan; no PATCH issued', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'Intro to MCP', slug: null } } },
    });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const result = await updateItemTool.handler(ctx, {
      collection: 'articles',
      key: 1,
      data: { slug: 'intro-to-mcp' },
      dry_run: true,
    });

    expect(result.structuredContent.dryRun).toBe(true);
    expect(result.structuredContent.written).toBe(false);
    expect(result.structuredContent.requiresApplyPlan).toBe(true);
    expect(result.structuredContent.planId).toMatch(/^plan_/);

    const text = result.content[0]!.text;
    expect(text).toContain('DRY-RUN');
    expect(text).toContain('NOT WRITTEN');
    expect(text).toContain('Plan ID: plan_');
    expect(text).toContain('directus_apply_plan');

    // No PATCH should have been issued (dry-run only).
    const patchCalls = spy.mock.calls.filter((c) => (c[1] as RequestInit)?.method === 'PATCH');
    expect(patchCalls.length).toBe(0);
  });

  it('apply_plan performs real PATCH + read-back verification', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'Intro to MCP', slug: 'intro-to-mcp' } } },
    });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    // 1. Dry-run to create plan.
    const dryRunResult = await updateItemTool.handler(ctx, {
      collection: 'articles',
      key: 1,
      data: { slug: 'intro-to-mcp' },
      dry_run: true,
    });
    const planId = dryRunResult.structuredContent.planId as string;

    // 2. Apply plan.
    const applyResult = await applyPlanTool.handler(ctx, {
      plan_id: planId,
      confirm: true,
    });

    expect(applyResult.structuredContent.applied).toBe(true);
    expect(applyResult.structuredContent.written).toBe(true);
    expect(applyResult.structuredContent.dryRun).toBe(false);
    expect(applyResult.structuredContent.readBackOk).toBe(true);

    const text = applyResult.content[0]!.text;
    expect(text).toContain('APPLIED');
    expect(text).toContain('written=true');
    expect(text).toContain('Read-back verification: OK');

    // At least one PATCH should have been issued (the real write).
    const patchCalls = spy.mock.calls.filter((c) => (c[1] as RequestInit)?.method === 'PATCH');
    expect(patchCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('second apply_plan → PLAN_ALREADY_APPLIED', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'Intro to MCP', slug: 'intro-to-mcp' } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const dryRunResult = await updateItemTool.handler(ctx, {
      collection: 'articles',
      key: 1,
      data: { slug: 'intro-to-mcp' },
      dry_run: true,
    });
    const planId = dryRunResult.structuredContent.planId as string;

    // First apply succeeds.
    await applyPlanTool.handler(ctx, { plan_id: planId, confirm: true });

    // Second apply → PLAN_ALREADY_APPLIED.
    await expectErrorCode(
      () => applyPlanTool.handler(ctx, { plan_id: planId, confirm: true }),
      'PLAN_ALREADY_APPLIED',
    );
  });

  it('apply_plan with confirm:false → CONFIRM_TRUE_REQUIRED', async () => {
    const ctx = buildContext();
    await expectErrorCode(
      () => applyPlanTool.handler(ctx, { plan_id: 'plan_nonexistent', confirm: false }),
      'CONFIRM_TRUE_REQUIRED',
    );
  });

  it('apply_plan with non-existent plan → PLAN_NOT_FOUND', async () => {
    const ctx = buildContext();
    await expectErrorCode(
      () => applyPlanTool.handler(ctx, { plan_id: 'plan_doesnotexist', confirm: true }),
      'PLAN_NOT_FOUND',
    );
  });

  it('CREATE_REQUIRES_PLAN=false allows direct create dry_run:false', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles': { body: { data: { id: 2, title: 'Created directly' } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext({ config: makeConfig({ createRequiresPlan: false }) });
    const result = await createItemTool.handler(ctx, {
      collection: 'articles',
      data: { title: 'Created directly' },
      dry_run: false,
    });

    expect(result.structuredContent.dryRun).toBe(false);
    expect(result.structuredContent.planId).toBeUndefined();
  });

  it('CREATE_REQUIRES_PLAN=true blocks direct create but still returns a dry-run plan', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext({ config: makeConfig({ createRequiresPlan: true }) });
    await expectErrorCode(
      () => createItemTool.handler(ctx, {
        collection: 'articles',
        data: { title: 'Needs approval' },
        dry_run: false,
      }),
      'APPLY_REQUIRES_PLAN',
    );

    const dryRunResult = await createItemTool.handler(ctx, {
      collection: 'articles',
      data: { title: 'Needs approval' },
      dry_run: true,
    });
    expect(dryRunResult.structuredContent.dryRun).toBe(true);
    expect(dryRunResult.structuredContent.planId).toEqual(expect.any(String));
  });

  it('UPDATE_REQUIRES_PLAN=true blocks direct update dry_run:false', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'Intro to MCP', slug: null } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext(); // updateRequiresPlan: true
    await expectErrorCode(
      () => updateItemTool.handler(ctx, {
        collection: 'articles',
        key: 1,
        data: { slug: 'intro-to-mcp' },
        dry_run: false,
      }),
      'APPLY_REQUIRES_PLAN',
    );
  });

  it('UPDATE_REQUIRES_PLAN=false allows direct update dry_run:false', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'Intro to MCP', slug: 'intro-to-mcp' } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext({ config: makeConfig({ updateRequiresPlan: false }) });
    const result = await updateItemTool.handler(ctx, {
      collection: 'articles',
      key: 1,
      data: { slug: 'intro-to-mcp' },
      dry_run: false,
    });
    expect(result.structuredContent.dryRun).toBe(false);
    // No planId when direct update is allowed and dry_run is false.
    expect(result.structuredContent.planId).toBeUndefined();
  });

  it('BULK_REQUIRES_PLAN=true blocks direct batch update dry_run:false', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext({ config: makeConfig({ bulkRequiresPlan: true }) });
    await expectErrorCode(
      () => batchUpdateItemsTool.handler(ctx, {
        collection: 'articles',
        items: [{ key: 1, data: { slug: 'bulk-change' } }],
        dry_run: false,
      }),
      'APPLY_REQUIRES_PLAN',
    );
  });

  it('DELETE_REQUIRES_PLAN=true blocks direct delete dry_run:false', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext({ config: makeConfig({ allowDelete: true, deleteRequiresPlan: true }) });
    await expectErrorCode(
      () => deleteItemsTool.handler(ctx, {
        collection: 'articles',
        keys: [1],
        confirm: 'DELETE articles:1',
        dry_run: false,
      }),
      'APPLY_REQUIRES_PLAN',
    );
  });

  it('cancel_plan marks pending plan as cancelled', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'Intro to MCP', slug: null } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext();
    const dryRunResult = await updateItemTool.handler(ctx, {
      collection: 'articles',
      key: 1,
      data: { slug: 'intro-to-mcp' },
      dry_run: true,
    });
    const planId = dryRunResult.structuredContent.planId as string;

    const cancelResult = await cancelPlanTool.handler(ctx, { plan_id: planId });
    expect(cancelResult.structuredContent.status).toBe('cancelled');

    // Applying a cancelled plan → PLAN_CANCELLED.
    await expectErrorCode(
      () => applyPlanTool.handler(ctx, { plan_id: planId, confirm: true }),
      'PLAN_CANCELLED',
    );
  });

  it('verify changed after dry-run → apply fails with VERIFY_FAILED (no write)', async () => {
    // First call (dry-run): record has title "Intro to MCP"
    // Apply call: record has title "CHANGED" → verify mismatch
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
    });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    // Custom mock: return different record on each call to /items/articles/1.
    // Call 1 (dry-run read-before): title = 'Intro to MCP' → verify passes.
    // Call 2+ (apply read-before): title = 'CHANGED' → verify fails.
    let readCount = 0;
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
      if (path.includes('/items/articles/1') && method === 'GET') {
        readCount++;
        const title = readCount === 1 ? 'Intro to MCP' : 'CHANGED BY SOMEONE ELSE';
        return new Response(JSON.stringify({ data: { id: 1, title, slug: null } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path.includes('/items/articles/1') && method === 'PATCH') {
        return new Response(JSON.stringify({ data: { id: 1, title: 'Intro to MCP', slug: 'intro-to-mcp' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{"errors":[{"message":"no mock"}]}', { status: 404, headers: { 'content-type': 'application/json' } });
    });

    const ctx = buildContext({ config: makeConfig({ mutationRequireVerify: true }) });
    // Dry-run with verify.
    const dryRunResult = await updateItemTool.handler(ctx, {
      collection: 'articles',
      key: 1,
      verify: { title: 'Intro to MCP' },
      data: { slug: 'intro-to-mcp' },
      dry_run: true,
    });
    const planId = dryRunResult.structuredContent.planId as string;

    // Apply — verify will fail because title changed between dry-run and apply.
    await expectErrorCode(
      () => applyPlanTool.handler(ctx, { plan_id: planId, confirm: true }),
      'VERIFY_FAILED',
    );

    // No PATCH should have been issued.
    const patchCalls = spy.mock.calls.filter((c) => (c[1] as RequestInit)?.method === 'PATCH');
    expect(patchCalls.length).toBe(0);
  });
});

describe('Plan flow: readback mismatch → warning (not throw), plan terminal', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('update apply: write happens, read-back mismatch → applied_with_warning, not throw, plan cannot re-apply', async () => {
    // Mock: dry-run read returns slug=null. Apply PATCH returns slug='intro-to-mcp'.
    // But post-write read returns slug='CHANGED BY FLOW' → readback mismatch.
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
    });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    let readCount = 0;
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
      if (path.includes('/items/articles/1') && method === 'GET') {
        readCount++;
        // Reads: 1=dry-run before, 2=apply before, 3=apply after-read (readback)
        // For readback (read 3), return CHANGED to trigger mismatch.
        const slug = readCount === 3 ? 'CHANGED BY FLOW' : null;
        return new Response(JSON.stringify({ data: { id: 1, title: 'Intro to MCP', slug } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path.includes('/items/articles/1') && method === 'PATCH') {
        return new Response(JSON.stringify({ data: { id: 1, title: 'Intro to MCP', slug: 'intro-to-mcp' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{"errors":[{"message":"no mock"}]}', { status: 404, headers: { 'content-type': 'application/json' } });
    });

    const ctx = buildContext({ config: makeConfig({ mutationRequireVerify: false }) });
    // Dry-run.
    const dryRunResult = await updateItemTool.handler(ctx, {
      collection: 'articles',
      key: 1,
      data: { slug: 'intro-to-mcp' },
      dry_run: true,
    });
    const planId = dryRunResult.structuredContent.planId as string;

    // Apply — should NOT throw. Should return warning.
    const applyResult = await applyPlanTool.handler(ctx, { plan_id: planId, confirm: true });

    expect(applyResult.structuredContent.applied).toBe(true);
    expect(applyResult.structuredContent.written).toBe(true);
    expect(applyResult.structuredContent.readBackOk).toBe(false);
    expect(applyResult.structuredContent.warning).toBeDefined();
    expect(applyResult.structuredContent.warning.code).toBe('READBACK_MISMATCH');

    const text = applyResult.content[0]!.text;
    expect(text).toContain('APPLIED');
    expect(text).toContain('Read-back verification: MISMATCH');

    // CRITICAL: second apply → PLAN_ALREADY_APPLIED (plan is terminal).
    await expectErrorCode(
      () => applyPlanTool.handler(ctx, { plan_id: planId, confirm: true }),
      'PLAN_ALREADY_APPLIED',
    );

    // Verify PATCH happened exactly once (the write did occur).
    const patchCalls = spy.mock.calls.filter((c) => (c[1] as RequestInit)?.method === 'PATCH');
    expect(patchCalls.length).toBe(1);
  });
});

describe('Plan flow: concurrent apply race condition', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('two concurrent apply calls — only one succeeds, other gets PLAN_ALREADY_IN_PROGRESS', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'Intro to MCP', slug: 'intro-to-mcp' } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext({ config: makeConfig({ mutationRequireVerify: false }) });
    // Dry-run to create plan.
    const dryRunResult = await updateItemTool.handler(ctx, {
      collection: 'articles',
      key: 1,
      data: { slug: 'intro-to-mcp' },
      dry_run: true,
    });
    const planId = dryRunResult.structuredContent.planId as string;

    // Manually claim the plan to simulate in-progress apply.
    await ctx.plans.claimForApply(planId);

    // Now apply_plan should fail with PLAN_ALREADY_IN_PROGRESS.
    await expectErrorCode(
      () => applyPlanTool.handler(ctx, { plan_id: planId, confirm: true }),
      'PLAN_ALREADY_IN_PROGRESS',
    );
  });
});

describe('Plan flow: create_item read-back verification', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('create apply: write happens, read-back verifies created record matches intent', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles': { body: { data: { id: 42, title: 'New Article', slug: 'new-article' } } },
      '/items/articles/42': { body: { data: { id: 42, title: 'New Article', slug: 'new-article' } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext({ config: makeConfig({ mutationRequireVerify: false, mutationDryRunDefault: true }) });
    // Dry-run create.
    const dryRunResult = await createItemTool.handler(ctx, {
      collection: 'articles',
      data: { title: 'New Article', slug: 'new-article' },
      dry_run: true,
    });
    const planId = dryRunResult.structuredContent.planId as string;

    // Apply.
    const applyResult = await applyPlanTool.handler(ctx, { plan_id: planId, confirm: true });

    expect(applyResult.structuredContent.applied).toBe(true);
    expect(applyResult.structuredContent.written).toBe(true);
    expect(applyResult.structuredContent.readBackOk).toBe(true);
    expect(applyResult.structuredContent.created).toBeDefined();
  });

  it('create apply: write happens, read-back mismatch → warning', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
    });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

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
      if (path === '/items/articles' && method === 'POST') {
        // Create returns id=42.
        return new Response(JSON.stringify({ data: { id: 42, title: 'New Article' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path.includes('/items/articles/42') && method === 'GET') {
        // Read-back: title was modified by a flow after create.
        return new Response(JSON.stringify({ data: { id: 42, title: 'CHANGED BY FLOW' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{"errors":[{"message":"no mock"}]}', { status: 404, headers: { 'content-type': 'application/json' } });
    });

    const ctx = buildContext({ config: makeConfig({ mutationRequireVerify: false, mutationDryRunDefault: true }) });
    const dryRunResult = await createItemTool.handler(ctx, {
      collection: 'articles',
      data: { title: 'New Article' },
      dry_run: true,
    });
    const planId = dryRunResult.structuredContent.planId as string;

    const applyResult = await applyPlanTool.handler(ctx, { plan_id: planId, confirm: true });

    expect(applyResult.structuredContent.applied).toBe(true);
    expect(applyResult.structuredContent.written).toBe(true);
    expect(applyResult.structuredContent.readBackOk).toBe(false);
    expect(applyResult.structuredContent.warning).toBeDefined();
    expect(applyResult.structuredContent.warning.code).toBe('READBACK_MISMATCH');
  });
});

describe('Plan flow: checksum mismatch → plan cancelled, not applying', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('checksum mismatch on apply → PLAN_CHECKSUM_MISMATCH, plan status is cancelled (not applying)', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
      '/items/articles/1': { body: { data: { id: 1, title: 'Intro to MCP', slug: null } } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const ctx = buildContext({ config: makeConfig({ mutationRequireVerify: false }) });
    // Dry-run to create a valid plan.
    const dryRunResult = await updateItemTool.handler(ctx, {
      collection: 'articles',
      key: 1,
      data: { slug: 'intro-to-mcp' },
      dry_run: true,
    });
    const planId = dryRunResult.structuredContent.planId as string;

    // Corrupt the plan: load it, change the payload, save it back with the
    // OLD checksum (simulating tampering or corruption).
    const plan = await ctx.plans.get(planId);
    expect(plan).not.toBeNull();
    const corruptedPlan = plan!;
    // Tamper with payload but keep original checksum.
    (corruptedPlan.payload as { data: Record<string, unknown> }).data = { evil: 'tampered' };
    // Write corrupted plan back by going through internal store. For memory
    // store, we can access the internal map; for file store, we'd write the
    // file directly. Since we're using MemoryPlanStore in tests, we can
    // access the internal map via a cast.
    const memoryStore = ctx.plans as unknown as { plans: Map<string, typeof corruptedPlan> };
    memoryStore.plans.set(planId, corruptedPlan);

    // Apply should fail with PLAN_CHECKSUM_MISMATCH.
    await expectErrorCode(
      () => applyPlanTool.handler(ctx, { plan_id: planId, confirm: true }),
      'PLAN_CHECKSUM_MISMATCH',
    );

    // CRITICAL: plan should NOT be in 'applying' status. It should be 'cancelled'.
    const finalPlan = await ctx.plans.get(planId);
    expect(finalPlan!.status).toBe('cancelled');

    // Re-apply should fail with PLAN_CANCELLED (not PLAN_ALREADY_IN_PROGRESS).
    await expectErrorCode(
      () => applyPlanTool.handler(ctx, { plan_id: planId, confirm: true }),
      'PLAN_CANCELLED',
    );
  });
});

describe('Plan flow: warning text format shows WARNING (not OK)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('readback mismatch → text header shows "WARNING" not "OK"', async () => {
    const fetchMock = mockFetch({
      '/collections/articles': { body: articlesSchemaResponse },
      '/fields/articles': { body: articlesFieldsResponse },
      '/relations': { body: articlesRelationsResponse },
    });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    let readCount = 0;
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
      if (path.includes('/items/articles/1') && method === 'GET') {
        readCount++;
        // Read 3 = readback → return CHANGED to trigger mismatch.
        const slug = readCount === 3 ? 'CHANGED BY FLOW' : null;
        return new Response(JSON.stringify({ data: { id: 1, title: 'Intro to MCP', slug } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path.includes('/items/articles/1') && method === 'PATCH') {
        return new Response(JSON.stringify({ data: { id: 1, title: 'Intro to MCP', slug: 'intro-to-mcp' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{"errors":[{"message":"no mock"}]}', { status: 404, headers: { 'content-type': 'application/json' } });
    });

    const ctx = buildContext({ config: makeConfig({ mutationRequireVerify: false }) });
    const dryRunResult = await updateItemTool.handler(ctx, {
      collection: 'articles',
      key: 1,
      data: { slug: 'intro-to-mcp' },
      dry_run: true,
    });
    const planId = dryRunResult.structuredContent.planId as string;

    const applyResult = await applyPlanTool.handler(ctx, { plan_id: planId, confirm: true });

    const text = applyResult.content[0]!.text;
    // CRITICAL: header should show WARNING, not OK.
    expect(text).toContain('APPLIED UPDATE articles — WARNING');
    expect(text).toContain('written=true');
    expect(text).toContain('Read-back verification: MISMATCH');
    // Should NOT contain "— OK" on the header line.
    const firstLine = text.split('\n')[0]!;
    expect(firstLine).not.toContain('— OK');
  });
});

describe('Plan flow: FilePlanStore atomic lock', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('concurrent claimForApply on FilePlanStore — second call gets PLAN_ALREADY_IN_PROGRESS', async () => {
    const { FilePlanStore } = await import('../../src/safety/plans.js');
    const { rm, mkdir } = await import('node:fs/promises');
    const testDir = '/tmp/test-plan-lock-directus-safe-mcp';
    await rm(testDir, { recursive: true, force: true });
    await mkdir(testDir, { recursive: true });
    try {
      const store = new FilePlanStore(testDir, 1048576, pino({ level: 'silent' }));

      // Create a plan.
      const plan = await store.create({
        operation: 'update_item',
        collection: 'articles',
        payload: { type: 'update_item', key: 1, data: { slug: 'x' } },
        summary: {},
        ttlSeconds: 900,
      });

      // First claim succeeds.
      await store.claimForApply(plan.id);

      // Second claim → PLAN_ALREADY_IN_PROGRESS (lock file exists).
      await expectErrorCode(
        () => store.claimForApply(plan.id),
        'PLAN_ALREADY_IN_PROGRESS',
      );

      // markApplied releases the lock.
      await store.markApplied(plan.id);

      // Now lock is gone — but plan is 'applied' so claim → PLAN_ALREADY_APPLIED.
      await expectErrorCode(
        () => store.claimForApply(plan.id),
        'PLAN_ALREADY_APPLIED',
      );
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('FilePlanStore: lock file is created and cleaned up', async () => {
    const { FilePlanStore } = await import('../../src/safety/plans.js');
    const { rm, mkdir, readdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const testDir = '/tmp/test-plan-lock2-directus-safe-mcp';
    await rm(testDir, { recursive: true, force: true });
    await mkdir(testDir, { recursive: true });
    try {
      const store = new FilePlanStore(testDir, 1048576, pino({ level: 'silent' }));
      const plan = await store.create({
        operation: 'update_item',
        collection: 'articles',
        payload: { type: 'update_item', key: 1, data: { slug: 'x' } },
        summary: {},
        ttlSeconds: 900,
      });

      await store.claimForApply(plan.id);
      // Lock file should exist.
      const filesAfterClaim = await readdir(testDir);
      expect(filesAfterClaim.some((f) => f.endsWith('.lock'))).toBe(true);

      await store.markApplied(plan.id);
      // Lock file should be gone.
      const filesAfterApply = await readdir(testDir);
      expect(filesAfterApply.some((f) => f.endsWith('.lock'))).toBe(false);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });
});
