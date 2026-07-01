import { z } from 'zod';
import type { ToolContext } from '../mcp/server.js';
import { assertCollectionReadable } from '../safety/permissions.js';
import { formatSchemaDetailText } from '../safety/textFormat.js';

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

    const collectionInfos: Array<{
      collection: string;
      singleton: boolean;
      primaryKey: string | null;
      fields: Array<{
        field: string;
        type: string;
        readonly: boolean;
        required: boolean;
        isPrimaryKey: boolean;
        hasRelation: boolean;
        defaultValue?: unknown;
        interface?: string | null;
        special?: string[] | null;
      }>;
      relations: Array<{
        field: string;
        type: string;
        relatedCollection?: string;
        junctionCollection?: string;
      }>;
    }> = [];

    const structuredSchemas: Record<string, unknown> = {};

    for (const collection of args.collections) {
      assertCollectionReadable(ctx.config, collection);
      const schema = await ctx.schema.loadCollectionSchema(collection);
      collectionInfos.push({
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
          interface: f.interface ?? null,
          special: f.special ?? null,
        })),
        relations: schema.relations.map((r) => ({
          field: r.field,
          type: r.type,
          relatedCollection: r.relatedCollection,
          junctionCollection: r.junctionCollection,
        })),
      });
      structuredSchemas[collection] = {
        collection: schema.collection,
        singleton: schema.singleton,
        primaryKey: schema.primaryKey,
        fields: Object.values(schema.fields),
        relations: schema.relations,
      };
    }

    const text = formatSchemaDetailText(collectionInfos, ctx.config);

    return {
      content: [
        { type: 'text' as const, text },
      ],
      structuredContent: {
        ok: true,
        schemas: structuredSchemas,
      },
    };
  },
};
