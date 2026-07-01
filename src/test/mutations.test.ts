import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DirectusRestClient, DirectusApiError } from '../../src/directus/rest.js';
import {
  readItems,
  readItem,
  createItem,
  createItems,
  updateItem,
  updateItemsSameData,
  deleteItem,
  deleteItems,
} from '../../src/directus/client.js';
import { inferRelationType } from '../../src/directus/schema.js';
import type { DirectusRelationResponse } from '../../src/directus/schema.js';

describe('DirectusRestClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('serialises query params via qs brackets format', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const client = new DirectusRestClient('https://example.com/', 'tok');
    await readItems(client, 'articles', { fields: ['id', 'title'], filter: { id: { _in: [1, 2] } } });

    const call = fetchMock.mock.calls[0]!;
    const url = call[1]?.url ?? (call[0] as URL).toString();
    // qs with arrayFormat:'brackets' + encodeValuesOnly:true produces
    // un-encoded brackets: fields[]=id&fields[]=title
    expect(url).toContain('fields[]=id');
    expect(url).toContain('fields[]=title');
    expect(url).toContain('filter[id][_in][]=1');
    expect(url).toContain('filter[id][_in][]=2');
  });

  it('sends Authorization: Bearer header', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }),
    );
    const client = new DirectusRestClient('https://example.com', 'tok-123');
    await client.request({ path: '/collections' });
    const call = fetchMock.mock.calls[0]!;
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-123');
  });

  it('serialises body as JSON when present', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"data":{"id":1}}', { status: 200 }),
    );
    const client = new DirectusRestClient('https://example.com', 'tok');
    await createItem(client, 'articles', { title: 'Intro to MCP' });
    const call = fetchMock.mock.calls[0]!;
    const init = call[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ title: 'Intro to MCP' }));
  });

  it('does not set Content-Type when body is undefined', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }),
    );
    const client = new DirectusRestClient('https://example.com', 'tok');
    await readItem(client, 'articles', 1);
    const call = fetchMock.mock.calls[0]!;
    const init = call[1] as RequestInit;
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('throws DirectusApiError on non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ errors: [{ message: 'not found' }] }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = new DirectusRestClient('https://example.com', 'tok');
    await expect(client.request({ path: '/items/articles/999' })).rejects.toBeInstanceOf(
      DirectusApiError,
    );
  });

  it('builds URL with single leading-slash path on a non-slash-terminated base', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }),
    );
    const client = new DirectusRestClient('https://example.com', 'tok');
    await client.request({ path: '/items/articles' });
    const call = fetchMock.mock.calls[0]!;
    const url = (call[0] as URL).toString();
    expect(url.startsWith('https://example.com/items/articles')).toBe(true);
  });
});

describe('items operations', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('createItems sends array body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"data":[]}', { status: 200 }),
    );
    const client = new DirectusRestClient('https://example.com', 'tok');
    await createItems(client, 'articles', [{ title: 'A' }, { title: 'B' }]);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBe(JSON.stringify([{ title: 'A' }, { title: 'B' }]));
  });

  it('updateItem PATCHes /items/{collection}/{key}', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"data":{"id":1}}', { status: 200 }),
    );
    const client = new DirectusRestClient('https://example.com', 'tok');
    await updateItem(client, 'articles', 1, { slug: 'x' });
    const url = (fetchMock.mock.calls[0]![0] as URL).toString();
    expect(url).toContain('/items/articles/1');
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('PATCH');
  });

  it('updateItemsSameData sends { keys, data } body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }),
    );
    const client = new DirectusRestClient('https://example.com', 'tok');
    await updateItemsSameData(client, 'articles', [1, 2], { status: 'published' });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      keys: [1, 2],
      data: { status: 'published' },
    });
  });

  it('deleteItems sends array body on bulk DELETE', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }),
    );
    const client = new DirectusRestClient('https://example.com', 'tok');
    await deleteItems(client, 'articles', [1, 2]);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('DELETE');
    expect(init.body).toBe(JSON.stringify([1, 2]));
  });

  it('deleteItem single', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }),
    );
    const client = new DirectusRestClient('https://example.com', 'tok');
    await deleteItem(client, 'articles', 1);
    const url = (fetchMock.mock.calls[0]![0] as URL).toString();
    expect(url).toContain('/items/articles/1');
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('DELETE');
    expect((fetchMock.mock.calls[0]![1] as RequestInit).body).toBeUndefined();
  });
});

describe('inferRelationType', () => {
  it('returns m2o when related_collection set and meta.many_field matches field', () => {
    const raw: DirectusRelationResponse = {
      collection: 'products',
      field: 'supplier_id',
      related_collection: 'articles',
      meta: { many_collection: 'products', many_field: 'supplier_id', one_collection: 'articles', one_field: null },
      schema: null,
    };
    expect(inferRelationType(raw)).toBe('m2o');
  });

  it('returns m2m when meta.junction_field is set', () => {
    const raw: DirectusRelationResponse = {
      collection: 'products',
      field: 'categories',
      related_collection: 'categories',
      meta: { many_collection: 'products', many_field: 'categories', one_collection: 'categories', one_field: null, junction_field: 'products_id' },
      schema: null,
    };
    expect(inferRelationType(raw)).toBe('m2m');
  });

  it('returns m2a when related_collection is null and meta.many_collection is set', () => {
    const raw: DirectusRelationResponse = {
      collection: 'pages',
      field: 'item',
      related_collection: null,
      meta: { many_collection: 'pages', many_field: 'item', one_collection: null, one_field: null, junction_field: null },
      schema: null,
    };
    expect(inferRelationType(raw)).toBe('m2a');
  });

  it('returns unknown when no signals match', () => {
    const raw: DirectusRelationResponse = {
      collection: 'x',
      field: 'y',
      related_collection: null,
      meta: null,
      schema: null,
    };
    expect(inferRelationType(raw)).toBe('unknown');
  });
});
