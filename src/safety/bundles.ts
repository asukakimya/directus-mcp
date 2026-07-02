import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { McpUserError } from '../directus/errors.js';

/**
 * Plan bundle — groups multiple planIds together so the model only needs
 * to track a single `bundle_id` instead of a list of planIds.
 *
 * Created by `directus_update_by_query_plan` (and similar batch-plan tools).
 * Applied by `directus_apply_plan_bundle`.
 * Status checked by `directus_plan_bundle_status`.
 */
export interface PlanBundle {
  id: string;
  version: 1;
  /** Operation type that created this bundle. */
  operation: string;
  collection: string;
  /** Ordered list of plan IDs in this bundle. */
  planIds: string[];
  createdAt: string;
  expiresAt: string;
  /** Summary from the dry-run that created this bundle. */
  summary: {
    totalMatched: number;
    chunkCount: number;
    chunkSize: number;
    changedFields: string[];
    affectedKeys?: Array<string | number>;
  };
  /** Verification spec for post-apply verification. */
  verification?: BundleVerification;
}

export interface BundleVerification {
  type: 'fields_value' | 'fields_empty';
  /** For fields_value: expected values to check. */
  expected?: Record<string, unknown>;
  /** For fields_empty: fields to check are empty. */
  fields?: string[];
  /** Query to scope the verification read. */
  query?: Record<string, unknown>;
}

export interface BundleStore {
  create(input: Omit<PlanBundle, 'id' | 'version' | 'createdAt' | 'expiresAt'> & { ttlSeconds: number }): Promise<PlanBundle>;
  get(id: string): Promise<PlanBundle | null>;
  delete(id: string): Promise<void>;
  cleanup(): Promise<number>;
}

export function generateBundleId(): string {
  return `bundle_${randomUUID()}`;
}

/* ---------------- File-based store ---------------- */

export class FileBundleStore implements BundleStore {
  constructor(
    private readonly dir: string,
    private readonly logger: Logger,
  ) {}

  async create(input: Omit<PlanBundle, 'id' | 'version' | 'createdAt' | 'expiresAt'> & { ttlSeconds: number }): Promise<PlanBundle> {
    await this.ensureDir();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000);
    const bundle: PlanBundle = {
      id: generateBundleId(),
      version: 1,
      operation: input.operation,
      collection: input.collection,
      planIds: input.planIds,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      summary: input.summary,
      verification: input.verification,
    };
    const filePath = this.pathFor(bundle.id);
    await writeFile(filePath, JSON.stringify(bundle), { mode: 0o600, encoding: 'utf8' });
    this.logger.debug({ bundleId: bundle.id, planCount: bundle.planIds.length }, 'bundle created');
    return bundle;
  }

  async get(id: string): Promise<PlanBundle | null> {
    if (!/^bundle_[a-f0-9-]+$/i.test(id)) return null;
    const filePath = this.pathFor(id);
    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch {
      return null;
    }
    try {
      return JSON.parse(text) as PlanBundle;
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<void> {
    if (!/^bundle_[a-f0-9-]+$/i.test(id)) return;
    try {
      await unlink(this.pathFor(id));
    } catch {
      // ignore
    }
  }

  async cleanup(): Promise<number> {
    let removed = 0;
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return 0;
    }
    const now = Date.now();
    for (const f of files) {
      if (!f.endsWith('.json') || !f.startsWith('bundle_')) continue;
      const id = f.slice(0, -5);
      const bundle = await this.get(id);
      if (bundle && new Date(bundle.expiresAt).getTime() < now) {
        try { await unlink(this.pathFor(id)); removed++; } catch { /* ignore */ }
      }
    }
    return removed;
  }

  private pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw new McpUserError('PLAN_STORE_ERROR', `Failed to create bundle store directory ${this.dir}: ${err instanceof Error ? err.message : String(err)}`, { dir: this.dir });
    }
  }
}

/* ---------------- Memory store (for tests) ---------------- */

export class MemoryBundleStore implements BundleStore {
  private readonly bundles = new Map<string, PlanBundle>();

  async create(input: Omit<PlanBundle, 'id' | 'version' | 'createdAt' | 'expiresAt'> & { ttlSeconds: number }): Promise<PlanBundle> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000);
    const bundle: PlanBundle = {
      id: generateBundleId(),
      version: 1,
      operation: input.operation,
      collection: input.collection,
      planIds: input.planIds,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      summary: input.summary,
      verification: input.verification,
    };
    this.bundles.set(bundle.id, bundle);
    return bundle;
  }

  async get(id: string): Promise<PlanBundle | null> {
    return this.bundles.get(id) ?? null;
  }

  async delete(id: string): Promise<void> {
    this.bundles.delete(id);
  }

  async cleanup(): Promise<number> {
    let removed = 0;
    const now = Date.now();
    for (const [id, bundle] of this.bundles) {
      if (new Date(bundle.expiresAt).getTime() < now) {
        this.bundles.delete(id);
        removed++;
      }
    }
    return removed;
  }
}

/* ---------------- Factory ---------------- */

export function createBundleStore(
  backend: 'file' | 'memory',
  dir: string,
  logger: Logger,
): BundleStore {
  if (backend === 'memory') {
    return new MemoryBundleStore();
  }
  return new FileBundleStore(dir, logger);
}

/* ---------------- Status helper ---------------- */

export interface BundleStatusResult {
  bundleId: string;
  status: 'pending' | 'partially_applied' | 'applied' | 'expired' | 'cancelled' | 'failed';
  plans: Array<{
    planId: string;
    status: string;
    appliedAt?: string;
  }>;
  canApply: boolean;
  canCancel: boolean;
}

/**
 * Compute bundle status by inspecting the status of each plan in the bundle.
 * Requires a PlanStore to look up plan statuses.
 */
export async function computeBundleStatus(
  bundle: PlanBundle,
  planStore: import('./plans.js').PlanStore,
): Promise<BundleStatusResult> {
  const planStatuses: BundleStatusResult['plans'] = [];
  let appliedCount = 0;
  let pendingCount = 0;
  let cancelledCount = 0;
  let failedCount = 0;
  let expiredCount = 0;

  for (const planId of bundle.planIds) {
    const plan = await planStore.get(planId);
    if (!plan) {
      planStatuses.push({ planId, status: 'not_found' });
      failedCount++;
      continue;
    }
    planStatuses.push({
      planId,
      status: plan.status,
      appliedAt: plan.appliedAt,
    });
    if (plan.status === 'applied' || plan.status === 'applied_with_warning') {
      appliedCount++;
    } else if (plan.status === 'pending' || plan.status === 'applying') {
      pendingCount++;
    } else if (plan.status === 'cancelled') {
      cancelledCount++;
    } else if (plan.status === 'failed_after_write') {
      failedCount++;
    } else if (plan.status === 'expired') {
      expiredCount++;
    }
  }

  let status: BundleStatusResult['status'];
  if (expiredCount > 0 && appliedCount === 0) {
    status = 'expired';
  } else if (cancelledCount > 0 && appliedCount === 0) {
    status = 'cancelled';
  } else if (failedCount > 0) {
    status = 'failed';
  } else if (appliedCount === bundle.planIds.length) {
    status = 'applied';
  } else if (appliedCount > 0) {
    status = 'partially_applied';
  } else {
    status = 'pending';
  }

  // Also check bundle expiry.
  if (new Date(bundle.expiresAt).getTime() < Date.now() && status === 'pending') {
    status = 'expired';
  }

  return {
    bundleId: bundle.id,
    status,
    plans: planStatuses,
    canApply: status === 'pending' || status === 'partially_applied',
    canCancel: status === 'pending' || status === 'partially_applied',
  };
}
