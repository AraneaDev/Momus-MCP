import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditEngine } from '../src/audit.ts';
import type { LanguageParser } from '../src/parser.ts';

const dummyParser: LanguageParser = {
  canParse: () => true,
  parseModule: (path) => {
    if (path.endsWith('bad.ts')) throw new Error('Syntax failed');
    return {
      path,
      language: 'typescript',
      kind: 'test',
      hash: '',
      functions: [],
      symbols: [],
      mocks: [],
      comments: [],
    };
  },
  resolveImport: () => undefined,
};

describe('AuditEngine error handling', () => {
  it('surfaces file size/skip reasons as info diagnostics', () => {
    const root = mkdtempSync(join(tmpdir(), 'momus-audit-size-'));
    try {
      mkdirSync(join(root, 'tests'));
      // A file over the size limit (will be skipped by discoverFiles)
      writeFileSync(join(root, 'tests', 'huge.test.ts'), 'export const x = 1;');
      
      const engine = new AuditEngine({
        root,
        parser: dummyParser,
        config: {
          testFilePatterns: ['**/*.test.ts'],
          ignorePatterns: [],
          maxFileSizeBytes: 5, // smaller than 'export const x = 1;'
          maxIndexedLines: 1000,
          tokenBudget: { maxIssuesPerReport: 10 },
          languages: { typescript: true, php: true },
        }
      });

      const res = engine.run();
      expect(res.diagnostics.length).toBeGreaterThan(0);
      expect(res.diagnostics[0]!.severity).toBe('info');
      expect(res.diagnostics[0]!.message).toContain('file exceeds');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('catches parser exceptions and reports them as error diagnostics (SYS-001)', () => {
    const root = mkdtempSync(join(tmpdir(), 'momus-audit-err-'));
    try {
      mkdirSync(join(root, 'tests'));
      writeFileSync(join(root, 'tests', 'bad.test.ts'), 'const a =;');
      
      const engine = new AuditEngine({
        root,
        parser: {
          canParse: () => true,
          parseModule: () => {
            throw new Error('Syntax failed deeply');
          },
          resolveImport: () => undefined,
        },
      });

      const res = engine.run();
      const errDiag = res.diagnostics.find(d => d.severity === 'error' && d.message.includes('SYS-001'));
      expect(errDiag).toBeDefined();
      expect(errDiag!.message).toContain('Syntax failed deeply');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
