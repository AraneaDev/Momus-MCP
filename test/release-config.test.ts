/**
 * Release-please config consistency (docs/06 §6.5.2). Deterministic, no network —
 * mirrors what a release-please run will do so a misconfigured release setup fails
 * in CI before it ever reaches GitHub.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');

describe('release-please config', () => {
  it('verify-release-config.mjs passes (manifest/versions/extra-files lockstep)', () => {
    const out = execFileSync('node', ['scripts/verify-release-config.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(out).toContain('release-please config consistent');
  });

  it('all five packages are version-locked with ~ internal deps', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, '.release-please-manifest.json'), 'utf8'));
    const version = manifest['.'];
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);

    const config = JSON.parse(readFileSync(join(ROOT, 'release-please-config.json'), 'utf8'));
    const extraFiles = config.packages['.']['extra-files'].map((f: { path: string }) => f.path);

    const checked = [];
    for (const name of readdirSync(join(ROOT, 'packages'))) {
      const pkgPath = join(ROOT, 'packages', name, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const rel = `packages/${name}/package.json`;
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      checked.push(name);
      expect(pkg.version).toBe(version);
      expect(extraFiles).toContain(rel);
      for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
        if (dep.startsWith('@momus/')) expect(range).toBe(`~${version}`);
      }
    }
    expect(checked).toEqual(['cli', 'core', 'parser-php', 'parser-typescript', 'server']);
  });

  it('root version + changelog-path + tag shape match the manifest', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, '.release-please-manifest.json'), 'utf8'));
    const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const cfg = JSON.parse(readFileSync(join(ROOT, 'release-please-config.json'), 'utf8')).packages['.'];
    expect(rootPkg.version).toBe(manifest['.']);
    expect(cfg['changelog-path']).toBe('CHANGELOG.md');
    expect(cfg['include-component-in-tag']).toBe(false); // tags are vX.Y.Z
  });
});
