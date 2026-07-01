import { z } from 'zod';
import type { ToolContext } from '../mcp/server.js';
import { isSystemCollection } from '../safety/permissions.js';

const Input = z.object({
  include_system: z.boolean().optional(),
});

export const schemaOverviewTool = {
  name: 'directus_schema_overview',
  description:
    'List all Directus collections visible to the configured token, with their primary key, singleton flag and field count. Excludes directus_* system collections by default.',
  inputSchema: Input,
  handler: async (ctx: ToolContext, rawArgs: unknown) => {
    const args = Input.parse(rawArgs);
    const includeSystem = args.include_system ?? false;

    const all = await ctx.schema.listCollections();
    const filtered = includeSystem ? all : all.filter((c) => !isSystemCollection(c.collection));

    const overview = filtered.map((c) => ({
      collection: c.collection,
      singleton: c.singleton,
      primaryKey: c.primaryKey,
      fieldCount: Object.keys(c.fields).length,
      relationCount: c.relations.length,
    }));

    return {
      content: [
        { type: 'text' as const, text: `Found ${overview.length} collections.` },
      ],
      structuredContent: {
        ok: true,
        collections: overview,
        total: overview.length,
      },
    };
  },
};
