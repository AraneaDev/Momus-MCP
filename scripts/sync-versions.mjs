// `node scripts/sync-versions.mjs [--check]` — keeps every package.json `version` field in
// lockstep with `.release-please-manifest.json` (the single source of truth).
//
// No args:  rewrites root + every packages/*/package.json `version` to the manifest version,
//           then prints what changed (exit 0).
// --check:  exits non-zero if any version drifts from the manifest (no writes) — CI parity.
//
// Why this exists: this monorepo is intentionally lockstep — release-please bumps one version
// (`.`) and its json extra-files rewrite every package.json to match. A NEW package.json must
// therefore start at the *current* manifest version, not a hardcoded one. Run this after
// scaffolding a package (a pre-commit hook keeps it honest) so a stale version never gets
// committed and blocks the release-config gate.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

const manifest = JSON.parse(readFileSync(join(ROOT, '.release-please-manifest.json'), 'utf8'));
const target = manifest['.'];
if (typeof target !== 'string' || !/^\d+\.\d+\.\d+$/.test(target)) {
  console.error(`sync-versions: manifest "." version missing/invalid: ${target}`);
  process.exit(1);
}

// Root package.json + every workspace package.json (skip dirs without one, e.g. packages/action).
const paths = ['package.json'];
for (const name of readdirSync(join(ROOT, 'packages'))) {
  const p = join('packages', name, 'package.json');
  if (existsSync(join(ROOT, p))) paths.push(p);
}

const drift = [];
for (const rel of paths) {
  const abs = join(ROOT, rel);
  const pkg = JSON.parse(readFileSync(abs, 'utf8'));
  if (pkg.version !== target) {
    drift.push(rel);
    if (!CHECK) {
      pkg.version = target;
      writeFileSync(abs, `${JSON.stringify(pkg, null, 2)}\n`);
    }
  }
}

if (CHECK) {
  if (drift.length) {
    console.error(`sync-versions --check: ${drift.length} package.json version(s) drift from manifest ${target}:`);
    for (const rel of drift) console.error(`  ✗ ${rel}`);
    console.error('Run `npm run version:sync` to align them.');
    process.exit(1);
  }
  console.log(`sync-versions --check: ${paths.length} package.json files at v${target}.`);
} else if (drift.length) {
  for (const rel of drift) console.log(`  synced ${rel} → v${target}`);
  console.log(`sync-versions: ${drift.length} package.json file(s) aligned to v${target}.`);
} else {
  console.log(`sync-versions: ${paths.length} package.json files already at v${target}.`);
}
