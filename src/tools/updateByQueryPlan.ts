import { z } from 'zod';
import type { ToolContext } from '../mcp/server.js';
import { assertCollectionMutable, assertBatchSize } from '../safety/permissions.js';
import { normalizeJsonLike, isPlainObject } from '../safety/normalize.js';
import { readItemsWithGuards, batchUpdateItemsWithGuards, buildVerifyFromRecord } from '../directus/mutations.js';
import { McpUserError } from '../directus/errors.js';
import type { BundleVerification } from '../safety/bundles.js';

const Input = z.object({
  collection: z.string().min(1),
  query: z.unknown().optional(),
  query_json: z.unknown().optional(),
  data: z.unknown().optional(),
  data_json: z.unknown().optional(),
  /**
   * Fields to use for auto-generated verify objects. The MCP reads each
   * record and extracts these fields to build verify. This prevents the
   * model from guessing wrong verify values.
   * Example: ["company"] → verify: { company: "O KIMYA" }
   */
  verify_fields: z.array(z.string().min(1)).optional(),
  verify_fields_json: z.unknown().optional(),
  dry_run: z.boolean().optional(),
  /** Number of items per plan chunk (default 25). */
  chunk_size: z.number().int().min(1).max(100).optional(),
  /** Maximum total items to process (safety cap, default = MUTATION_MAX_BATCH_SIZE). */
  max_items: z.number().int().min(1).optional(),
});

interface ChunkPreviewItem {
  key: string | number;
  verify: Record<string, unknown>;
  changed: string[];
}

export const updateByQueryPlanTool = {
  name: 'directus_update_by_query_plan',
  description:
    'Create dry-run update plans for ALL records matching a query. The MCP reads records server-side, auto-generates verify objects from verify_fields, chunks them into plans, and returns a bundle_id. The model does NOT need to enumerate keys or build verify objects — just specify the query, data, and verify_fields. On approval, call directus_apply_plan_bundle with the returned bundle_id.',
  inputSchema: Input,
  handler: async (ctx: ToolContext, rawArgs: unknown) => {
    const args = Input.parse(rawArgs);

    // Resolve data.
    const rawData = args.data_json !== undefined ? args.data_json : args.data;
    const data = normalizeJsonLike(rawData) as Record<string, unknown> | undefined;
    if (!isPlainObject(data) || Object.keys(data).length === 0) {
      throw new McpUserError('INVALID_DATA_TYPE', 'data must be a non-empty object', { collection: args.collection });
    }

    // Resolve verify_fields.
    const rawVerifyFields = args.verify_fields_json !== undefined ? args.verify_fields_json : args.verify_fields;
    const verifyFieldsVal = normalizeJsonLike(rawVerifyFields);
    let verifyFields: string[] = [];
    if (Array.isArray(verifyFieldsVal)) {
      verifyFields = verifyFieldsVal.filter((f): f is string => typeof f === 'string');
    }

    // Resolve query.
    const rawQuery = args.query_json !== undefined ? args.query_json : args.query;
    const userQuery = normalizeJsonLike(rawQuery);
    if (userQuery !== undefined && userQuery !== null && !isPlainObject(userQuery)) {
      throw new McpUserError('INVALID_QUERY', 'query must be an object', { query: userQuery });
    }

    assertCollectionMutable(ctx.config, args.collection);
    const schema = await ctx.schema.loadCollectionSchema(args.collection);
    const pk = schema.primaryKey ?? 'id';
    if (!pk) {
      throw new McpUserError('PRIMARY_KEY_NOT_FOUND', `Cannot determine primary key for '${args.collection}'`, { collection: args.collection });
    }

    const dryRun = args.dry_run ?? true;
    if (!dryRun) {
      throw new McpUserError(
        'APPLY_REQUIRES_PLAN',
        `directus_update_by_query_plan only supports dry_run=true. It creates a plan bundle. Use directus_apply_plan_bundle to apply.`,
        { collection: args.collection },
      );
    }

    // Build query: force-include PK + verify_fields in fields.
    // Strip user-supplied fields to prevent override (same pattern as verify_fields_empty).
    const userQueryObj = (userQuery as Record<string, unknown> | undefined) ?? {};
    const { fields: _ignoredFields, ...safeUserQuery } = userQueryObj;
    void _ignoredFields;
    const requiredFields = Array.from(new Set([pk, ...verifyFields]));
    const maxItems = args.max_items ?? ctx.config.mutationMaxBatchSize;
    const userLimit = typeof safeUserQuery.limit === 'number' ? safeUserQuery.limit : undefined;
    const query = {
      ...safeUserQuery,
      fields: requiredFields,
      limit: userLimit !== undefined ? Math.min(userLimit, maxItems) : maxItems,
    };

    // Read records server-side.
    const readResult = await readItemsWithGuards(ctx.client, ctx.config, schema, query);
    const records = readResult.records;

    if (records.length === 0) {
      return {
        content: [{ type: 'text' as const, text: `DRY-RUN UPDATE_BY_QUERY ${args.collection} — 0 MATCHES\nNo records matched the query. No plans created.\n\nNEXT ACTION:\n- Check your query filter.\n- No apply needed.` }],
        structuredContent: {
          ok: true,
          dryRun: true,
          written: false,
          collection: args.collection,
          operation: 'update_by_query',
          totalMatched: 0,
          chunkCount: 0,
          planIds: [],
          changedFields: Object.keys(data),
          skipped: [],
          errors: [],
        },
      };
    }

    // Build batch items from REAL records only — no id guessing.
    const chunkSize = args.chunk_size ?? 25;
    assertBatchSize(ctx.config, chunkSize);
    const items: Array<{ key: string | number; data: Record<string, unknown>; verify: Record<string, unknown> }> = [];
    const skipped: Array<{ key: string | number; reason: string }> = [];
    const preview: ChunkPreviewItem[] = [];

    for (const record of records) {
      if (!isPlainObject(record)) continue;
      const key = (record as Record<string, unknown>)[pk];
      if (key === undefined || key === null) {
        skipped.push({ key: -1, reason: 'missing primary key in record' });
        continue;
      }
      const verify = buildVerifyFromRecord(record as Record<string, unknown>, verifyFields);
      if (!verify || Object.keys(verify).length === 0) {
        skipped.push({ key: key as string | number, reason: `none of verify_fields ${JSON.stringify(verifyFields)} found in record` });
        continue;
      }
      items.push({
        key: key as string | number,
        data: data as Record<string, unknown>,
        verify,
      });
      if (preview.length < 20) {
        preview.push({
          key: key as string | number,
          verify,
          changed: Object.keys(data as Record<string, unknown>),
        });
      }
    }

    if (items.length === 0) {
      return {
        content: [{ type: 'text' as const, text: `DRY-RUN UPDATE_BY_QUERY ${args.collection} — 0 USABLE RECORDS\nAll ${records.length} matched records were skipped.\n\nSkipped reasons:\n${skipped.map((s) => `  key=${s.key}: ${s.reason}`).join('\n')}` }],
        structuredContent: {
          ok: false,
          dryRun: true,
          written: false,
          collection: args.collection,
          operation: 'update_by_query',
          totalMatched: records.length,
          chunkCount: 0,
          planIds: [],
          changedFields: Object.keys(data),
          skipped,
          errors: [],
        },
      };
    }

    // Chunk items into groups and create a plan per chunk.
    const chunks: Array<typeof items> = [];
    for (let i = 0; i < items.length; i += chunkSize) {
      chunks.push(items.slice(i, i + chunkSize));
    }

    const planIds: string[] = [];
    const errors: Array<{ chunk: number; error: { code: string; message: string; details: unknown } }> = [];

    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci]!;
      try {
        // Run dry-run batch update for this chunk.
        const batchResult = await batchUpdateItemsWithGuards(ctx.client, ctx.config, schema, chunk, {
          dryRun: true,
          failFast: false,
          allowPartialApply: false,
        });

        if (batchResult.summary.aborted || batchResult.summary.failed > 0) {
          errors.push({
            chunk: ci,
            error: {
              code: batchResult.summary.aborted ? 'ABORTED_BY_PREFLIGHT' : 'BATCH_PARTIAL_FAILURE',
              message: batchResult.summary.abortReason ?? `${batchResult.summary.failed} items failed in chunk ${ci}`,
              details: { summary: batchResult.summary },
            },
          });
          continue;
        }

        // Create a plan for this chunk.
        const plan = await ctx.plans.create({
          operation: 'batch_update_items',
          collection: args.collection,
          payload: {
            type: 'batch_update_items',
            items: chunk,
            allowPartialApply: false,
            failFast: false,
          },
          summary: {
            affectedKeys: chunk.map((i) => i.key),
            itemCount: chunk.length,
            changedFields: Object.keys(data as Record<string, unknown>),
          },
          ttlSeconds: ctx.config.planTtlSeconds,
          maxBytes: ctx.config.planMaxBytes,
        } as never);
        planIds.push(plan.id);
      } catch (err) {
        errors.push({
          chunk: ci,
          error: err instanceof McpUserError
            ? { code: err.errorCode, message: err.message, details: err.details }
            : { code: 'DIRECTUS_API_ERROR', message: err instanceof Error ? err.message : String(err), details: {} },
        });
      }
    }

    // Create bundle if we have any plans.
    let bundleId: string | undefined;
    let bundleExpiresAt: string | undefined;
    if (planIds.length > 0) {
      const verification: BundleVerification = {
        type: 'fields_value',
        expected: data as Record<string, unknown>,
        query: { fields: [pk, ...verifyFields], limit: maxItems, ...(safeUserQuery.filter ? { filter: safeUserQuery.filter } : {}) },
      };
      const bundle = await ctx.bundles.create({
        operation: 'update_by_query',
        collection: args.collection,
        planIds,
        summary: {
          totalMatched: items.length,
          chunkCount: planIds.length,
          chunkSize,
          changedFields: Object.keys(data as Record<string, unknown>),
          affectedKeys: items.map((i) => i.key),
        },
        verification,
        ttlSeconds: ctx.config.planTtlSeconds,
      });
      bundleId = bundle.id;
      bundleExpiresAt = bundle.expiresAt;
    }

    ctx.audit.record({
      ts: new Date().toISOString(),
      action: 'dry_run',
      collection: args.collection,
      keys: items.map((i) => i.key),
      dryRun: true,
      ok: errors.length === 0,
      message: `update_by_query: ${items.length} items, ${planIds.length} plans, bundle=${bundleId ?? 'none'}`,
    });

    // Build text output.
    const lines: string[] = [];
    lines.push(`DRY-RUN UPDATE_BY_QUERY ${args.collection} — ${errors.length === 0 ? 'OK' : 'PARTIAL'}`);
    lines.push(`Matched: ${records.length}`);
    lines.push(`Usable: ${items.length}`);
    lines.push(`Skipped: ${skipped.length}`);
    lines.push(`Plans: ${planIds.length} (chunk_size=${chunkSize})`);
    if (bundleId) {
      lines.push(`Bundle ID: ${bundleId}`);
      lines.push(`Bundle expires at: ${bundleExpiresAt}`);
    }
    lines.push(`Changed fields: ${Object.keys(data as Record<string, unknown>).join(', ')}`);
    if (verifyFields.length > 0) {
      lines.push(`Verify fields: ${verifyFields.join(', ')}`);
    }
    lines.push('NOT WRITTEN');
    if (preview.length > 0) {
      lines.push('');
      lines.push(`Preview (first ${preview.length} items):`);
      for (const p of preview) {
        lines.push(`  key=${p.key} verify=${JSON.stringify(p.verify)} changed=${p.changed.join(',')}`);
      }
    }
    if (skipped.length > 0) {
      lines.push('');
      lines.push(`Skipped (${skipped.length}):`);
      for (const s of skipped.slice(0, 10)) {
        lines.push(`  key=${s.key}: ${s.reason}`);
      }
    }
    if (errors.length > 0) {
      lines.push('');
      lines.push(`Chunk errors (${errors.length}):`);
      for (const e of errors) {
        lines.push(`  chunk ${e.chunk}: ${e.error.code} — ${e.error.message}`);
      }
    }
    lines.push('');
    lines.push('NEXT ACTION:');
    if (bundleId) {
      lines.push(`- If user approves, call directus_apply_plan_bundle with:`);
      lines.push(`  { "bundle_id": "${bundleId}", "confirm": true }`);
      lines.push('- Do not call update_item or batch_update_items again.');
      lines.push('- Do not say written until apply result returns written=true.');
    } else {
      lines.push('- No bundle was created (all chunks failed).');
      lines.push('- Fix the errors above and try again.');
    }

    const text = lines.join('\n');

    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: {
        ok: errors.length === 0,
        dryRun: true,
        written: false,
        collection: args.collection,
        operation: 'update_by_query',
        totalMatched: records.length,
        totalUsable: items.length,
        chunkSize,
        chunkCount: planIds.length,
        planIds,
        bundleId,
        bundleExpiresAt,
        changedFields: Object.keys(data as Record<string, unknown>),
        verifyFields,
        preview,
        skipped,
        errors,
      },
    };
  },
};

