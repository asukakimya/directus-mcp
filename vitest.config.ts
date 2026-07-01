import { defineConfig } from 'vitest/config';

/**
 * Vitest config — prevents Vite from walking up the directory tree and
 * picking up the parent Next.js project's postcss.config.mjs, which
 * has plugins Vitest can't load in this isolated package.
 */
export default defineConfig({
  css: {
    postcss: {},
  },
  test: {
    include: ['src/test/**/*.test.ts'],
  },
});
