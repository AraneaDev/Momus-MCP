// StrykerJS config for momus-mcp INTERNAL mutation testing.
//
// Modeled on Chaos-MCP's proven setup (see /root/Chaos-MCP/stryker.config.mjs):
// Stryker's built-in COMMAND runner (`testRunner: 'command'`) runs a plain test
// command as a black box per mutant and grades on the exit code, so it never
// loads the vitest-runner plugin (which is incompatible with vitest 3's removed
// `config.related` API). It ships inside @stryker-mutator/core — there is no
// separate command-runner package.
//
// DO NOT run this bare (`npx stryker run`): the command runner cannot per-mutant
// scope, so a whole-repo `mutate` would run the FULL suite for EVERY mutant and
// peg the machine. `mutate` is therefore an empty no-op by default. Drive it
// through the wrapper, which scopes BOTH the mutated files and the test command:
//
//   npm run mutation -- packages/core/src/rules/drift.ts
//   npm run mutation -- packages/core/src/rules --concurrency 2
//   npm run mutation -- packages/core/src/rules/drift.ts --tests packages/core/test/diff.test.ts
//
// The wrapper (scripts/mutate.mjs) passes `--mutate <targets>` and sets
// STRYKER_TEST_COMMAND to `vitest related <targets> --run` — only the tests
// whose module graph includes the mutated files (the correct superset: a mutant
// is only killable by a test that actually exercises it).
const command = process.env.STRYKER_TEST_COMMAND ?? 'npm test';

export default {
  testRunner: 'command',
  commandRunner: { command },
  // Required for the command runner: it has no coverage instrumentation.
  coverageAnalysis: 'off',
  // Empty by default so a bare run is a no-op; scripts/mutate.mjs passes
  // `--mutate` to scope each run to an explicit target.
  mutate: [],
  reporters: ['clear-text', 'progress'],
  tempDirName: '.stryker-tmp',
  // Keep at 2: command-runner mutants each launch a test process, so higher
  // values can saturate the machine quickly.
  concurrency: 2,
};
