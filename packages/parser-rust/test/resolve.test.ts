import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRustImport } from '../src/resolve.ts';

const dirs: string[] = [];

/** A crate with Cargo.toml + src/repo.rs + a tests/ dir, under a fresh tmp root. */
function makeCrate(): { root: string; src: string; testFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'momus-resolve-'));
  dirs.push(root);
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "demo"\n');
  writeFileSync(join(root, 'src', 'repo.rs'), 'pub trait Repo { fn find(&self, id: u32) -> u32; }\n');
  const testFile = join(root, 'tests', 'resolver_test.rs');
  writeFileSync(testFile, 'use crate::repo::Repo;\n#[test]\nfn t() {}\n');
  return { root, src: join(root, 'src'), testFile };
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('resolveRustImport', () => {
  it('resolves a crate::module specifier through the crate index', () => {
    const { root, testFile } = makeCrate();
    expect(resolveRustImport('crate::repo::Repo', testFile)).toBe(join(root, 'src', 'repo.rs'));
  });

  it('resolves a super:: fallback specifier', () => {
    const { src } = makeCrate();
    const from = join(src, 'nested', 'inner_test.rs');
    mkdirSync(join(src, 'nested'));
    writeFileSync(from, 'use super::repo::Repo;\n');
    // `super::Repo` falls back to name-based resolution -> repo.rs (same crate)
    expect(resolveRustImport('super::Repo', from)).toBe(join(src, 'repo.rs'));
  });

  it('returns null for an unknown symbol', () => {
    const { testFile } = makeCrate();
    expect(resolveRustImport('crate::nope::Missing', testFile)).toBeNull();
  });

  it('falls back to the file dir when no Cargo.toml exists above it', () => {
    const root = mkdtempSync(join(tmpdir(), 'momus-resolve-nocrate-'));
    dirs.push(root);
    const repo = join(root, 'repo.rs');
    writeFileSync(repo, 'pub trait Repo {}\n');
    const from = join(root, 't.rs');
    writeFileSync(from, 'use crate::repo::Repo;\n');
    // No Cargo.toml: findCrateRoot returns the file's dir; the index still resolves
    // the symbol by name, so the same directory file matches.
    expect(resolveRustImport('crate::repo::Repo', from)).toBe(repo);
  });
});
