import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditEngine } from '../src/audit.ts';
import type { LanguageParser, ParseCache } from '../src/parser.ts';
import type { ModuleIR } from '../src/ir.ts';

function slowParser(ms: number): LanguageParser {
  return {
    language: 'typescript',
    canParse: (p) => /\.ts$/.test(p),
    resolveImport: () => null,
    parseModule: (path) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        // busy-wait: deterministic in test time without depending on timers
      }
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
        hash: '',
      };
    },
  };
}

function countingParser(counter: { n: number }): LanguageParser {
  return {
    language: 'typescript',
    canParse: (p) => /\.ts$/.test(p),
    resolveImport: () => null,
    parseModule: (path) => {
      counter.n++;
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
        hash: '',
      };
    },
  };
}

function fakeCache(): ParseCache & { hits: number; puts: number } {
  const store = new Map<string, { fileHash: string; workspaceHash: string; module: ModuleIR }>();
  return {
    hits: 0,
    puts: 0,
    get(path, fileHash, workspaceHash) {
      const entry = store.get(path);
      if (entry && entry.fileHash === fileHash && entry.workspaceHash === workspaceHash) {
        this.hits++;
        return entry.module;
      }
      return undefined;
    },
    put(path, fileHash, workspaceHash, module) {
      this.puts++;
      store.set(path, { fileHash, workspaceHash, module });
    },
  };
}

describe('AuditEngine parse cache', () => {
  it('emits a SYS-004 info diagnostic when a single-file parse exceeds the budget', () => {
    const root = mkdtempSync(join(tmpdir(), 'momus-sys004-'));
    try {
      writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
      const result = new AuditEngine({ root, parser: slowParser(30), parseBudgetMs: 1 }).run();
      const sys004 = result.diagnostics.find((d) => d.message.includes('SYS-004'));
      expect(sys004).toBeDefined();
      expect(sys004!.severity).toBe('info');
      expect(sys004!.span.file.endsWith('a.ts')).toBe(true);
      // never a crash: the audit still completes with a result
      expect(result.summary.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stays quiet when parses are within budget', () => {
    const root = mkdtempSync(join(tmpdir(), 'momus-sys004-ok-'));
    try {
      writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
      const result = new AuditEngine({ root, parser: slowParser(1), parseBudgetMs: 5000 }).run();
      expect(result.diagnostics.some((d) => d.message.includes('SYS-004'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serves a warm parse from cache and invalidates on content change', () => {
    const root = mkdtempSync(join(tmpdir(), 'momus-cache-'));
    try {
      writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
      const counter = { n: 0 };
      const parser = countingParser(counter);
      const cache = fakeCache();
      const run = () => new AuditEngine({ root, parser, cache }).run();

      const first = run();
      expect(counter.n).toBe(1);
      expect(cache.puts).toBe(1);
      expect(first.summary.filesAudited).toBe(1);

      // unchanged workspace → cache hit, no re-parse
      const second = run();
      expect(counter.n).toBe(1);
      expect(cache.hits).toBe(1);
      expect(second.summary.filesAudited).toBe(1);

      // content change → new file hash + workspace digest → re-parse
      writeFileSync(join(root, 'a.ts'), 'export const a = 2;\n');
      run();
      expect(counter.n).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to parsing when no cache is provided', () => {
    const root = mkdtempSync(join(tmpdir(), 'momus-cache-none-'));
    try {
      writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
      const counter = { n: 0 };
      const parser = countingParser(counter);
      new AuditEngine({ root, parser }).run();
      expect(counter.n).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
