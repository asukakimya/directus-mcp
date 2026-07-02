import { describe, it, expect } from 'vitest';
import {
  truncateText,
  formatSchemaOverviewText,
  formatSchemaDetailText,
  formatReadItemsText,
  formatReadItemText,
  formatMutationText,
  extractRecords,
  type TextLimits,
  type CollectionTextInfo,
} from '../../src/safety/textFormat.js';

const limits: TextLimits = {
  schemaTextMaxFields: 80,
  readTextMaxRows: 10,
  readTextMaxChars: 12000,
};

const smallLimits: TextLimits = {
  schemaTextMaxFields: 3,
  readTextMaxRows: 2,
  readTextMaxChars: 200,
};

describe('truncateText', () => {
  it('returns short text unchanged', () => {
    expect(truncateText('hello', 100)).toBe('hello');
  });

  it('truncates with marker when too long', () => {
    const out = truncateText('a'.repeat(300), 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out).toMatch(/\[truncated/);
  });

  it('handles zero max', () => {
    const out = truncateText('hello', 0);
    expect(out).toMatch(/\[truncated/);
  });
});

describe('formatSchemaOverviewText', () => {
  it('lists collections with pk and counts', () => {
    const text = formatSchemaOverviewText(
      [
        { collection: 'articles', singleton: false, primaryKey: 'id', fieldCount: 5, relationCount: 2 },
        { collection: 'authors', singleton: false, primaryKey: 'id', fieldCount: 3, relationCount: 0 },
      ],
      limits,
    );
    expect(text).toContain('Collections (2):');
    expect(text).toContain('articles (pk=id, singleton=no, fields=5, relations=2)');
    expect(text).toContain('authors (pk=id, singleton=no, fields=3, relations=0)');
  });

  it('handles empty collection list', () => {
    const text = formatSchemaOverviewText([], limits);
    expect(text).toContain('No collections');
  });
});

describe('formatSchemaDetailText', () => {
  const sampleCollection: CollectionTextInfo = {
    collection: 'articles',
    singleton: false,
    primaryKey: 'id',
    fields: [
      { field: 'id', type: 'integer', readonly: false, required: false, isPrimaryKey: true, hasRelation: false },
      { field: 'title', type: 'string', readonly: false, required: true, isPrimaryKey: false, hasRelation: false },
      { field: 'slug', type: 'string', readonly: false, required: false, isPrimaryKey: false, hasRelation: false },
      { field: 'status', type: 'string', readonly: false, required: false, isPrimaryKey: false, hasRelation: false, interface: 'dropdown', special: null, defaultValue: 'draft' },
      { field: 'author', type: 'integer', readonly: false, required: true, isPrimaryKey: false, hasRelation: true },
    ],
    relations: [{ field: 'author', type: 'm2o', relatedCollection: 'authors' }],
  };

  it('renders collection, primary key, fields, relations', () => {
    const text = formatSchemaDetailText([sampleCollection], limits);
    expect(text).toContain('Collection: articles');
    expect(text).toContain('Primary key: id');
    expect(text).toContain('Singleton: no');
    expect(text).toContain('Fields:');
    expect(text).toContain('- id: integer primary');
    expect(text).toContain('- title: string required');
    expect(text).toContain('- author: integer required relation');
    expect(text).toContain('- status: string iface:dropdown default:"draft"');
    expect(text).toContain('Relations:');
    expect(text).toContain('- author (m2o) -> authors');
  });

  it('truncates field list when over SCHEMA_TEXT_MAX_FIELDS', () => {
    const manyFields: CollectionTextInfo = {
      ...sampleCollection,
      fields: Array.from({ length: 10 }, (_, i) => ({
        field: `f${i}`,
        type: 'string',
        readonly: false,
        required: false,
        isPrimaryKey: false,
        hasRelation: false,
      })),
    };
    const text = formatSchemaDetailText([manyFields], smallLimits);
    expect(text).toContain('- f0:');
    expect(text).toContain('- f1:');
    expect(text).toContain('- f2:');
    expect(text).toContain('more fields truncated');
    // f3+ should not appear as field lines (only the truncation marker)
    expect(text).not.toContain('- f3:');
  });

  it('omits Relations section when no relations', () => {
    const noRel: CollectionTextInfo = { ...sampleCollection, relations: [] };
    const text = formatSchemaDetailText([noRel], limits);
    expect(text).not.toContain('Relations:');
  });
});

describe('extractRecords', () => {
  it('extracts from { data: [...] }', () => {
    expect(extractRecords({ data: [{ id: 1 }, { id: 2 }] })).toEqual([{ id: 1 }, { id: 2 }]);
  });
  it('extracts from { data: {...} } (single)', () => {
    expect(extractRecords({ data: { id: 1 } })).toEqual([{ id: 1 }]);
  });
  it('extracts from raw array', () => {
    expect(extractRecords([1, 2, 3])).toEqual([1, 2, 3]);
  });
  it('returns empty array for null/undefined', () => {
    expect(extractRecords(null)).toEqual([]);
    expect(extractRecords(undefined)).toEqual([]);
  });
});

describe('formatReadItemsText', () => {
  it('renders header + data rows', () => {
    const text = formatReadItemsText(
      'articles',
      { fields: ['id', 'title'], limit: 10 },
      { data: [{ id: 1, title: 'A' }, { id: 2, title: 'B' }] },
      limits,
    );
    expect(text).toContain('Collection: articles');
    expect(text).toContain('Count: 2');
    expect(text).toContain('Query: fields=');
    expect(text).toContain('[0] {"id":1,"title":"A"}');
    expect(text).toContain('[1] {"id":2,"title":"B"}');
  });

  it('handles empty data explicitly', () => {
    const text = formatReadItemsText('articles', { limit: 10 }, { data: [] }, limits);
    expect(text).toContain('Count: 0');
    expect(text).toContain('(0 items returned)');
  });

  it('truncates rows when over READ_TEXT_MAX_ROWS', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: i }));
    const text = formatReadItemsText('articles', { limit: 5 }, { data: many }, smallLimits);
    expect(text).toContain('[0]');
    expect(text).toContain('[1]');
    expect(text).toContain('more rows truncated');
  });

  it('respects READ_TEXT_MAX_CHARS', () => {
    const huge = Array.from({ length: 100 }, (_, i) => ({ id: i, body: 'x'.repeat(500) }));
    const text = formatReadItemsText('articles', { limit: 100 }, { data: huge }, limits);
    expect(text.length).toBeLessThanOrEqual(12000);
    expect(text).toMatch(/truncated/);
  });
});

describe('formatReadItemText', () => {
  it('renders the record JSON', () => {
    const text = formatReadItemText('articles', 1, { data: { id: 1, title: 'A' } }, limits);
    expect(text).toContain('Collection: articles');
    expect(text).toContain('Key: 1');
    expect(text).toContain('"id": 1');
    expect(text).toContain('"title": "A"');
  });

  it('handles missing record', () => {
    const text = formatReadItemText('articles', 999, { data: null }, limits);
    expect(text).toContain('item not found or empty');
  });
});

describe('formatMutationText', () => {
  it('renders update with before/after/diff', () => {
    const text = formatMutationText(
      {
        action: 'update',
        collection: 'articles',
        dryRun: true,
        ok: true,
        before: { id: 1, title: 'Old' },
        after: { id: 1, title: 'New' },
        diff: { title: { before: 'Old', after: 'New', changed: true } },
      },
      limits,
    );
    expect(text).toContain('DRY-RUN UPDATE articles — OK (dryRun=true)');
    expect(text).toContain('Before: {"id":1,"title":"Old"}');
    expect(text).toContain('After: {"id":1,"title":"New"}');
    expect(text).toContain('Diff (changed):');
    expect(text).toContain('title: "Old" -> "New"');
  });

  it('renders aborted batch with abortReason', () => {
    const text = formatMutationText(
      {
        action: 'update',
        collection: 'articles',
        dryRun: false,
        aborted: true,
        abortReason: 'preflight failed: VERIFY_FAILED — verify failed for 1 field(s)',
        ok: false,
        summary: { total: 5, ok: 0, failed: 5, dryRun: false },
      },
      limits,
    );
    expect(text).toContain('ABORTED UPDATE articles');
    expect(text).toContain('aborted=true');
    expect(text).toContain('Abort reason:');
    expect(text).toContain('VERIFY_FAILED');
  });

  it('renders error case', () => {
    const text = formatMutationText(
      {
        action: 'create',
        collection: 'articles',
        dryRun: false,
        ok: false,
        error: { code: 'UNKNOWN_FIELD', message: "Field 'bogus' does not exist", details: { field: 'bogus' } },
      },
      limits,
    );
    expect(text).toContain('CREATE articles — FAILED');
    expect(text).toContain('Error: UNKNOWN_FIELD');
    expect(text).toContain("Field 'bogus' does not exist");
    expect(text).toContain('Details:');
  });

  it('renders batch per-item results', () => {
    const text = formatMutationText(
      {
        action: 'update',
        collection: 'articles',
        dryRun: true,
        ok: false,
        summary: { total: 3, ok: 2, failed: 1, dryRun: true },
        results: [
          { key: 1, ok: true, diff: { title: { before: 'A', after: 'B', changed: true } } },
          { key: 2, ok: true, diff: { title: { before: 'C', after: 'C', changed: false } } },
          { key: 3, error: { code: 'VERIFY_FAILED', message: 'mismatch' } },
        ] as unknown[],
      },
      limits,
    );
    expect(text).toContain('Per-item results (3 total');
    expect(text).toContain('[1] OK changed: title');
    expect(text).toContain('[2] OK'); // no changed fields shown
    expect(text).toContain('[3] FAIL: VERIFY_FAILED');
  });

  it('truncates per-item results when over READ_TEXT_MAX_ROWS', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ key: i, ok: true }));
    const text = formatMutationText(
      {
        action: 'update',
        collection: 'articles',
        dryRun: true,
        ok: true,
        summary: { total: 5, ok: 5, failed: 0, dryRun: true },
        results: many as unknown[],
      },
      smallLimits,
    );
    expect(text).toContain('[0] OK');
    expect(text).toContain('[1] OK');
    expect(text).toContain('more items truncated');
  });

  it('renders delete with summary only', () => {
    const text = formatMutationText(
      {
        action: 'delete',
        collection: 'articles',
        dryRun: false,
        ok: true,
        summary: { total: 2, ok: 2, failed: 0, dryRun: false },
      },
      limits,
    );
    expect(text).toContain('DELETE articles — OK (dryRun=false) written=true');
    expect(text).toContain('Summary: total=2 ok=2 failed=0');
  });
});
