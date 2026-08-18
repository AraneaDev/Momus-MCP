import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePythonImport } from '../src/resolve.ts';

const dirs: string[] = [];

function makeTree(layout: 'flat' | 'src'): { root: string; testFile: string; prodFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'momus-presolve-'));
  dirs.push(root);
  const tests = join(root, 'tests');
  mkdirSync(tests);
  const testFile = join(tests, 'test_x.py');
  writeFileSync(testFile, 'from unittest.mock import patch\n');
  if (layout === 'flat') {
    writeFileSync(join(root, 'prod_missing.py'), 'def existing_attr() -> int:\n    return 1\n');
    return { root, testFile, prodFile: join(root, 'prod_missing.py') };
  }
  mkdirSync(join(root, 'src', 'pkg'), { recursive: true });
  const prodFile = join(root, 'src', 'pkg', 'mod.py');
  writeFileSync(prodFile, 'def existing_attr() -> int:\n    return 1\n');
  return { root, testFile, prodFile };
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('resolvePythonImport', () => {
  it('resolves a flat-layout module from a tests/ file', () => {
    const { testFile, prodFile } = makeTree('flat');
    expect(resolvePythonImport('prod_missing', testFile)).toBe(prodFile);
  });

  it('resolves a src-layout package module (src/pkg/mod.py)', () => {
    const { testFile, prodFile } = makeTree('src');
    expect(resolvePythonImport('pkg.mod', testFile)).toBe(prodFile);
  });

  it('resolves a package directory via __init__.py', () => {
    const { root, testFile } = makeTree('flat');
    mkdirSync(join(root, 'pkg'));
    writeFileSync(join(root, 'pkg', '__init__.py'), '');
    expect(resolvePythonImport('pkg', testFile)).toBe(join(root, 'pkg', '__init__.py'));
  });

  it('strips a leading-dot relative prefix', () => {
    const { root, testFile } = makeTree('flat');
    writeFileSync(join(root, 'local.py'), '');
    expect(resolvePythonImport('.local', testFile)).toBe(join(root, 'local.py'));
  });

  it('returns null for an unresolvable module', () => {
    const { testFile } = makeTree('flat');
    expect(resolvePythonImport('third_party_pkg.nope', testFile)).toBeNull();
  });

  it('returns null for an empty or dotted-only specifier', () => {
    const { testFile } = makeTree('flat');
    expect(resolvePythonImport('', testFile)).toBeNull();
    expect(resolvePythonImport('...', testFile)).toBeNull();
  });
});
