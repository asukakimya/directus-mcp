import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, readdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { McpUserError } from '../directus/errors.js';

/**
 * Mutation plan — created by dry-run, applied by `directus_apply_plan`.
 *
 * The plan stores the FULL operation payload so the model does not need
 * to reproduce it after user approval. The model only needs to send
 * `{ plan_id, confirm: true }` to `directus_apply_plan`.
 */
export interface MutationPlan {
  id: string;
  version: 1;
  operation:
    | 'create_item'
    | 'create_items'
    | 'update_item'
    | 'update_items_same_data'
    | 'batch_update_items'
    | 'delete_items';

  collection: string;

  /** Everything needed to re-execute the operation. */
  payload: PlanPayload;

  createdAt: string;
  expiresAt: string;

  /**
   * Plan lifecycle:
   *   pending                 → plan created by dry_run, waiting for user approval
   *   applying                → apply_plan in progress (race condition guard)
   *   applied                 → apply succeeded, read-back OK
   *   applied_with_warning    → apply succeeded, but post-write read-back mismatch
   *                             (write happened but record may have been modified by a
   *                             Directus flow/trigger). Terminal — cannot re-apply.
   *   failed_after_write      → apply errored AFTER the write may have happened
   *                             (network, parse, unexpected). Terminal — cannot re-apply
   *                             safely. Caller must investigate via read.
   *   expired                 → TTL passed before apply. Terminal.
   *   cancelled               → user/agent explicitly cancelled. Terminal.
   */
  status:
    | 'pending'
    | 'applying'
    | 'applied'
    | 'applied_with_warning'
    | 'failed_after_write'
    | 'expired'
    | 'cancelled';
  appliedAt?: string;
  /** Populated when status = applied_with_warning or failed_after_write. */
  warning?: { code: string; message: string; details?: unknown };

  /** SHA-256 of canonical JSON of payload. Detects corruption/tampering. */
  checksum: string;

  summary: {
    changedFields?: string[];
    affectedKeys?: Array<string | number>;
    itemCount?: number;
  };
}

export type PlanPayload =
  | { type: 'create_item'; data: Record<string, unknown>; dedupe?: Record<string, unknown> }
  | { type: 'create_items'; items: Array<{ data: Record<string, unknown>; dedupe?: Record<string, unknown> }>; allowPartialApply?: boolean }
  | { type: 'update_item'; key: string | number; data: Record<string, unknown>; verify?: Record<string, unknown> }
  | { type: 'update_items_same_data'; keys: Array<string | number>; data: Record<string, unknown> }
  | { type: 'batch_update_items'; items: Array<{ key: string | number; data: Record<string, unknown>; verify?: Record<string, unknown> }>; allowPartialApply?: boolean; failFast?: boolean }
  | { type: 'delete_items'; keys: Array<string | number>; verify?: Array<{ key: string | number; [field: string]: unknown }>; confirm?: string };

export interface PlanStore {
  create(input: Omit<MutationPlan, 'id' | 'createdAt' | 'expiresAt' | 'status' | 'checksum' | 'appliedAt' | 'warning'> & { ttlSeconds: number }): Promise<MutationPlan>;
  get(id: string): Promise<MutationPlan | null>;
  /**
   * Atomically transition a plan from `pending` to `applying`.
   * Throws PLAN_ALREADY_APPLIED / PLAN_ALREADY_IN_PROGRESS / PLAN_EXPIRED /
   * PLAN_CANCELLED if the plan is no longer pending. This is the race-condition
   * guard: two concurrent apply calls cannot both pass the claim.
   * Returns the claimed plan (with status='applying').
   */
  claimForApply(id: string): Promise<MutationPlan>;
  markApplied(id: string): Promise<MutationPlan>;
  markAppliedWithWarning(id: string, warning: { code: string; message: string; details?: unknown }): Promise<MutationPlan>;
  markFailedAfterWrite(id: string, warning: { code: string; message: string; details?: unknown }): Promise<MutationPlan>;
  markCancelled(id: string): Promise<MutationPlan>;
  cleanup(): Promise<number>;
}

/* ---------------- helpers ---------------- */

export function computeChecksum(payload: PlanPayload): string {
  return createHash('sha256').update(canonicalJsonStringify(payload)).digest('hex');
}

/**
 * Canonical JSON: sorted keys at every level, deterministic output.
 * Ensures the same logical payload always produces the same checksum.
 */
function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJsonStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJsonStringify(obj[k])).join(',') + '}';
}

export function generatePlanId(): string {
  return `plan_${randomUUID()}`;
}

/* ---------------- File-based store ---------------- */

export class FilePlanStore implements PlanStore {
  constructor(
    private readonly dir: string,
    private readonly maxBytes: number,
    private readonly logger: Logger,
  ) {}

  async create(input: Omit<MutationPlan, 'id' | 'createdAt' | 'expiresAt' | 'status' | 'checksum' | 'appliedAt' | 'warning'> & { ttlSeconds: number }): Promise<MutationPlan> {
    await this.ensureDir();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000);
    const plan: MutationPlan = {
      id: generatePlanId(),
      version: 1,
      operation: input.operation,
      collection: input.collection,
      payload: input.payload,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: 'pending',
      checksum: computeChecksum(input.payload),
      summary: input.summary,
    };
    const json = JSON.stringify(plan);
    if (Buffer.byteLength(json, 'utf8') > this.maxBytes) {
      throw new McpUserError(
        'PLAN_TOO_LARGE',
        `Plan payload (${Buffer.byteLength(json, 'utf8')} bytes) exceeds PLAN_MAX_BYTES (${this.maxBytes})`,
        { bytes: Buffer.byteLength(json, 'utf8'), max: this.maxBytes },
      );
    }
    const filePath = this.pathFor(plan.id);
    await writeFile(filePath, json, { mode: 0o600, encoding: 'utf8' });
    this.logger.debug({ planId: plan.id, operation: plan.operation, collection: plan.collection }, 'plan created');
    return plan;
  }

  async get(id: string): Promise<MutationPlan | null> {
    const filePath = this.pathFor(id);
    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch {
      return null;
    }
    let plan: MutationPlan;
    try {
      plan = JSON.parse(text) as MutationPlan;
    } catch {
      return null;
    }
    // Check expiry on read; mark expired if past TTL (only if still pending/applying).
    if ((plan.status === 'pending' || plan.status === 'applying') && new Date(plan.expiresAt).getTime() < Date.now()) {
      plan.status = 'expired';
      try { await writeFile(filePath, JSON.stringify(plan), { mode: 0o600, encoding: 'utf8' }); } catch { /* best effort */ }
      return plan;
    }
    return plan;
  }

  /**
   * Atomically claim a plan for apply. Reads the plan, checks it's pending,
   * transitions to 'applying', and writes back. If another process already
   * claimed/applied/etc, throws the appropriate error.
   *
   * This is the race-condition guard. Two concurrent apply calls cannot
   * both pass this check (file write is atomic at the OS level for our
   * purposes here; for true cross-process safety a lock file would be
   * needed, but for single-container Docker this is sufficient).
   */
  async claimForApply(id: string): Promise<MutationPlan> {
    // 1. Validate ID format (path traversal protection).
    if (!/^plan_[a-f0-9-]+$/i.test(id)) {
      throw new McpUserError('PLAN_NOT_FOUND', `Invalid plan ID format: ${id}`, { planId: id });
    }

    // 2. Load plan.
    const plan = await this.get(id);
    if (!plan) {
      throw new McpUserError('PLAN_NOT_FOUND', `Plan ${id} not found`, { planId: id });
    }
    if (plan.status === 'applying') {
      throw new McpUserError(
        'PLAN_ALREADY_IN_PROGRESS',
        `Plan ${id} is already being applied by another request. Wait for it to complete or check the result.`,
        { planId: id, status: plan.status },
      );
    }
    if (plan.status === 'applied' || plan.status === 'applied_with_warning' || plan.status === 'failed_after_write') {
      throw new McpUserError(
        'PLAN_ALREADY_APPLIED',
        `Plan ${id} was already applied at ${plan.appliedAt ?? '(unknown time)'}. Plans are idempotent — each plan can only write once.`,
        { planId: id, appliedAt: plan.appliedAt, status: plan.status },
      );
    }
    if (plan.status === 'cancelled') {
      throw new McpUserError('PLAN_CANCELLED', `Plan ${id} was cancelled and cannot be applied.`, { planId: id });
    }
    if (plan.status === 'expired') {
      throw new McpUserError('PLAN_EXPIRED', `Plan ${id} has expired (expired at ${plan.expiresAt}). Run dry_run:true again to create a new plan.`, { planId: id, expiresAt: plan.expiresAt });
    }
    if (plan.status !== 'pending') {
      throw new McpUserError('PLAN_STORE_ERROR', `Plan ${id} has unexpected status '${plan.status}'`, { planId: id, status: plan.status });
    }

    // 3. ATOMIC LOCK: create lock file with fs.open(..., 'wx').
    //    'wx' = O_WRONLY | O_CREAT | O_EXCL — fails atomically if file exists.
    //    This is the real race-condition guard: two concurrent apply calls
    //    cannot both create the lock file. The loser gets EEXIST.
    await this.ensureDir();
    const lockPath = this.lockPathFor(id);
    try {
      const fh = await open(lockPath, 'wx', 0o600);
      await fh.writeFile(new Date().toISOString());
      await fh.close();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        // Lock file exists — another apply is in progress (or crashed mid-apply).
        throw new McpUserError(
          'PLAN_ALREADY_IN_PROGRESS',
          `Plan ${id} is already being applied by another request (lock file exists). If this persists, the previous apply may have crashed — check plan status.`,
          { planId: id, status: 'applying', lockPath },
        );
      }
      throw new McpUserError(
        'PLAN_STORE_ERROR',
        `Failed to acquire lock for plan ${id}: ${err instanceof Error ? err.message : String(err)}`,
        { planId: id, error: code },
      );
    }

    // 4. Mark plan as 'applying' (lock already acquired — no race possible).
    plan.status = 'applying';
    try {
      await writeFile(this.pathFor(id), JSON.stringify(plan), { mode: 0o600, encoding: 'utf8' });
    } catch (err) {
      // Failed to write status — release lock so a retry can proceed.
      await this.releaseLock(id).catch(() => {});
      throw new McpUserError(
        'PLAN_STORE_ERROR',
        `Failed to mark plan ${id} as applying: ${err instanceof Error ? err.message : String(err)}`,
        { planId: id },
      );
    }
    return plan;
  }

  /**
   * Release the apply lock for a plan. Best-effort — errors are swallowed.
   * Called after apply completes (success or failure).
   */
  async releaseLock(id: string): Promise<void> {
    if (!/^plan_[a-f0-9-]+$/i.test(id)) return;
    const lockPath = this.lockPathFor(id);
    try {
      await unlink(lockPath);
    } catch {
      // Lock file may already be gone — that's fine.
    }
  }

  async markApplied(id: string): Promise<MutationPlan> {
    const result = await this.updateStatus(id, 'applied');
    await this.releaseLock(id);
    return result;
  }

  async markAppliedWithWarning(id: string, warning: { code: string; message: string; details?: unknown }): Promise<MutationPlan> {
    const result = await this.updateStatus(id, 'applied_with_warning', warning);
    await this.releaseLock(id);
    return result;
  }

  async markFailedAfterWrite(id: string, warning: { code: string; message: string; details?: unknown }): Promise<MutationPlan> {
    const result = await this.updateStatus(id, 'failed_after_write', warning);
    await this.releaseLock(id);
    return result;
  }

  async markCancelled(id: string): Promise<MutationPlan> {
    const result = await this.updateStatus(id, 'cancelled');
    await this.releaseLock(id);
    return result;
  }

  async cleanup(): Promise<number> {
    let removed = 0;
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return 0;
    }
    for (const f of files) {
      // Skip lock files — they're cleaned up by releaseLock().
      if (f.endsWith('.lock')) continue;
      if (!f.endsWith('.json') || !f.startsWith('plan_')) continue;
      const id = f.slice(0, -5);
      const plan = await this.get(id);
      // Remove only terminal plans that don't carry "write happened" semantics.
      // applied_with_warning and failed_after_write are KEPT (caller may need to
      // inspect them post-mortem).
      if (plan && (plan.status === 'expired' || plan.status === 'cancelled' || plan.status === 'applied')) {
        try {
          await unlink(this.pathFor(id));
          removed++;
          // Also clean up any stale lock for this plan.
          await this.releaseLock(id);
        } catch { /* ignore */ }
      }
    }
    return removed;
  }

  private async updateStatus(
    id: string,
    status: 'applied' | 'applied_with_warning' | 'failed_after_write' | 'cancelled',
    warning?: { code: string; message: string; details?: unknown },
  ): Promise<MutationPlan> {
    const plan = await this.get(id);
    if (!plan) {
      throw new McpUserError('PLAN_NOT_FOUND', `Plan ${id} not found`, { planId: id });
    }
    if (plan.id !== id) {
      throw new McpUserError('PLAN_STORE_ERROR', 'Plan ID mismatch', { planId: id });
    }
    plan.status = status;
    if (status === 'applied' || status === 'applied_with_warning' || status === 'failed_after_write') {
      plan.appliedAt = new Date().toISOString();
    }
    if (warning) {
      plan.warning = warning;
    }
    await writeFile(this.pathFor(id), JSON.stringify(plan), { mode: 0o600, encoding: 'utf8' });
    return plan;
  }

  private pathFor(id: string): string {
    // Sanitize: only allow plan_<uuid> format. If the ID doesn't match,
    // treat it as not-found (return a safe placeholder path that won't exist).
    if (!/^plan_[a-f0-9-]+$/i.test(id)) {
      // Return a path that will never exist; get() will return null.
      return join(this.dir, 'invalid-id-placeholder.json');
    }
    return join(this.dir, `${id}.json`);
  }

  /**
   * Lock file path for a plan ID. Used by claimForApply for atomic
   * race-condition protection via fs.open(..., 'wx').
   */
  private lockPathFor(id: string): string {
    return join(this.dir, `${id}.lock`);
  }

  private async ensureDir(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw new McpUserError('PLAN_STORE_ERROR', `Failed to create plan store directory ${this.dir}: ${err instanceof Error ? err.message : String(err)}`, { dir: this.dir });
    }
  }
}

/* ---------------- Memory store (for tests) ---------------- */

export class MemoryPlanStore implements PlanStore {
  private readonly plans = new Map<string, MutationPlan>();

  async create(input: Omit<MutationPlan, 'id' | 'createdAt' | 'expiresAt' | 'status' | 'checksum' | 'appliedAt' | 'warning'> & { ttlSeconds: number }): Promise<MutationPlan> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000);
    const plan: MutationPlan = {
      id: generatePlanId(),
      version: 1,
      operation: input.operation,
      collection: input.collection,
      payload: input.payload,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: 'pending',
      checksum: computeChecksum(input.payload),
      summary: input.summary,
    };
    const json = JSON.stringify(plan);
    // Memory store does not enforce maxBytes (use file store for that).
    void json;
    this.plans.set(plan.id, plan);
    return plan;
  }

  async get(id: string): Promise<MutationPlan | null> {
    const plan = this.plans.get(id);
    if (!plan) return null;
    if ((plan.status === 'pending' || plan.status === 'applying') && new Date(plan.expiresAt).getTime() < Date.now()) {
      plan.status = 'expired';
      this.plans.set(id, plan);
    }
    return plan;
  }

  async claimForApply(id: string): Promise<MutationPlan> {
    const plan = await this.get(id);
    if (!plan) {
      throw new McpUserError('PLAN_NOT_FOUND', `Plan ${id} not found`, { planId: id });
    }
    if (plan.status === 'applying') {
      throw new McpUserError(
        'PLAN_ALREADY_IN_PROGRESS',
        `Plan ${id} is already being applied by another request.`,
        { planId: id, status: plan.status },
      );
    }
    if (plan.status === 'applied' || plan.status === 'applied_with_warning' || plan.status === 'failed_after_write') {
      throw new McpUserError(
        'PLAN_ALREADY_APPLIED',
        `Plan ${id} was already applied at ${plan.appliedAt ?? '(unknown time)'}.`,
        { planId: id, appliedAt: plan.appliedAt, status: plan.status },
      );
    }
    if (plan.status === 'cancelled') {
      throw new McpUserError('PLAN_CANCELLED', `Plan ${id} was cancelled and cannot be applied.`, { planId: id });
    }
    if (plan.status === 'expired') {
      throw new McpUserError('PLAN_EXPIRED', `Plan ${id} has expired.`, { planId: id, expiresAt: plan.expiresAt });
    }
    if (plan.status !== 'pending') {
      throw new McpUserError('PLAN_STORE_ERROR', `Plan ${id} has unexpected status '${plan.status}'`, { planId: id, status: plan.status });
    }
    plan.status = 'applying';
    this.plans.set(id, plan);
    return plan;
  }

  async markApplied(id: string): Promise<MutationPlan> {
    return this.updateStatus(id, 'applied');
  }

  async markAppliedWithWarning(id: string, warning: { code: string; message: string; details?: unknown }): Promise<MutationPlan> {
    return this.updateStatus(id, 'applied_with_warning', warning);
  }

  async markFailedAfterWrite(id: string, warning: { code: string; message: string; details?: unknown }): Promise<MutationPlan> {
    return this.updateStatus(id, 'failed_after_write', warning);
  }

  async markCancelled(id: string): Promise<MutationPlan> {
    return this.updateStatus(id, 'cancelled');
  }

  private updateStatus(
    id: string,
    status: 'applied' | 'applied_with_warning' | 'failed_after_write' | 'cancelled',
    warning?: { code: string; message: string; details?: unknown },
  ): MutationPlan {
    const plan = this.plans.get(id);
    if (!plan) throw new McpUserError('PLAN_NOT_FOUND', `Plan ${id} not found`, { planId: id });
    plan.status = status;
    if (status === 'applied' || status === 'applied_with_warning' || status === 'failed_after_write') {
      plan.appliedAt = new Date().toISOString();
    }
    if (warning) {
      plan.warning = warning;
    }
    this.plans.set(id, plan);
    return plan;
  }

  async cleanup(): Promise<number> {
    let removed = 0;
    for (const [id, plan] of this.plans) {
      if (plan.status === 'expired' || plan.status === 'cancelled' || plan.status === 'applied') {
        this.plans.delete(id);
        removed++;
      }
    }
    return removed;
  }
}

/* ---------------- Factory ---------------- */

export function createPlanStore(
  backend: 'file' | 'memory',
  dir: string,
  maxBytes: number,
  logger: Logger,
): PlanStore {
  if (backend === 'memory') {
    return new MemoryPlanStore();
  }
  return new FilePlanStore(dir, maxBytes, logger);
}

/**
 * Verify a loaded plan's checksum matches its payload.
 * Throws PLAN_CHECKSUM_MISMATCH on mismatch.
 */
export function verifyPlanChecksum(plan: MutationPlan): void {
  const expected = computeChecksum(plan.payload);
  if (expected !== plan.checksum) {
    throw new McpUserError(
      'PLAN_CHECKSUM_MISMATCH',
      `Plan ${plan.id} checksum mismatch — payload may have been corrupted or tampered with`,
      { planId: plan.id, expected, actual: plan.checksum },
    );
  }
}
