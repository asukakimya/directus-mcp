import { DirectusRestClient } from './rest.js';

/**
 * Low-level Directus Items API operations.
 *
 * These functions are intentionally thin: they only build the HTTP call.
 * All safety layers (normalisation, schema validation, dry-run, verify)
 * live in higher-level modules.
 */

export type DirectusQuery = Record<string, unknown>;

export async function readItems(
  client: DirectusRestClient,
  collection: string,
  query?: DirectusQuery,
): Promise<unknown> {
  return client.request({
    method: 'GET',
    path: `/items/${encodeURIComponent(collection)}`,
    query,
  });
}

export async function readItem(
  client: DirectusRestClient,
  collection: string,
  key: string | number,
  query?: DirectusQuery,
): Promise<unknown> {
  return client.request({
    method: 'GET',
    path: `/items/${encodeURIComponent(collection)}/${encodeURIComponent(String(key))}`,
    query,
  });
}

export async function createItem(
  client: DirectusRestClient,
  collection: string,
  data: Record<string, unknown>,
  query?: DirectusQuery,
): Promise<unknown> {
  return client.request({
    method: 'POST',
    path: `/items/${encodeURIComponent(collection)}`,
    query,
    body: data,
  });
}

export async function createItems(
  client: DirectusRestClient,
  collection: string,
  data: Record<string, unknown>[],
  query?: DirectusQuery,
): Promise<unknown> {
  return client.request({
    method: 'POST',
    path: `/items/${encodeURIComponent(collection)}`,
    query,
    body: data,
  });
}

export async function updateItem(
  client: DirectusRestClient,
  collection: string,
  key: string | number,
  data: Record<string, unknown>,
  query?: DirectusQuery,
): Promise<unknown> {
  return client.request({
    method: 'PATCH',
    path: `/items/${encodeURIComponent(collection)}/${encodeURIComponent(String(key))}`,
    query,
    body: data,
  });
}

/**
 * Apply the same partial `data` to multiple items identified by `keys`.
 * Uses Directus bulk PATCH endpoint (`PATCH /items/{collection}` with
 * `{ keys, data }` body).
 *
 * NOTE: This endpoint applies the SAME data to all keys. If you need
 * per-item different data, use serial `updateItem` calls instead
 * (see `batchUpdateItems` in src/directus/mutations.ts).
 */
export async function updateItemsSameData(
  client: DirectusRestClient,
  collection: string,
  keys: Array<string | number>,
  data: Record<string, unknown>,
  query?: DirectusQuery,
): Promise<unknown> {
  return client.request({
    method: 'PATCH',
    path: `/items/${encodeURIComponent(collection)}`,
    query,
    body: { keys, data },
  });
}

export async function deleteItem(
  client: DirectusRestClient,
  collection: string,
  key: string | number,
): Promise<unknown> {
  return client.request({
    method: 'DELETE',
    path: `/items/${encodeURIComponent(collection)}/${encodeURIComponent(String(key))}`,
  });
}

export async function deleteItems(
  client: DirectusRestClient,
  collection: string,
  keys: Array<string | number>,
): Promise<unknown> {
  return client.request({
    method: 'DELETE',
    path: `/items/${encodeURIComponent(collection)}`,
    body: keys,
  });
}
