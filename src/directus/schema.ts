/**
 * Internal schema model used by validators.
 *
 * Directus returns a fairly complex shape from `/fields/{collection}`
 * and `/relations`. We collapse it into a simpler `CollectionSchema`
 * that the validators can reason about cheaply.
 */

export type RelationType = 'm2o' | 'o2m' | 'm2m' | 'm2a' | 'unknown';

export interface FieldSchema {
  field: string;
  type: string;
  readonly: boolean;
  required: boolean;
  hidden?: boolean;
  special?: string[];
  interface?: string | null;
  options?: unknown;
  defaultValue?: unknown;
  relation?: RelationSchema;
  /** True when this field is the primary key (from `schema.is_primary_key`). */
  isPrimaryKey?: boolean;
}

export interface RelationSchema {
  field: string;
  type: RelationType;
  collection: string;
  relatedCollection?: string;
  junctionCollection?: string;
  manyField?: string;
  oneField?: string;
  junctionField?: string;
}

export interface CollectionSchema {
  collection: string;
  singleton: boolean;
  primaryKey: string | null;
  fields: Record<string, FieldSchema>;
  relations: RelationSchema[];
}

/* ---------------- Directus raw shapes ---------------- */

export interface DirectusFieldResponse {
  collection: string;
  field: string;
  type: string;
  schema?: {
    is_primary_key?: boolean;
    is_nullable?: boolean;
    has_auto_increment?: boolean;
    default_value?: unknown;
  } | null;
  meta?: {
    interface?: string | null;
    special?: string[] | null;
    options?: unknown | null;
    hidden?: boolean;
    readonly?: boolean;
    required?: boolean;
  } | null;
}

export interface DirectusCollectionResponse {
  collection: string;
  meta?: {
    singleton?: boolean;
    primary_key?: string | null;
    note?: string | null;
    icon?: string | null;
  } | null;
  schema?: {
    name?: string;
  } | null;
}

export interface DirectusRelationResponse {
  collection: string;
  field: string;
  related_collection: string | null;
  meta?: {
    many_collection?: string;
    many_field?: string;
    one_collection?: string;
    one_field?: string | null;
    junction_field?: string | null;
  } | null;
  schema?: {
    on_delete?: string | null;
  } | null;
}

/* ---------------- Builders ---------------- */

/**
 * Determine the relation type from a raw Directus relation object.
 * Directus v11 relation schema fields:
 *   - m2o: `related_collection` non-null + `meta.many_field === field`
 *   - o2m: `meta.many_collection` set, `meta.one_field === field`
 *   - m2m: junction collection present (meta.many_collection !== collection)
 *   - m2a: `related_collection` is null AND `meta.one_collection_field` set
 */
export function inferRelationType(raw: DirectusRelationResponse): RelationType {
  if (raw.related_collection === null && raw.meta?.many_collection) {
    return 'm2a';
  }
  if (raw.meta?.junction_field) {
    return 'm2m';
  }
  if (raw.related_collection && raw.meta?.many_field === raw.field) {
    return 'm2o';
  }
  if (raw.meta?.many_collection === raw.collection && raw.meta?.many_field === raw.field) {
    // could be either side; default to o2m if one_field set
    return 'o2m';
  }
  return 'unknown';
}
