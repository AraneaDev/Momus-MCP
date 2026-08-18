import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditEngine } from '../src/audit.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
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
        },
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
      const errDiag = res.diagnostics.find((d) => d.severity === 'error' && d.message.includes('SYS-001'));
      expect(errDiag).toBeDefined();
      expect(errDiag!.message).toContain('Syntax failed deeply');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('mock target resolution', () => {
  const sp = (file: string, line: number) => ({ file, startLine: line, startCol: 1, endLine: line, endCol: 2 });
  const stub = (
    name: string,
    span: { file: string; startLine: number; startCol: number; endLine: number; endCol: number },
  ) => ({
    name,
    span,
    api: 'unknown',
    returnValues: [],
  });
  const traitSymbol = (file: string, name: string, members: string[]) => ({
    id: `${file}#${name}`,
    name,
    kind: 'interface' as const,
    span: sp(file, 1),
    members: members.map((m) => ({
      id: `${file}#${name}.${m}`,
      name: m,
      kind: 'method' as const,
      span: sp(file, 1),
      members: [],
      extendsIds: [],
      implementsIds: [],
    })),
    extendsIds: [],
    implementsIds: [],
  });

  it('prefers a same-file target symbol over an unrelated production symbol with the same name', () => {
    // mockall-style: the test file defines its own `trait Foo` (with reffoo) and mocks it, while
    // the production crate has an unrelated `Foo` (without reffoo).
    const root = mkdtempSync(join(tmpdir(), 'momus-resolve-samefile-'));
    try {
      mkdirSync(join(root, 'tests'));
      mkdirSync(join(root, 'src'));
      const testPath = join(root, 'tests', 'anyhow.rs');
      const prodPath = join(root, 'src', 'examples.rs');
      writeFileSync(testPath, 'placeholder');
      writeFileSync(prodPath, 'placeholder');
      const engine = new AuditEngine({
        root,
        parser: {
          canParse: () => true,
          parseModule: (path) => {
            if (path === testPath) {
              return {
                path,
                language: 'rust',
                kind: 'test',
                framework: 'mockall',
                imports: [],
                symbols: [traitSymbol(testPath, 'Foo', ['reffoo'])],
                exports: ['Foo'],
                mocks: [
                  {
                    id: `${testPath}#mock:1:1`,
                    span: sp(testPath, 1),
                    framework: 'mockall',
                    pattern: 'automock',
                    target: { kind: 'class', exportName: 'Foo', span: sp(testPath, 1) },
                    stubbedMembers: [stub('reffoo', sp(testPath, 2))],
                    configuredValues: [],
                    invocationSites: [],
                    isAutomock: true,
                  },
                ],
                assertions: [],
                functions: [],
                comments: [],
                diagnostics: [],
                hash: '',
              };
            }
            return {
              path,
              language: 'rust',
              kind: 'production',
              imports: [],
              symbols: [traitSymbol(prodPath, 'Foo', ['foo'])],
              exports: ['Foo'],
              mocks: [],
              assertions: [],
              functions: [],
              comments: [],
              diagnostics: [],
              hash: '',
            };
          },
          resolveImport: () => undefined,
        },
        config: {
          ...DEFAULT_CONFIG,
          languages: { typescript: false, php: false, python: false, rust: true },
          testFilePatterns: ['**/tests/**/*.rs'],
          ignorePatterns: [],
          cache: { dir: '.momus/cache', enabled: false },
        },
      });
      const res = engine.run();
      expect(res.issues.filter((i) => i.rule === 'DRIFT-001')).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still flags a stub missing from the production target when the test defines no same-file symbol', () => {
    const root = mkdtempSync(join(tmpdir(), 'momus-resolve-prod-'));
    try {
      mkdirSync(join(root, 'tests'));
      mkdirSync(join(root, 'src'));
      const testPath = join(root, 'tests', 'x.rs');
      const prodPath = join(root, 'src', 'repo.rs');
      writeFileSync(testPath, 'placeholder');
      writeFileSync(prodPath, 'placeholder');
      const engine = new AuditEngine({
        root,
        parser: {
          canParse: () => true,
          parseModule: (path) => {
            if (path === testPath) {
              return {
                path,
                language: 'rust',
                kind: 'test',
                framework: 'mockall',
                imports: [],
                symbols: [],
                exports: [],
                mocks: [
                  {
                    id: `${testPath}#mock:1:1`,
                    span: sp(testPath, 1),
                    framework: 'mockall',
                    pattern: 'automock',
                    target: { kind: 'class', exportName: 'Repo', span: sp(testPath, 1) },
                    stubbedMembers: [stub('gone', sp(testPath, 2))],
                    configuredValues: [],
                    invocationSites: [],
                    isAutomock: true,
                  },
                ],
                assertions: [],
                functions: [],
                comments: [],
                diagnostics: [],
                hash: '',
              };
            }
            return {
              path,
              language: 'rust',
              kind: 'production',
              imports: [],
              symbols: [traitSymbol(prodPath, 'Repo', ['find'])],
              exports: ['Repo'],
              mocks: [],
              assertions: [],
              functions: [],
              comments: [],
              diagnostics: [],
              hash: '',
            };
          },
          resolveImport: () => undefined,
        },
        config: {
          ...DEFAULT_CONFIG,
          languages: { typescript: false, php: false, python: false, rust: true },
          testFilePatterns: ['**/tests/**/*.rs'],
          ignorePatterns: [],
          cache: { dir: '.momus/cache', enabled: false },
        },
      });
      const res = engine.run();
      const d1 = res.issues.filter((i) => i.rule === 'DRIFT-001');
      expect(d1).toHaveLength(1);
      expect(d1[0]!.message).toContain("'gone' does not exist on Repo");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
