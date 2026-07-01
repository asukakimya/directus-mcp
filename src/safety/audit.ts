import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';

/**
 * Append-only audit log of mutation attempts (dry-run or apply).
 *
 * Each entry records: timestamp, action, collection, key(s), dryRun flag,
 * outcome (ok / error), and a short reason. Entries are kept in-memory
 * only; production deployments should ship them to a downstream sink.
 */

export interface AuditEntry {
  ts: string;
  action: 'create' | 'update' | 'delete' | 'dry_run';
  collection: string;
  keys: Array<string | number>;
  dryRun: boolean;
  ok: boolean;
  errorCode?: string;
  message?: string;
}

export class AuditLog {
  private readonly entries: AuditEntry[] = [];
  private readonly maxEntries = 1000;

  constructor(private readonly logger: Logger) {}

  record(entry: AuditEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
    this.logger.info(
      {
        audit: entry,
      },
      `audit ${entry.action} ${entry.collection} ok=${entry.ok} dryRun=${entry.dryRun}`,
    );
  }

  recent(limit = 50): AuditEntry[] {
    return this.entries.slice(-limit);
  }
}

export function createAuditLog(logger: Logger, _config: AppConfig): AuditLog {
  return new AuditLog(logger);
}
