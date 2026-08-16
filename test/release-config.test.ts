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

  it('all five packages are version-locked with ~ internal deps admitting the version', () => {
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
        if (!dep.startsWith('@momus/')) continue;
        // ~ ranges pinned to the baseline; release-please bumps version fields but leaves
        // dep ranges untouched, so the range must ADMIT the current version (same major+
        // minor, patch >= baseline) rather than equal it.
        const m = /^~(\d+)\.(\d+)\.(\d+)$/.exec(range);
        expect(m).not.toBeNull();
        const [, rMaj, rMin, rPat] = m!.map(Number);
        const [eMaj, eMin, ePat] = version.split('.').map(Number);
        expect(eMaj).toBe(rMaj);
        expect(eMin).toBe(rMin);
        expect(ePat).toBeGreaterThanOrEqual(rPat);
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

  it('json extra-files carry a jsonpath (release-please rejects json without it)', () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'release-please-config.json'), 'utf8')).packages['.'];
    const jsonFiles = cfg['extra-files'].filter((f: { type?: string }) => f.type === 'json');
    expect(jsonFiles.length).toBeGreaterThan(0);
    for (const f of jsonFiles) {
      expect(f.jsonpath).toBe('$.version');
    }
  });

  it('pre-1.0 releases stay on patch bumps (bump-patch-for-minor-pre-major)', () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'release-please-config.json'), 'utf8')).packages['.'];
    expect(cfg['bump-patch-for-minor-pre-major']).toBe(true);
  });

  it('npm publish step stays dormant until NPM_TOKEN exists (pre-release never auto-publishes)', () => {
    const wf = readFileSync(join(ROOT, '.github', 'workflows', 'release-please.yml'), 'utf8');
    expect(wf).toContain("secrets.NPM_TOKEN != ''");
    expect(wf).toContain('Publish to npm');
    // The gate must be on the publish step itself, not a job-level condition that
    // could be bypassed by reordering steps.
    const m = wf.match(/name: Publish to npm[\s\S]*?run: npm run publish/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain('secrets.NPM_TOKEN');
  });
});
