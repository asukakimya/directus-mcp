import type { AppConfig } from '../config.js';
import { McpUserError } from '../directus/errors.js';

export type PlanPolicyOperation = 'create' | 'update' | 'delete' | 'bulk' | 'update_by_query';

const POLICY_META: Record<PlanPolicyOperation, { env: string; label: string }> = {
  create: { env: 'CREATE_REQUIRES_PLAN', label: 'create' },
  update: { env: 'UPDATE_REQUIRES_PLAN', label: 'update' },
  delete: { env: 'DELETE_REQUIRES_PLAN', label: 'delete' },
  bulk: { env: 'BULK_REQUIRES_PLAN', label: 'bulk update' },
  update_by_query: { env: 'UPDATE_BY_QUERY_REQUIRES_PLAN', label: 'update-by-query' },
};

export function operationRequiresPlan(config: AppConfig, operation: PlanPolicyOperation): boolean {
  switch (operation) {
    case 'create':
      return config.createRequiresPlan ?? config.applyRequiresPlan;
    case 'update':
      return config.updateRequiresPlan ?? config.applyRequiresPlan;
    case 'delete':
      return config.deleteRequiresPlan ?? config.applyRequiresPlan;
    case 'bulk':
      return config.bulkRequiresPlan ?? config.applyRequiresPlan;
    case 'update_by_query':
      return config.updateByQueryRequiresPlan ?? true;
  }
}

export function assertDirectWriteAllowed(
  config: AppConfig,
  operation: PlanPolicyOperation,
  details: Record<string, unknown>,
): void {
  if (!operationRequiresPlan(config, operation)) return;

  const meta = POLICY_META[operation];
  throw new McpUserError(
    'APPLY_REQUIRES_PLAN',
    `Direct ${meta.label} is disabled by ${meta.env}=true.`,
    { ...details, operation, planPolicyEnv: meta.env },
  );
}
