import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'test/integration/**/*.test.ts', 'test/golden/**/*.test.ts'],
    // fixture galleries contain planted violations; never execute them as tests
    exclude: [
      '**/test/fixtures/**',
      '**/test/fixtures-syntax-only/**',
      '**/test/golden/fixtures/**',
      '**/node_modules/**',
      '**/dist/**',
    ],
    server: {
      deps: { inline: [/@momus\//] },
    },
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/**/*.d.ts', 'packages/*/test/**', 'test/**'],
      reporter: ['text', 'text-summary'],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 90,
        lines: 80,
      },
    },
  },
});
