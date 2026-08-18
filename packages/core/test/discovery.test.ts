import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverFiles, type DiscoveryOptions } from '../src/discovery.ts';

let throwFsError = false;
vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>();
  return {
    ...orig,
    readdirSync: (path: import('node:fs').PathLike, options?: any) => {
      if (throwFsError && typeof path === 'string' && path.endsWith('bad-dir')) throw new Error('EACCES');
      return orig.readdirSync(path, options as any);
    },
    statSync: (path: import('node:fs').PathLike, options?: any) => {
      if (throwFsError && typeof path === 'string' && path.endsWith('bad-file.ts')) throw new Error('EACCES');
      return orig.statSync(path, options as any);
    },
  };
});

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

  it('honors gitignore negation (ignore-all + whitelist convention)', () => {
    const root = mkdtempSync(join(tmpdir(), 'momus-discover-negate-'));
    try {
      // The standard Rust-workspace .gitignore: ignore everything, then whitelist directories,
      // .rs files, and Cargo.toml. Dropping the `!` lines used to ignore the whole workspace.
      writeFileSync(
        join(root, '.gitignore'),
        '*\n!*/\n\n!Cargo.toml\n!*.rs\n!.gitignore\n!README.md\n\n/target\n.vscode\nCargo.lock\n',
      );
      mkdirSync(join(root, 'mry', 'src'), { recursive: true });
      mkdirSync(join(root, 'mry', 'tests'), { recursive: true });
      mkdirSync(join(root, 'target'), { recursive: true });
      writeFileSync(join(root, 'mry', 'src', 'lib.rs'), 'pub fn x() {}');
      writeFileSync(join(root, 'mry', 'tests', 'a.rs'), '#[test]\nfn t() {}');
      writeFileSync(join(root, 'target', 'build.rs'), 'fn main() {}');
      writeFileSync(join(root, 'Cargo.toml'), '[package]');
      writeFileSync(join(root, 'Cargo.lock'), 'ignored');
      writeFileSync(join(root, 'notes.md'), 'ignored');

      const { files } = discoverFiles(opts(root));
      const rels = files.map((f) => f.path.slice(root.length + 1)).sort();
      expect(rels).toEqual(['mry/src/lib.rs', 'mry/tests/a.rs']);
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

  it('gracefully skips unreadable directories and files', () => {
    const root = mkdtempSync(join(tmpdir(), 'momus-discover-unreadable-'));
    try {
      const badDir = join(root, 'bad-dir');
      const badFile = join(root, 'bad-file.ts');
      const goodFile = join(root, 'good-file.ts');

      mkdirSync(badDir);
      writeFileSync(badFile, 'export {}');
      writeFileSync(goodFile, 'export {}');

      throwFsError = true;
      const { files, skipped } = discoverFiles(opts(root));
      throwFsError = false;

      expect(files.map((f) => f.path.slice(root.length + 1))).toEqual(['good-file.ts']);
      expect(skipped).toEqual([]);
    } finally {
      throwFsError = false;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
