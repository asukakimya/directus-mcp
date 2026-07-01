import type { DirectusRestClient } from './rest.js';
import type {
  CollectionSchema,
  DirectusCollectionResponse,
  DirectusFieldResponse,
  DirectusRelationResponse,
  FieldSchema,
  RelationSchema,
} from './schema.js';
import { inferRelationType } from './schema.js';
import { McpUserError } from './errors.js';

/**
 * Schema cache with TTL.
 *
 * Loads `/collections`, `/fields/{collection}`, and `/relations`
 * and folds them into a `CollectionSchema`.
 */
export class SchemaService {
  private readonly cache = new Map<string, { expiresAt: number; schema: CollectionSchema }>();
  private readonly allCollectionsCache = { expiresAt: 0, value: new Map<string, CollectionSchema>() };

  constructor(
    private readonly client: DirectusRestClient,
    private readonly ttlMs: number,
  ) {}

  async loadCollectionSchema(collection: string): Promise<CollectionSchema> {
    const cached = this.cache.get(collection);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.schema;
    }

    const schema = await this.fetchCollectionSchema(collection);
    this.cache.set(collection, { expiresAt: now + this.ttlMs, schema });
    return schema;
  }

  async listCollections(): Promise<CollectionSchema[]> {
    const now = Date.now();
    if (this.allCollectionsCache.expiresAt > now && this.allCollectionsCache.value.size > 0) {
      return Array.from(this.allCollectionsCache.value.values());
    }

    const collections = await this.client.request<{ data?: DirectusCollectionResponse[] } | DirectusCollectionResponse[]>({
      path: '/collections',
    });
    const list = unwrap(collections);

    const out = new Map<string, CollectionSchema>();
    for (const c of list) {
      const name = c.collection;
      try {
        const schema = await this.fetchCollectionSchema(name);
        out.set(name, schema);
      } catch {
        // Skip collections we can't introspect (RBAC etc.) — they will
        // surface later as COLLECTION_NOT_ALLOWED when the LLM tries to use them.
      }
    }

    this.allCollectionsCache.value = out;
    this.allCollectionsCache.expiresAt = now + this.ttlMs;
    return Array.from(out.values());
  }

  invalidate(collection?: string): void {
    if (collection) {
      this.cache.delete(collection);
    } else {
      this.cache.clear();
      this.allCollectionsCache.value.clear();
      this.allCollectionsCache.expiresAt = 0;
    }
  }

  private async fetchCollectionSchema(collection: string): Promise<CollectionSchema> {
    const [colRes, fieldsRes, relationsRes] = await Promise.all([
      this.client.request<{ data?: DirectusCollectionResponse } | DirectusCollectionResponse>({
        path: `/collections/${encodeURIComponent(collection)}`,
      }),
      this.client.request<{ data?: DirectusFieldResponse[] } | DirectusFieldResponse[]>({
        path: `/fields/${encodeURIComponent(collection)}`,
      }),
      this.client.request<{ data?: DirectusRelationResponse[] } | DirectusRelationResponse[]>({
        path: '/relations',
      }),
    ]);

    const col = unwrapOne(colRes);
    const fieldsList = unwrap(fieldsRes);
    const allRelations = unwrap(relationsRes);

    const fields = buildFields(fieldsList);
    const relations: RelationSchema[] = allRelations
      .filter((r) => r.collection === collection || r.meta?.many_collection === collection)
      .map((r) => ({
        field: r.field,
        type: inferRelationType(r),
        collection: r.collection,
        relatedCollection: r.related_collection ?? undefined,
        junctionCollection: r.meta?.many_collection ?? undefined,
        manyField: r.meta?.many_field ?? undefined,
        oneField: r.meta?.one_field ?? undefined,
        junctionField: r.meta?.junction_field ?? undefined,
      }));

    // Attach relation back-reference onto matching fields.
    for (const rel of relations) {
      const f = fields[rel.field];
      if (f) f.relation = rel;
    }

    const singleton = col.meta?.singleton === true;
    let primaryKey: string | null = col.meta?.primary_key ?? null;
    if (!primaryKey) {
      const pkField = Object.values(fields).find((f) => f.isPrimaryKey);
      primaryKey = pkField?.field ?? null;
    }
    if (!primaryKey && fields['id']) primaryKey = 'id';
    if (!primaryKey) {
      throw new McpUserError('PRIMARY_KEY_NOT_FOUND', `Could not determine primary key for '${collection}'`, {
        collection,
      });
    }

    return {
      collection,
      singleton,
      primaryKey,
      fields,
      relations,
    };
  }
}

function buildFields(rawList: DirectusFieldResponse[]): Record<string, FieldSchema> {
  const out: Record<string, FieldSchema> = {};
  for (const raw of rawList) {
    const f: FieldSchema = {
      field: raw.field,
      type: raw.type ?? 'unknown',
      readonly: raw.meta?.readonly === true,
      required: raw.meta?.required === true,
      hidden: raw.meta?.hidden === true,
      special: raw.meta?.special ?? undefined,
      interface: raw.meta?.interface ?? null,
      options: raw.meta?.options ?? undefined,
      defaultValue: raw.schema?.default_value ?? undefined,
      isPrimaryKey: raw.schema?.is_primary_key === true,
    };
    out[raw.field] = f;
  }
  return out;
}

/**
 * Directus sometimes returns `{ data: T }`, sometimes returns `T` directly.
 * Handle both gracefully.
 */
function unwrap<T>(res: { data?: T[] } | T[]): T[] {
  if (Array.isArray(res)) return res;
  return res.data ?? [];
}

function unwrapOne<T>(res: { data?: T } | T): T {
  if (res && typeof res === 'object' && 'data' in res) {
    return (res as { data: T }).data;
  }
  return res as T;
}
