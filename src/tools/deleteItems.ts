import { z } from 'zod';
import type { ToolContext } from '../mcp/server.js';
import { assertDeleteAllowed } from '../safety/permissions.js';
import { normalizeJsonLike, isPlainObject } from '../safety/normalize.js';
import { deleteItemsWithGuards } from '../directus/mutations.js';
import { formatMutationText } from '../safety/textFormat.js';
import { McpUserError } from '../directus/errors.js';

const Input = z.object({
  collection: z.string().min(1),
  keys: z.unknown().optional(),
  keys_json: z.string().optional(),
  verify: z.unknown().optional(),
  verify_json: z.string().optional(),
  confirm: z.string().optional(),
  dry_run: z.boolean().optional(),
});

export const deleteItemsTool = {
  name: 'directus_delete_items',
  description:
    'Delete one or more items by primary key. DISABLED by default — requires DIRECTUS_ALLOW_DELETE=true. Requires confirm="DELETE <collection>:<keys>". Reads each record first, runs optional verify, then deletes. Supports dry_run.',
  inputSchema: Input,
  handler: async (ctx: ToolContext, rawArgs: unknown) => {
    const args = Input.parse(rawArgs);

    const rawKeys = args.keys_json !== undefined ? args.keys_json : args.keys;
    const keysVal = normalizeJsonLike(rawKeys);
    if (!Array.isArray(keysVal)) {
      throw new McpUserError('INVALID_DATA_TYPE', 'keys must be an array', { collection: args.collection });
    }
    const keys = keysVal.map((k, i) => {
      if (typeof k !== 'string' && typeof k !== 'number') {
        throw new McpUserError('INVALID_DATA_TYPE', `keys[${i}] must be string or number`, { index: i });
      }
      return k as string | number;
    });

    const rawVerify = args.verify_json !== undefined ? args.verify_json : args.verify;
    const verifyVal = normalizeJsonLike(rawVerify);
    let verify: Array<{ key: string | number; [field: string]: unknown }> | undefined;
    if (verifyVal !== undefined && verifyVal !== null) {
      if (!Array.isArray(verifyVal)) {
        throw new McpUserError('INVALID_DATA_TYPE', 'verify must be an array', { collection: args.collection });
      }
      verify = verifyVal.map((v, i) => {
        if (!isPlainObject(v)) {
          throw new McpUserError('INVALID_DATA_TYPE', `verify[${i}] must be an object`, { index: i });
        }
        return v as { key: string | number; [field: string]: unknown };
      });
    }

    assertDeleteAllowed(ctx.config, args.collection);

    const expectedConfirm = `DELETE ${args.collection}:${keys.join(',')}`;
    if (args.confirm !== expectedConfirm) {
      throw new McpUserError(
        'CONFIRMATION_REQUIRED',
        `Delete requires confirm='${expectedConfirm}'`,
        { collection: args.collection, keys, expected: expectedConfirm },
      );
    }

    const schema = await ctx.schema.loadCollectionSchema(args.collection);

    const result = await deleteItemsWithGuards(ctx.client, ctx.config, schema, keys, {
      dryRun: args.dry_run,
      verify,
      confirm: args.confirm,
    });

    ctx.audit.record({
      ts: new Date().toISOString(),
      action: result.dryRun ? 'dry_run' : 'delete',
      collection: args.collection,
      keys,
      dryRun: result.dryRun,
      ok: true,
    });

    const text = formatMutationText(
      {
        action: 'delete',
        collection: args.collection,
        dryRun: result.dryRun,
        ok: true,
        summary: {
          total: keys.length,
          ok: keys.length,
          failed: 0,
          dryRun: result.dryRun,
        },
      },
      ctx.config,
    );

    return {
      content: [
        { type: 'text' as const, text },
      ],
      structuredContent: {
        ok: true,
        ...result,
      },
    };
  },
};
