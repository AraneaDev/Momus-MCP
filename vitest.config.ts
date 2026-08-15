import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'test/integration/**/*.test.ts', 'test/golden/**/*.test.ts'],
    // fixture galleries contain planted violations; never execute them as tests
    exclude: ['**/test/fixtures/**', '**/test/golden/fixtures/**', '**/node_modules/**', '**/dist/**'],
    server: {
      deps: { inline: [/@momus\//] },
    },
  },
});
