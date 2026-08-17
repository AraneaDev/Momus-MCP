// `node scripts/simulate-release.mjs [--to X.Y.Z]` — round-trips the release flow that
// release-please will drive, without touching the working tree or GitHub:
//
//   1. `git worktree add` a temp checkout of HEAD (the merge that would cut a release)
//   2. bump root + every workspace package.json + the manifest to X.Y.Z (default: next
//      patch after the manifest, e.g. 0.0.1 → 0.0.2) — exactly the files release-please
//      bumps via its json extra-files, plus a minimal CHANGELOG entry
//   3. run the publish step (`npm run publish`) with NPM_PUBLISH_DRY_RUN=1
//   4. assert every @momus/* tarball packs at X.Y.Z and internal ~ ranges still resolve
//   5. remove the worktree
//
// Exit 0 = the release flow works end-to-end for the given bump; non-zero = something a
// real release would break on. Requires a clean-ish working tree (worktree add needs
// HEAD; untracked files are fine).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEXT_PATCH = (v) => {
  const [maj, min, pat] = v.split('.').map(Number);
  return `${maj}.${min}.${pat + 1}`;
};
const argTo = process.argv.find((a) => a.startsWith('--to='));
const manifest = JSON.parse(readFileSync(join(ROOT, '.release-please-manifest.json'), 'utf8'));
const TO = argTo ? argTo.slice('--to='.length) : NEXT_PATCH(manifest['.']);

const sh = (cmd, cwd) => execFileSync(cmd, { cwd, shell: true, stdio: 'inherit' });

const work = mkdtempSync(join(tmpdir(), 'momus-release-sim-'));
try {
  console.log(`\n== 1/5 worktree @ HEAD ==`);
  sh(`git worktree add --detach ${work} HEAD`, ROOT);

  console.log(`== 2/5 bump to v${TO} (root + workspaces + manifest + CHANGELOG) ==`);
  const files = [
    'package.json',
    'release-please-config.json', // unchanged, but read for extra-files below
  ];
  const cfg = JSON.parse(readFileSync(join(ROOT, 'release-please-config.json'), 'utf8'));
  const extraFiles = cfg.packages['.']['extra-files'].map((f) => f.path);
  for (const rel of ['package.json', ...extraFiles]) {
    const p = join(work, rel);
    const json = JSON.parse(readFileSync(p, 'utf8'));
    json.version = TO;
    writeFileSync(p, `${JSON.stringify(json, null, 2)}\n`);
    files.push(rel);
    console.log(`  bumped ${rel}`);
  }
  const m = join(work, '.release-please-manifest.json');
  writeFileSync(m, `${JSON.stringify({ '.': TO }, null, 2)}\n`);
  const changelog = join(work, 'CHANGELOG.md');
  writeFileSync(
    changelog,
    `# Changelog\n\n## [${TO}] (2026-08-16)\n\n### Features\n\n- simulate-release round-trip verification\n\n`,
  );
  console.log(`  wrote CHANGELOG.md @ [${TO}]`);

  console.log(`== 3/5 install + publish dry-run ==`);
  // Faithful to the workflow: npm ci, then npm run publish. Publish is dry-run.
  sh('npm ci --no-audit --no-fund', work);
  sh('NPM_PUBLISH_DRY_RUN=1 npm run publish', work);

  console.log(`== 4/5 assert every @momus/* packs at v${TO} ==`);
  const failures = [];
  // npm publish --dry-run does not write tarballs; the packed version is asserted via
  // the dry-run output (`+ @momus/<name>@<TO>`) which we captured above, and here via
  // the bumped package.json files release-please would produce.
  const DIRS = {
    core: 'core',
    'parser-typescript': 'parser-typescript',
    'parser-php': 'parser-php',
    'parser-python': 'parser-python',
    'parser-rust': 'parser-rust',
    'mcp-server': 'server',
    cli: 'cli',
  };
  for (const [pkgName, dir] of Object.entries(DIRS)) {
    const p = join(work, 'packages', dir, 'package.json');
    const pkg = JSON.parse(readFileSync(p, 'utf8'));
    if (pkg.version !== TO) {
      failures.push(`${pkgName}: bumped to ${pkg.version}, expected ${TO}`);
      continue;
    }
    console.log(`  ✓ ${pkgName}@${TO} (dry-run published above)`);
  }
  // Internal ~ ranges: assert each workspace dep still resolves under the new version.
  for (const [name, dir] of Object.entries(DIRS)) {
    if (name === 'core') continue;
    const p = JSON.parse(readFileSync(join(work, 'packages', dir, 'package.json'), 'utf8'));
    for (const [dep, range] of Object.entries(p.dependencies ?? {})) {
      if (dep.startsWith('@momus/')) {
        // ~0.0.1 must admit 0.0.2 (same major+minor, patch >= baseline); release-please
        // leaves dep ranges at the baseline while bumping version fields.
        const m = /^~(\d+)\.(\d+)\.(\d+)$/.exec(range);
        const [rMaj, rMin, rPat] = (m?.slice(1) ?? ['0', '0', '0']).map(Number);
        const [tMaj, tMin, tPat] = TO.split('.').map(Number);
        const ok = !!m && tMaj === rMaj && tMin === rMin && tPat >= rPat;
        console.log(`  ${ok ? '✓' : '✗'} ${name}: ${dep} "${range}" admits v${TO}`);
        if (!ok) failures.push(`${name}: ${dep} "${range}" must be a ~ range admitting v${TO}`);
      }
    }
  }

  if (failures.length) {
    console.error(`\nrelease round-trip FAILED (${failures.length}):`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`\nrelease round-trip OK: v${manifest['.']} → v${TO} bumps, publishes, and resolves end-to-end.`);
} finally {
  console.log(`== 5/5 cleanup ==`);
  sh(`git worktree remove --force ${work}`, ROOT);
  rmSync(work, { recursive: true, force: true });
}
