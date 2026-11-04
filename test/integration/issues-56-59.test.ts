/**
 * Regression tests for the reproductions in GitHub issues #56–#59, run end to end through the
 * real TypeScript parser and the audit engine on throwaway workspaces.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AuditEngine, discoverFiles, DEFAULT_CONFIG, type AuditOptions } from '@momus/core';
import { TypeScriptParser, invalidateProgramCache } from '@momus/parser-typescript';

const roots: string[] = [];
afterEach(() => {
  invalidateProgramCache();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'momus-issues-'));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

function audit(root: string, extra: Partial<AuditOptions> = {}) {
  return new AuditEngine({ root, parser: new TypeScriptParser(), ...extra }).run();
}

const rulesOf = (r: ReturnType<typeof audit>, rule: string) => r.issues.filter((i) => i.rule === rule);

describe('#57 DRIFT-005 on default exports and CommonJS module.exports', () => {
  it('accepts a `default` factory key for an ES default export', () => {
    const root = workspace({
      'src/Widget.tsx': 'export default function Widget() { return null; }\n',
      'src/Other.test.tsx': [
        "import { it, expect, vi } from 'vitest';",
        "import Widget from './Widget';",
        "vi.mock('./Widget', () => ({ default: () => null }));",
        "it('renders', () => { expect(Widget()).toBeNull(); });",
      ].join('\n'),
    });
    expect(rulesOf(audit(root), 'DRIFT-005')).toEqual([]);
  });

  it('accepts `export default <expression>` and `export { x as default }`', () => {
    const root = workspace({
      'src/a.ts': 'const a = 1;\nexport default a;\n',
      'src/b.ts': 'const b = 1;\nexport { b as default };\n',
      'src/x.test.ts': [
        "import { vi, it } from 'vitest';",
        "vi.mock('./a', () => ({ default: 2 }));",
        "vi.mock('./b', () => ({ default: 3 }));",
        "it('x', () => {});",
      ].join('\n'),
    });
    expect(rulesOf(audit(root), 'DRIFT-005')).toEqual([]);
  });

  it('accepts keys of a CommonJS `module.exports = { ... }` object', () => {
    const root = workspace({
      'shared/db.js': 'async function getPool() { return {}; }\nmodule.exports = { getPool };\n',
      'shared/db.test.js': [
        "jest.mock('./db', () => ({ getPool: jest.fn() }));",
        "const { getPool } = require('./db');",
        "test('pool', () => { getPool(); expect(getPool).toHaveBeenCalledTimes(1); });",
      ].join('\n'),
    });
    expect(rulesOf(audit(root), 'DRIFT-005')).toEqual([]);
  });

  it('accepts `exports.x =` assignments, `__esModule`, and still flags a truly missing key', () => {
    const root = workspace({
      'lib/util.js': 'exports.slugify = (s) => s;\nmodule.exports.trim = (s) => s.trim();\n',
      'lib/util.test.js': [
        "jest.mock('./util', () => ({ __esModule: true, slugify: jest.fn(), trim: jest.fn(), gone: jest.fn() }));",
        "test('x', () => {});",
      ].join('\n'),
    });
    const drift = rulesOf(audit(root), 'DRIFT-005');
    expect(drift.map((i) => i.message)).toEqual(["missing-export: factory key 'gone' is not exported by './util'"]);
  });

  it('does not judge keys against an export list it cannot enumerate', () => {
    const root = workspace({
      'src/factory.js': 'module.exports = makeApi();\nfunction makeApi() { return { a: 1 }; }\n',
      'src/barrel.ts': "export * from './factory';\n",
      'src/x.test.ts': [
        "import { vi, it } from 'vitest';",
        "vi.mock('./factory', () => ({ a: 1 }));",
        "vi.mock('./barrel', () => ({ a: 1 }));",
        "it('x', () => {});",
      ].join('\n'),
    });
    expect(rulesOf(audit(root), 'DRIFT-005')).toEqual([]);
  });
});

describe('#58 vi.mock factory that does not return an object literal', () => {
  const files = {
    'src/Widget.tsx': 'export default function Widget() { return null; }\n',
    'src/Lazy.test.tsx': [
      "import { it, expect, vi } from 'vitest';",
      "import Widget from './Widget';",
      'const stub = (name: string) => ({ default: () => name });',
      "vi.mock('./Widget', () => stub('x'));",
      "it('renders', () => { expect(Widget()).toBe('x'); });",
    ].join('\n'),
  };

  it('parses the file, skips the opaque factory, and still audits the rest', () => {
    const root = workspace(files);
    const result = audit(root, { paths: ['src/Lazy.test.tsx'] });
    expect(result.diagnostics.filter((d) => d.message.startsWith('SYS-001'))).toEqual([]);
    expect(rulesOf(result, 'SYS-001')).toEqual([]);
    expect(result.summary.filesFailed).toBeUndefined();
    // The mock itself is still recorded (MOCK-002 sees a self-mock), just without factory keys.
    expect(rulesOf(result, 'DRIFT-005')).toEqual([]);
  });

  it('reports a requested test file that fails to parse as an error, not a clean result', () => {
    const root = workspace({ 'src/a.test.ts': "it('x', () => {});\n" });
    const parser = new TypeScriptParser();
    const throwing = Object.assign(Object.create(Object.getPrototypeOf(parser)), parser, {
      parseModule: () => {
        throw new Error('boom');
      },
    }) as TypeScriptParser;
    const result = new AuditEngine({ root, parser: throwing, paths: ['src/a.test.ts'] }).run();
    expect(result.summary.totalErrors).toBe(1);
    expect(result.summary.filesFailed).toBe(1);
    expect(result.issues[0]!.rule).toBe('SYS-001');
    expect(result.issues[0]!.message).toContain('boom');
  });
});

describe('#59 nested .gitignore keeps build output out of the index', () => {
  it('skips directories listed in a sub-project .gitignore', () => {
    const root = workspace({
      'frontend/.gitignore': 'dist-visual\n',
      'frontend/dist-visual/assets/Selector-BURzuFV7.js': 'export const x = 1;\n',
      'frontend/src/Selector.ts': 'export const x = 1;\n',
      'backend/dist-visual/kept.ts': 'export const y = 1;\n',
    });
    const { files } = discoverFiles({
      root,
      testPatterns: DEFAULT_CONFIG.testFilePatterns,
      ignorePatterns: DEFAULT_CONFIG.ignorePatterns,
      maxFileSizeBytes: DEFAULT_CONFIG.maxFileSizeBytes,
      maxIndexedLines: DEFAULT_CONFIG.maxIndexedLines,
    });
    const rels = files.map((f) => f.path.slice(root.length + 1).replace(/\\/g, '/')).sort();
    // The nested rule is scoped to its own directory: backend/dist-visual is not ignored.
    expect(rels).toEqual(['backend/dist-visual/kept.ts', 'frontend/src/Selector.ts']);
  });

  it('honors .git/info/exclude and lets a nested negation re-include a file', () => {
    const root = workspace({
      '.git/info/exclude': 'scratch/\n',
      '.gitignore': '*.gen.ts\n',
      'pkg/.gitignore': '!keep.gen.ts\n',
      'scratch/a.ts': 'export {}\n',
      'pkg/drop.gen.ts': 'export {}\n',
      'pkg/keep.gen.ts': 'export {}\n',
      'pkg/main.ts': 'export {}\n',
    });
    const { files } = discoverFiles({
      root,
      testPatterns: DEFAULT_CONFIG.testFilePatterns,
      ignorePatterns: DEFAULT_CONFIG.ignorePatterns,
      maxFileSizeBytes: DEFAULT_CONFIG.maxFileSizeBytes,
      maxIndexedLines: DEFAULT_CONFIG.maxIndexedLines,
    });
    const rels = files.map((f) => f.path.slice(root.length + 1).replace(/\\/g, '/')).sort();
    expect(rels).toEqual(['pkg/keep.gen.ts', 'pkg/main.ts']);
  });
});

describe('#56 heap guard', () => {
  const files = {
    'src/a.ts': 'export function a() { return 1; }\n',
    'src/b.ts': 'export function b() { return 2; }\n',
    'src/a.test.ts':
      "import { it, expect } from 'vitest';\nimport { a } from './a';\nit('a', () => { expect(a()).toBe(1); });\n",
  };

  it('stops with a partial result and a SYS-006 error instead of exhausting the heap', () => {
    const root = workspace(files);
    let released = 0;
    const parser = new TypeScriptParser();
    parser.releaseMemory = () => {
      released++;
    };
    const result = new AuditEngine({ root, parser, heapGuard: { heapUsage: () => 0.99 } }).run();
    expect(released).toBe(1);
    expect(result.summary.totalErrors).toBe(1);
    expect(result.summary.filesFailed).toBe(1);
    const [stop] = rulesOf(result, 'SYS-006');
    expect(stop!.span.file).toBe(join(root, 'src/a.test.ts'));
    expect(result.diagnostics.some((d) => d.message.startsWith('SYS-006'))).toBe(true);
  });

  it('releases parser memory once under pressure and keeps going below the stop threshold', () => {
    const root = workspace(files);
    let released = 0;
    const parser = new TypeScriptParser();
    parser.releaseMemory = () => {
      released++;
    };
    const result = new AuditEngine({ root, parser, heapGuard: { heapUsage: () => 0.8 } }).run();
    expect(released).toBe(1);
    expect(rulesOf(result, 'SYS-006')).toEqual([]);
    expect(result.summary.filesFailed).toBeUndefined();
  });
});
