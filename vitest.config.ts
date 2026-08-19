import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Parallel coverage instrumentation is ~5-6x slower than a plain run; the vitest 5s
    // default flakes under it (seen on the git-diff MCP, syntax-only, and in-memory audit
    // tests). A 15s global cap covers instrumentation headroom without masking real hangs.
    testTimeout: 15_000,
    include: [
      'packages/*/test/**/*.test.ts',
      'test/integration/**/*.test.ts',
      'test/golden/**/*.test.ts',
      'test/release-config.test.ts',
    ],
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
      // lcov is what the Codecov upload in CI consumes; text/summary are for humans.
      reporter: ['text', 'text-summary', 'lcov'],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 90,
        lines: 80,
      },
    },
  },
});
