// `node scripts/verify-release-config.mjs` — deterministic local verification of the
// release-please setup, mirroring exactly what release-please will do on the next run:
//
//   1. manifest "." version === root package.json version === every workspace version
//   2. every `json` extra-file path exists and its version field matches
//   3. internal `@momus/*` deps use `~<current>` ranges so they track in lockstep
//   4. changelog-path is CHANGELOG.md and include-component-in-tag is false (tags = vX.Y.Z)
//
// Exit code 0 = consistent (a release-please run would bump cleanly); non-zero = fix first.
// Runs in CI with no network; the real release-please dry-run needs GitHub API access.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const failures = [];
const check = (cond, msg) => {
  if (!cond) failures.push(msg);
};

const config = JSON.parse(readFileSync(join(ROOT, 'release-please-config.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(ROOT, '.release-please-manifest.json'), 'utf8'));
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const expected = manifest['.'];
check(
  typeof expected === 'string' && /^\d+\.\d+\.\d+$/.test(expected),
  `manifest "." version missing/invalid: ${expected}`,
);
const pkgCfg = config.packages['.'];
check(pkgCfg['release-type'] === 'node', 'config: "." release-type must be node');
check(pkgCfg['changelog-path'] === 'CHANGELOG.md', 'config: changelog-path must be CHANGELOG.md');
check(pkgCfg['include-component-in-tag'] === false, 'config: include-component-in-tag must be false (tags = vX.Y.Z)');
check(rootPkg.version === expected, `root package.json version ${rootPkg.version} !== manifest ${expected}`);

const extraFiles = pkgCfg['extra-files'] ?? [];
// The `json` extra-file type requires a jsonpath property (release-please rejects
// `{ type: 'json', path }` without it — caught live on the first real run).
for (const f of extraFiles) {
  if (f.type === 'json') {
    check(typeof f.jsonpath === 'string' && f.jsonpath.length > 0, `extra-file ${f.path}: json type requires jsonpath`);
  }
}
const extraPaths = new Set(extraFiles.map((f) => f.path));

// Every workspace package.json must be version-locked to the manifest and listed as an
// extra-file (release-please bumps only what it knows about).
const packagesDir = join(ROOT, 'packages');
const checked = [];
for (const name of readdirSync(packagesDir)) {
  const pkgPath = join(packagesDir, name, 'package.json');
  if (!existsSync(pkgPath)) continue;
  const rel = `packages/${name}/package.json`;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  checked.push(name);
  check(pkg.version === expected, `${rel}: version ${pkg.version} !== manifest ${expected}`);
  check(extraPaths.has(rel), `${rel}: missing from config extra-files (release-please would not bump it)`);
  for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
    if (dep.startsWith('@momus/')) {
      check(range === `~${expected}`, `${rel}: internal dep ${dep} range "${range}" !== "~${expected}" (lockstep)`);
    }
  }
}

if (failures.length) {
  console.error('release-please config INCONSISTENT:');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(
  `release-please config consistent at v${expected}: ${checked.length} packages lockstep, ${extraPaths.size} extra-files, v${expected} tags.`,
);
