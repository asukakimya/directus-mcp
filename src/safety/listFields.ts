import type { CollectionSchema } from '../directus/schema.js';

/**
 * Shared field-selection helpers for read_items purpose:"list" and search_items.
 *
 * These are GENERIC Directus helpers — no domain-specific logic.
 * Field selection is based on schema field names and types only.
 */

const SEARCHABLE_FIELD_PRIORITY = [
  'company', 'name', 'title', 'description', 'code',
  'stock_code', 'email', 'phone', 'website', 'url',
];

const LONG_FIELD_NAMES = new Set([
  'ai_info', 'description', 'system_prompt', 'messages',
  'products', 'content', 'body', 'markdown', 'text', 'notes', 'data', 'metadata',
]);

/**
 * Build short display fields for purpose:"list" or search output.
 *
 * Priority: PK + first display field (company/name/title/code) + website/email/phone/status.
 * Never includes long fields.
 */
export function buildListPurposeFields(schema: CollectionSchema): string[] {
  const fields: string[] = [];
  const pk = schema.primaryKey ?? 'id';
  if (schema.fields[pk]) fields.push(pk);

  const displayPriority = ['company', 'name', 'title', 'stock_code', 'code', 'firstname', 'lastname'];
  for (const f of displayPriority) {
    if (schema.fields[f] && !fields.includes(f)) {
      fields.push(f);
      break; // only one primary display field
    }
  }

  const secondaryPriority = ['website', 'url', 'email', 'phone', 'status'];
  for (const f of secondaryPriority) {
    if (schema.fields[f] && !fields.includes(f)) {
      fields.push(f);
    }
  }

  // Fallback: if nothing found, use PK + first 5 scalar fields (skip long fields).
  if (fields.length <= 1) {
    let count = 0;
    for (const f of Object.values(schema.fields)) {
      if (count >= 5) break;
      if (f.isPrimaryKey) continue;
      if (LONG_FIELD_NAMES.has(f.field)) continue;
      if (!fields.includes(f.field)) {
        fields.push(f.field);
        count++;
      }
    }
  }

  return fields;
}

/**
 * Auto-select searchable string fields from schema.
 * Only includes fields that exist in schema and are string/text type.
 */
export function autoSelectSearchFields(schema: CollectionSchema): string[] {
  const fields: string[] = [];
  for (const f of SEARCHABLE_FIELD_PRIORITY) {
    if (schema.fields[f] && (schema.fields[f].type === 'string' || schema.fields[f].type === 'text')) {
      fields.push(f);
    }
  }
  return fields;
}
