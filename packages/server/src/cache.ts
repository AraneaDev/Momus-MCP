/**
 * Persistent IR cache (spec docs/02 §2.4.3): better-sqlite3, keyed by file content hash
 * + workspace digest. Advisory only — a corrupt or mismatched entry is always treated as a
 * miss and recomputed, never a correctness hazard.
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
  }

  put(path: string, fileHash: string, workspaceHash: string, module: ModuleIR): void {
    this.db
      .prepare('INSERT OR REPLACE INTO modules (path, file_hash, workspace_hash, ir) VALUES (?, ?, ?, ?)')
      .run(path, fileHash, workspaceHash, JSON.stringify(module));
  }

  close(): void {
    this.db.close();
  }
}

/** Open (or create) the workspace parse cache unless caching is disabled in config. */
export function openParseCache(
  root: string,
  cacheConfig: { dir: string; enabled: boolean },
): SqliteParseCache | undefined {
  if (cacheConfig.enabled === false) return undefined;
  return new SqliteParseCache(join(root, cacheConfig.dir));
}
