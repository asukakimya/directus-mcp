import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pino } from 'pino';
import {
  MemoryPlanStore,
  FilePlanStore,
  computeChecksum,
  verifyPlanChecksum,
  type PlanPayload,
} from '../../src/safety/plans.js';
import { McpUserError } from '../../src/directus/errors.js';
import { expectErrorCode } from './helpers.js';

const logger = pino({ level: 'silent' });
const testDir = '/tmp/test-plan-store-directus-safe-mcp';

const samplePayload: PlanPayload = {
  type: 'update_item',
  key: 1,
  data: { slug: 'intro-to-mcp' },
  verify: { title: 'Intro to MCP' },
};

describe('computeChecksum', () => {
  it('produces deterministic checksum for same payload', () => {
    const a = computeChecksum(samplePayload);
    const b = computeChecksum({ ...samplePayload });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes when payload changes', () => {
    const a = computeChecksum(samplePayload);
    const b = computeChecksum({ ...samplePayload, data: { slug: 'different' } });
    expect(a).not.toBe(b);
  });

  it('is canonical (key order independent)', () => {
    const a = computeChecksum({ type: 'update_item', key: 1, data: { b: 2, a: 1 } });
    const b = computeChecksum({ type: 'update_item', key: 1, data: { a: 1, b: 2 } });
    expect(a).toBe(b);
  });
});

describe('verifyPlanChecksum', () => {
  it('passes when checksum matches', () => {
    const checksum = computeChecksum(samplePayload);
    expect(() =>
      verifyPlanChecksum({
        id: 'plan_test',
        version: 1,
        operation: 'update_item',
        collection: 'articles',
        payload: samplePayload,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 900000).toISOString(),
        status: 'pending',
        checksum,
        summary: {},
      }),
    ).not.toThrow();
  });

  it('throws PLAN_CHECKSUM_MISMATCH when checksum does not match', () => {
    expectErrorCode(
      () =>
        verifyPlanChecksum({
          id: 'plan_test',
          version: 1,
          operation: 'update_item',
          collection: 'articles',
          payload: samplePayload,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 900000).toISOString(),
          status: 'pending',
          checksum: 'wrong',
          summary: {},
        }),
      'PLAN_CHECKSUM_MISMATCH',
    );
  });
});

describe('MemoryPlanStore', () => {
  let store: MemoryPlanStore;

  beforeEach(() => {
    store = new MemoryPlanStore();
  });

  it('create → get returns the plan', async () => {
    const plan = await store.create({
      operation: 'update_item',
      collection: 'articles',
      payload: samplePayload,
      summary: { changedFields: ['slug'], affectedKeys: [1] },
      ttlSeconds: 900,
    });
    expect(plan.id).toMatch(/^plan_/);
    expect(plan.status).toBe('pending');
    expect(plan.checksum).toBe(computeChecksum(samplePayload));

    const loaded = await store.get(plan.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(plan.id);
  });

  it('get returns null for non-existent plan', async () => {
    const loaded = await store.get('plan_nonexistent');
    expect(loaded).toBeNull();
  });

  it('markApplied changes status to applied', async () => {
    const plan = await store.create({
      operation: 'update_item',
      collection: 'articles',
      payload: samplePayload,
      summary: {},
      ttlSeconds: 900,
    });
    const applied = await store.markApplied(plan.id);
    expect(applied.status).toBe('applied');
    expect(applied.appliedAt).toBeDefined();

    const loaded = await store.get(plan.id);
    expect(loaded!.status).toBe('applied');
  });

  it('markCancelled changes status to cancelled', async () => {
    const plan = await store.create({
      operation: 'update_item',
      collection: 'articles',
      payload: samplePayload,
      summary: {},
      ttlSeconds: 900,
    });
    const cancelled = await store.markCancelled(plan.id);
    expect(cancelled.status).toBe('cancelled');
  });

  it('markApplied throws PLAN_NOT_FOUND for non-existent plan', async () => {
    await expectErrorCode(
      () => store.markApplied('plan_nonexistent'),
      'PLAN_NOT_FOUND',
    );
  });

  it('expired plan is marked expired on read', async () => {
    const plan = await store.create({
      operation: 'update_item',
      collection: 'articles',
      payload: samplePayload,
      summary: {},
      ttlSeconds: -1, // already expired
    });
    const loaded = await store.get(plan.id);
    expect(loaded!.status).toBe('expired');
  });

  it('cleanup removes expired and cancelled plans', async () => {
    const p1 = await store.create({ operation: 'update_item', collection: 'a', payload: samplePayload, summary: {}, ttlSeconds: -1 });
    const p2 = await store.create({ operation: 'update_item', collection: 'b', payload: samplePayload, summary: {}, ttlSeconds: 900 });
    await store.markCancelled(p2.id);
    const p3 = await store.create({ operation: 'update_item', collection: 'c', payload: samplePayload, summary: {}, ttlSeconds: 900 });

    // Trigger expiry read for p1.
    await store.get(p1.id);

    const removed = await store.cleanup();
    expect(removed).toBe(2); // p1 (expired) + p2 (cancelled)
    // p3 should still exist (pending, not expired).
    expect(await store.get(p3.id)).not.toBeNull();
  });
});

describe('FilePlanStore', () => {
  let store: FilePlanStore;

  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    await mkdir(testDir, { recursive: true });
    store = new FilePlanStore(testDir, 1048576, logger);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('create → get returns the plan (persists to disk)', async () => {
    const plan = await store.create({
      operation: 'update_item',
      collection: 'articles',
      payload: samplePayload,
      summary: { changedFields: ['slug'] },
      ttlSeconds: 900,
    });
    expect(plan.id).toMatch(/^plan_/);

    const loaded = await store.get(plan.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(plan.id);
    expect(loaded!.checksum).toBe(plan.checksum);
  });

  it('get returns null for non-existent plan', async () => {
    const loaded = await store.get('plan_nonexistent');
    expect(loaded).toBeNull();
  });

  it('markApplied persists status to disk', async () => {
    const plan = await store.create({
      operation: 'update_item',
      collection: 'articles',
      payload: samplePayload,
      summary: {},
      ttlSeconds: 900,
    });
    await store.markApplied(plan.id);

    // Re-read from disk.
    const loaded = await store.get(plan.id);
    expect(loaded!.status).toBe('applied');
    expect(loaded!.appliedAt).toBeDefined();
  });

  it('markApplied throws PLAN_NOT_FOUND for non-existent plan', async () => {
    await expectErrorCode(
      () => store.markApplied('plan_nonexistent'),
      'PLAN_NOT_FOUND',
    );
  });

  it('expired plan is marked expired on read', async () => {
    const plan = await store.create({
      operation: 'update_item',
      collection: 'articles',
      payload: samplePayload,
      summary: {},
      ttlSeconds: -1,
    });
    const loaded = await store.get(plan.id);
    expect(loaded!.status).toBe('expired');
  });

  it('persists across store restart simulation', async () => {
    const plan = await store.create({
      operation: 'update_item',
      collection: 'articles',
      payload: samplePayload,
      summary: {},
      ttlSeconds: 900,
    });

    // Simulate restart: create a new store instance pointing to same dir.
    const store2 = new FilePlanStore(testDir, 1048576, logger);
    const loaded = await store2.get(plan.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(plan.id);
  });

  it('rejects plan ID with path traversal (returns null, does not access filesystem)', async () => {
    const loaded = await store.get('plan_../../etc/passwd');
    expect(loaded).toBeNull();
  });

  it('cleanup removes expired plan files', async () => {
    const p1 = await store.create({
      operation: 'update_item',
      collection: 'a',
      payload: samplePayload,
      summary: {},
      ttlSeconds: -1,
    });
    // Trigger expiry.
    await store.get(p1.id);

    const removed = await store.cleanup();
    expect(removed).toBe(1);
  });
});
