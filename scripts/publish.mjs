// `npm run publish` — publishes the @momus/* workspaces in dependency order.
// Called from the release-please workflow on the release_created commit, where
// every package.json version has already been bumped to the same vX.Y.Z.
// Requires NODE_AUTH_TOKEN (or npm auth) to be configured in the environment.
import { execFileSync } from 'node:child_process';

const ORDER = ['@momus/core', '@momus/parser-typescript', '@momus/parser-php', '@momus/mcp-server', '@momus/cli'];

for (const pkg of ORDER) {
  const args = ['publish', '-w', pkg, '--no-audit', '--no-fund'];
  if (process.env.NPM_PUBLISH_DRY_RUN === '1') args.push('--dry-run');
  console.log(`\n> npm ${args.join(' ')}`);
  execFileSync('npm', args, { stdio: 'inherit' });
}
console.log('\nAll @momus/* packages published.');
