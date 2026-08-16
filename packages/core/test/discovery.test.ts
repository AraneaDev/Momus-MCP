import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverFiles, type DiscoveryOptions } from '../src/discovery.ts';

function opts(root: string, overrides: Partial<DiscoveryOptions> = {}): DiscoveryOptions {
  return {
    testPatterns: ['**/*.test.ts', '**/*.test.php'],
    ignorePatterns: [],
    maxFileSizeBytes: 1024 * 1024,
    maxIndexedLines: 100_000,
    root,
    ...overrides,
  };
}

describe('discoverFiles', () => {
  it('discovers test files and supported source extensions, skipping the rest', () => {
    const root = mkdtempSync(join(tmpdir(), 'momus-discover-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      mkdirSync(join(root, 'tests'), { recursive: true });
      writeFileSync(join(root, 'tests', 'a.test.ts'), 'export {}');
      writeFileSync(join(root, 'src', 'lib.ts'), 'export const x = 1;');
      writeFileSync(join(root, 'src', 'lib.php'), '<?php class Lib {}');
      writeFileSync(join(root, 'README.md'), 'docs are not indexed');
      writeFileSync(join(root, 'src', 'data.json'), '{}');

      const { files, skipped } = discoverFiles(opts(root));
      const rels = files.map((f) => f.path.slice(root.length + 1)).sort();
      expect(rels).toEqual(['src/lib.php', 'src/lib.ts', 'tests/a.test.ts']);
      expect(skipped).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('respects explicit ignorePatterns and .gitignore rules', () => {
    const root = mkdtempSync(join(tmpdir(), 'momus-discover-ignore-'));
    try {
      mkdirSync(join(root, 'dist'), { recursive: true });
      mkdirSync(join(root, 'generated'), { recursive: true });
      writeFileSync(join(root, 'dist', 'bundle.ts'), 'export {}');
      writeFileSync(join(root, 'generated', 'gen.ts'), 'export {}');
      writeFileSync(join(root, 'kept.ts'), 'export {}');
      writeFileSync(join(root, '.gitignore'), '# comment\ngenerated\n');

      const { files } = discoverFiles(opts(root, { ignorePatterns: ['**/dist/**'] }));
      const rels = files.map((f) => f.path.slice(root.length + 1)).sort();
      expect(rels).toEqual(['kept.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips .git and node_modules directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'momus-discover-vcs-'));
    try {
      mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
      mkdirSync(join(root, '.git', 'objects'), { recursive: true });
      writeFileSync(join(root, 'node_modules', 'pkg', 'index.ts'), 'export {}');
      writeFileSync(join(root, '.git', 'objects', 'x.ts'), 'export {}');
      writeFileSync(join(root, 'app.ts'), 'export {}');

      const { files } = discoverFiles(opts(root));
      expect(files.map((f) => f.path.slice(root.length + 1))).toEqual(['app.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips files exceeding maxFileSizeBytes with SYS-002', () => {
    const root = mkdtempSync(join(tmpdir(), 'momus-discover-size-'));
    try {
      writeFileSync(join(root, 'big.ts'), 'export const big = ' + '1'.repeat(64) + ';');
      writeFileSync(join(root, 'small.ts'), 'export const small = 1;');

      const { files, skipped } = discoverFiles(opts(root, { maxFileSizeBytes: 32 }));
      expect(files.map((f) => f.path.slice(root.length + 1))).toEqual(['small.ts']);
      expect(skipped).toEqual([{ path: join(root, 'big.ts'), reason: 'SYS-002: file exceeds 32 bytes' }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('caps discovery at maxIndexedLines', () => {
    const root = mkdtempSync(join(tmpdir(), 'momus-discover-cap-'));
    try {
      writeFileSync(join(root, 'a.ts'), 'export const a = ' + '1'.repeat(200) + ';');
      writeFileSync(join(root, 'b.ts'), 'export const b = 1;');

      const { files, skipped } = discoverFiles(opts(root, { maxIndexedLines: 2 }));
      // the first file already exceeds the 2-line budget, so the walk stops
      expect(files).toEqual([]);
      expect(skipped.map((s) => s.reason)).toEqual(['SYS-002: workspace exceeds maxIndexedLines']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
