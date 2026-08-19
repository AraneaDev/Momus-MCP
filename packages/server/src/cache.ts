/**
 * Persistent IR cache (spec docs/02 §2.4.3): better-sqlite3, keyed by file content hash
 * + workspace digest. Advisory only — a corrupt or mismatched entry, and any sqlite-level
 * failure (unwritable file, deleted directory, locked db), is treated as a miss and
 * recomputed. The cache may never fail an audit: it is an optimization, not a dependency.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ModuleIR, ParseCache } from '@momus/core';

export class SqliteParseCache implements ParseCache {
  private readonly db: Database.Database;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.db = new Database(join(dir, 'modules.sqlite'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS modules (
        path TEXT PRIMARY KEY,
        file_hash TEXT NOT NULL,
        workspace_hash TEXT NOT NULL,
        ir TEXT NOT NULL
      );
    `);
  }

  get(path: string, fileHash: string, workspaceHash: string): ModuleIR | undefined {
    try {
      const row = this.db.prepare('SELECT file_hash, workspace_hash, ir FROM modules WHERE path = ?').get(path) as
        { file_hash: string; workspace_hash: string; ir: string } | undefined;
      if (!row) return undefined;
      if (row.file_hash !== fileHash || row.workspace_hash !== workspaceHash) return undefined;
      try {
        return JSON.parse(row.ir) as ModuleIR;
      } catch {
        // Corrupt entry: drop it and recompute rather than fail the audit.
        this.db.prepare('DELETE FROM modules WHERE path = ?').run(path);
        return undefined;
      }
    } catch {
      // Any sqlite-level failure — file deleted under a long-lived server, read-only mount,
      // locked db — is a cache miss. The cache is advisory; it may never fail an audit.
      return undefined;
    }
  }

  put(path: string, fileHash: string, workspaceHash: string, module: ModuleIR): void {
    try {
      this.db
        .prepare('INSERT OR REPLACE INTO modules (path, file_hash, workspace_hash, ir) VALUES (?, ?, ?, ?)')
        .run(path, fileHash, workspaceHash, JSON.stringify(module));
    } catch {
      // Failing to memoize costs a re-parse next run; failing the audit costs the user their
      // result. Swallow — "attempt to write a readonly database" must not surface as a tool error.
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed, or the file is gone; nothing to release either way.
    }
  }
}

/** Open (or create) the workspace parse cache unless caching is disabled in config. */
export function openParseCache(
  root: string,
  cacheConfig: { dir: string; enabled: boolean },
): SqliteParseCache | undefined {
  if (cacheConfig.enabled === false) return undefined;
  try {
    return new SqliteParseCache(join(root, cacheConfig.dir));
  } catch {
    // A workspace we cannot write to (read-only mount, permissions) still gets audited —
    // just without memoization. Running uncached is a degraded mode, not a failure mode.
    return undefined;
  }
}
