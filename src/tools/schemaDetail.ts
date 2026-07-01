import { z } from 'zod';
import type { ToolContext } from '../mcp/server.js';
import { assertCollectionReadable } from '../safety/permissions.js';

const Input = z.object({
  collections: z.array(z.string().min(1)).min(1),
});

export const schemaDetailTool = {
  name: 'directus_schema_detail',
  description:
    'Return full schema detail for one or more collections: fields (type, readonly, required, primary key), relations, and primary key. Use this before any read/write to learn field names.',
  inputSchema: Input,
  handler: async (ctx: ToolContext, rawArgs: unknown) => {
    const args = Input.parse(rawArgs);

    const out: Record<string, unknown> = {};
    for (const collection of args.collections) {
      assertCollectionReadable(ctx.config, collection);
      const schema = await ctx.schema.loadCollectionSchema(collection);
      out[collection] = {
        collection: schema.collection,
        singleton: schema.singleton,
        primaryKey: schema.primaryKey,
        fields: Object.values(schema.fields).map((f) => ({
          field: f.field,
          type: f.type,
          readonly: f.readonly,
          required: f.required,
          isPrimaryKey: f.isPrimaryKey ?? false,
          hasRelation: !!f.relation,
          defaultValue: f.defaultValue ?? null,
        })),
        relations: schema.relations,
      };
    }

    return {
      content: [
        { type: 'text' as const, text: `Schema detail for ${args.collections.length} collection(s).` },
      ],
      structuredContent: {
        ok: true,
        schemas: out,
      },
    };
  },
};
