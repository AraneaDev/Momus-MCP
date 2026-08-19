import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteParseCache, openParseCache } from '../src/cache.ts';
import type { ModuleIR } from '@momus/core';

function module(path: string): ModuleIR {
  return {
    path,
    language: 'typescript',
    kind: 'production',
    framework: undefined,
    imports: [],
    symbols: [],
    exports: [],
    mocks: [],
    assertions: [],
    functions: [],
    comments: [],
    diagnostics: [],
    hash: 'abc123',
  };
}

describe('SqliteParseCache', () => {
  it('round-trips a parsed module keyed by path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'momus-sqlite-'));
    try {
      const cache = new SqliteParseCache(dir);
      cache.put('/repo/a.ts', 'h1', 'w1', module('/repo/a.ts'));
      const hit = cache.get('/repo/a.ts', 'h1', 'w1');
      expect(hit).toBeDefined();
      expect(hit!.path).toBe('/repo/a.ts');
      expect(hit!.hash).toBe('abc123');
      cache.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('misses when the file hash or workspace hash changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'momus-sqlite-miss-'));
    try {
      const cache = new SqliteParseCache(dir);
      cache.put('/repo/a.ts', 'h1', 'w1', module('/repo/a.ts'));
      expect(cache.get('/repo/a.ts', 'h2', 'w1')).toBeUndefined(); // file changed
      expect(cache.get('/repo/a.ts', 'h1', 'w2')).toBeUndefined(); // workspace changed
      expect(cache.get('/repo/other.ts', 'h1', 'w1')).toBeUndefined(); // unknown path
      cache.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats a corrupt entry as a miss and drops it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'momus-sqlite-corrupt-'));
    try {
      const cache = new SqliteParseCache(dir);
      (cache as any).db
        .prepare('INSERT INTO modules (path, file_hash, workspace_hash, ir) VALUES (?, ?, ?, ?)')
        .run('/repo/a.ts', 'h1', 'w1', '{not-json');
      expect(cache.get('/repo/a.ts', 'h1', 'w1')).toBeUndefined();
      // the corrupt row is deleted, so a subsequent get is a plain miss
      expect(cache.get('/repo/a.ts', 'h1', 'w1')).toBeUndefined();
      cache.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('openParseCache honors the enabled flag', () => {
    expect(openParseCache('/tmp', { dir: '.momus/cache', enabled: false })).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), 'momus-sqlite-open-'));
    try {
      const cache = openParseCache(dir, { dir: 'cache', enabled: true });
      expect(cache).toBeInstanceOf(SqliteParseCache);
      cache!.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SqliteParseCache is advisory: I/O failure degrades, never throws', () => {
  it('never throws from a get against a removed cache file', () => {
    // What a live MCP server hits when someone deletes .momus/ underneath it: the sqlite
    // handle is still open but its file is gone. The contract is only that this cannot blow
    // up the audit — sqlite may still answer from its own page cache, and that answer is
    // valid, because the hash guard is what proves an entry usable, not the file's existence.
    const dir = mkdtempSync(join(tmpdir(), 'momus-sqlite-gone-'));
    const cache = new SqliteParseCache(dir);
    cache.put('a.ts', 'h1', 'w1', module('a.ts'));
    rmSync(dir, { recursive: true, force: true });

    expect(() => cache.get('a.ts', 'h1', 'w1')).not.toThrow();
  });

  it('swallows a put against a removed cache file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'momus-sqlite-put-'));
    const cache = new SqliteParseCache(dir);
    rmSync(dir, { recursive: true, force: true });

    expect(() => cache.put('a.ts', 'h1', 'w1', module('a.ts'))).not.toThrow();
  });

  it('returns undefined rather than throwing when the cache cannot be opened at all', () => {
    // Blocked by a FILE where the cache directory should be, not by permissions: the suite
    // runs as root in CI, and root bypasses permission bits, so a chmod-based test would
    // silently succeed and prove nothing.
    const dir = mkdtempSync(join(tmpdir(), 'momus-sqlite-blocked-'));
    try {
      writeFileSync(join(dir, 'blocked'), 'not a directory');
      const opened = openParseCache(dir, { dir: 'blocked/cache', enabled: true });
      expect(opened).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
