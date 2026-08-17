// StrykerJS config for momus-mcp INTERNAL mutation testing.

let command = process.env.STRYKER_TEST_COMMAND ?? 'npm test';

// Support chaos-mcp which passes `--mutate <file>` directly to Stryker
const mutateIdx = process.argv.indexOf('--mutate');
if (mutateIdx !== -1 && process.argv.length > mutateIdx + 1) {
  const target = process.argv[mutateIdx + 1];
  command = `npx vitest related ${target} --run`;
}

export default {
  testRunner: 'command',
  commandRunner: { command },
  // Required for the command runner: it has no coverage instrumentation.
  coverageAnalysis: 'off',
  // Empty by default so a bare run is a no-op; scripts/mutate.mjs passes
  // `--mutate` to scope each run to an explicit target.
  mutate: [],
  reporters: ['clear-text', 'progress', 'json'],
  tempDirName: '.stryker-tmp',
  // Keep at 2: command-runner mutants each launch a test process, so higher
  // values can saturate the machine quickly.
  concurrency: 2,
};
