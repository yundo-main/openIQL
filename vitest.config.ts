import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@openiql/core': r('./packages/core/src/index.ts'),
      '@openiql/adapter-postgres': r('./packages/adapter-postgres/src/index.ts'),
      '@openiql/adapter-opensearch': r('./packages/adapter-opensearch/src/index.ts'),
      '@openiql/adapter-sql': r('./packages/adapter-sql/src/index.ts'),
    },
  },
  test: { include: ['tests/**/*.test.ts'] },
});
