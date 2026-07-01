import type { CollectionSchema, FieldSchema } from './schema.js';
import { McpUserError } from './errors.js';

/**
 * Field-level validation for create / update payloads.
 *
 * Strict policy (per spec §10.2):
 *   - Unknown fields are REJECTED (not silently dropped). Hiding LLM
 *     mistakes is more dangerous than failing loudly.
 *   - Readonly fields are REJECTED.
 *   - System-managed audit fields (user_created, date_created,
 *     user_updated, date_updated) are REJECTED on mutation.
 *   - Primary key update on PATCH is REJECTED.
 *   - For create: required fields (without a default) must be present.
 */

const SYSTEM_READONLY_FIELDS = new Set<string>([
  'user_created',
  'date_created',
  'user_updated',
  'date_updated',
]);

export interface FieldValidationContext {
  /** 'create' = primary key may be omitted; 'update' = primary key may not be in patch. */
  mode: 'create' | 'update';
  collection: string;
}

export function validateFields(
  schema: CollectionSchema,
  data: Record<string, unknown>,
  ctx: FieldValidationContext,
): void {
  for (const fieldName of Object.keys(data)) {
    const fieldSchema = schema.fields[fieldName];
    if (!fieldSchema) {
      throw new McpUserError(
        'UNKNOWN_FIELD',
        `Field '${fieldName}' does not exist in collection '${schema.collection}'`,
        { collection: schema.collection, field: fieldName },
      );
    }

    // Most-specific checks first so callers get the right error code.
    if (ctx.mode === 'update' && fieldSchema.isPrimaryKey) {
      throw new McpUserError(
        'PRIMARY_KEY_UPDATE_DENIED',
        `Primary key field '${fieldName}' cannot be updated`,
        { collection: schema.collection, field: fieldName },
      );
    }

    if (SYSTEM_READONLY_FIELDS.has(fieldName)) {
      throw new McpUserError(
        'READONLY_FIELD',
        `Field '${fieldName}' is a system-managed audit field and cannot be mutated`,
        { collection: schema.collection, field: fieldName },
      );
    }

    if (fieldSchema.readonly) {
      throw new McpUserError(
        'READONLY_FIELD',
        `Field '${fieldName}' is readonly in collection '${schema.collection}'`,
        { collection: schema.collection, field: fieldName },
      );
    }
  }

  if (ctx.mode === 'create') {
    for (const fieldSchema of Object.values(schema.fields)) {
      if (!fieldSchema.required) continue;
      if (fieldSchema.defaultValue !== undefined && fieldSchema.defaultValue !== null) continue;
      if (fieldSchema.isPrimaryKey) continue; // auto-generated
      if (SYSTEM_READONLY_FIELDS.has(fieldSchema.field)) continue;
      if (!(fieldSchema.field in data)) {
        throw new McpUserError(
          'REQUIRED_FIELD_MISSING',
          `Required field '${fieldSchema.field}' is missing in create payload for '${schema.collection}'`,
          { collection: schema.collection, field: fieldSchema.field },
        );
      }
    }
  }
}

/**
 * Strip `null` values from a patch payload (Directus PATCH treats null
 * as "set to NULL"). The sidecar does NOT auto-strip — this helper is
 * only used when the LLM explicitly opts in via a future flag.
 */
export function filterExplicitNulls(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== null) out[k] = v;
  }
  return out;
}

export function getFieldSchema(schema: CollectionSchema, field: string): FieldSchema | undefined {
  return schema.fields[field];
}
