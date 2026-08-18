import { describe, expect, it } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuditEngine, CompositeParser, DEFAULT_CONFIG } from '@momus/core';
import { TypeScriptParser } from '@momus/parser-typescript';
import { PythonParser } from '@momus/parser-python';
import { RustParser } from '@momus/parser-rust';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'packages',
  'parser-typescript',
  'test',
  'fixtures',
);

describe('golden audit — planted violations fixture', () => {
  const engine = new AuditEngine({
    root: FIXTURES,
    parser: new TypeScriptParser(),
    config: undefined,
  });

  const result = engine.run();

  it('fires exactly the planted violations and nothing else', () => {
    const found = result.issues.map((i) => `${i.rule}@${i.span.startLine}`).sort();
    expect(found).toEqual([
      'DRIFT-001@16', // spyOn on totalForX which does not exist
      'DRIFT-003@30', // spy-bound mockImplementation(() => 'nope') not assignable to totalCents(): number
      'DRIFT-003@37', // spy-bound mockReturnValueOnce('nope') not assignable to totalCents(): number
      'DRIFT-003@9', // spy-bound mockReturnValue('nope') not assignable to totalCents(): number
      'TAUT-002@11', // echoes the stubbed value 42 against itself
      'TAUT-002@18', // echoes the beforeEach value 42 against itself
      'TAUT-002@22', // echoes the beforeAll value 7 against itself
      'TAUT-002@39', // echoes the first nested setup value 11
      'TAUT-002@49', // echoes the second nested setup value 22
      'TAUT-006@18', // toHaveBeenCalled on an unconfigured, unreached spy
    ]);
  });

  it('keeps the healthy test quiet', () => {
    const healthyLines = result.issues.filter(
      (i) => i.span.file.endsWith('/before-each.test.ts') && i.span.startLine >= 23 && i.span.startLine <= 27,
    );
    expect(healthyLines).toEqual([]);
  });

  it('reports correct severities', () => {
    const byRule = Object.fromEntries(result.issues.map((i) => [i.rule, i.severity]));
    expect(byRule).toEqual({
      'DRIFT-001': 'error',
      'DRIFT-003': 'warning',
      'TAUT-002': 'error',
      'TAUT-006': 'warning',
    });
  });

  it('produces deterministic issue ids (stable across runs)', () => {
    const second = engine.run();
    expect(second.issues.map((i) => i.id)).toEqual(result.issues.map((i) => i.id));
  });

  it('summary counts match the issue list', () => {
    expect(result.summary.errors).toBe(6);
    expect(result.summary.warnings).toBe(4);
    expect(result.summary.issues).toBe(10);
    expect(result.summary.suppressed).toBe(0);
  });

  it('index contains the production classes', () => {
    expect(result.indexStats.symbols).toBeGreaterThanOrEqual(3); // Db, InvoiceRow, LedgerService
  });
});

describe('golden audit — python drift fixtures', () => {
  const PY = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'packages',
    'parser-python',
    'test',
    'fixtures',
    'drift',
  );
  const result = new AuditEngine({
    root: PY,
    parser: new CompositeParser([new PythonParser()]),
    config: { ...DEFAULT_CONFIG, languages: { typescript: false, php: false, python: true } },
  }).run();

  it('fires exactly the planted python drift + reachability findings', () => {
    const found = result.issues.map((i) => `${i.rule}@${i.span.file.split('/').pop()}:${i.span.startLine}`).sort();
    expect(found).toEqual([
      'DRIFT-001@drift_test.py:6', // patch.object(Repo, "save2") — member does not exist
      'DRIFT-003@drift_test.py:12', // price.return_value = "nope" not assignable to int
      'DRIFT-003@drift_test.py:17', // count.return_value = "nope" not assignable to inferred int
      'DRIFT-005@test_patch_imports.py:29', // function-local import is not a module attribute
      'DRIFT-005@test_patch_missing.py:5', // patch("prod_missing.missing") — attribute does not exist
      'MOCK-001@test_patch_imports.py:1', // over-mocking heuristic on the mock-only patch fixture
      'MOCK-001@test_patch_missing.py:1', // over-mocking heuristic on the mock-only patch fixture
      'TAUT-005@drift_test.py:11', // zero-reach stub
      'TAUT-005@drift_test.py:16', // zero-reach stub (test_count mock)
      'TAUT-005@healthy_test.py:11', // zero-reach stub (annotated twin is drift-clean)
    ]);
  });

  it('keeps the healthy annotated twin quiet on drift rules', () => {
    const healthyDrift = result.issues.filter(
      (i) => i.span.file.includes('healthy_test.py') && i.rule.startsWith('DRIFT'),
    );
    expect(healthyDrift).toEqual([]);
  });
});

describe('golden audit — rust drift fixtures', () => {
  const RUST = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'packages',
    'parser-rust',
    'test',
    'fixtures',
    'drift',
  );
  const result = new AuditEngine({
    root: RUST,
    parser: new CompositeParser([new RustParser()]),
    config: { ...DEFAULT_CONFIG, languages: { typescript: false, php: false, python: false, rust: true } },
  }).run();

  it('fires exactly the planted rust drift + reachability findings', () => {
    const found = result.issues.map((i) => `${i.rule}@${i.span.file.split('/').pop()}:${i.span.startLine}`).sort();
    expect(found).toEqual([
      'DRIFT-001@drift_test.rs:10', // expect_save2() — member does not exist on Repo
      'DRIFT-003@drift_test.rs:11', // return_const("nope") not assignable to u32
      'DRIFT-003@drift_test.rs:12', // return_const(42) not assignable to a resolvable struct return
      'MOCK-002@generic_test.rs:36', // automock fixture mocks its own trait (info)
      'MOCK-002@generic_test.rs:43', // automock fixture mocks its own trait (info)
      'TAUT-005@drift_test.rs:9', // zero-reach stub
      'TAUT-005@healthy_test.rs:9', // zero-reach stub (healthy twin is drift-clean)
    ]);
  });

  it('keeps the healthy twin quiet on drift rules', () => {
    const healthyDrift = result.issues.filter(
      (i) => i.span.file.includes('healthy_test.rs') && i.rule.startsWith('DRIFT'),
    );
    expect(healthyDrift).toEqual([]);
  });
});

describe('golden audit — suppression works end to end', () => {
  it('@momus-ignore:TAUT-002 above the echo suppresses it', async () => {
    const dir = join(FIXTURES, 'suppressed');
    const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const tmp = mkdtempSync(join(tmpdir(), 'momus-supp-'));
    mkdirSync(join(tmp, 'src'), { recursive: true });
    mkdirSync(join(tmp, 'tests'), { recursive: true });
    writeFileSync(join(tmp, 'src', 'svc.ts'), 'export class Svc { run(): number { return 7; } }\n');
    writeFileSync(join(tmp, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }));
    writeFileSync(
      join(tmp, 'tests', 'svc.test.ts'),
      [
        "import { expect, it, vi } from 'vitest';",
        "import { Svc } from '../src/svc';",
        'it("echo", () => {',
        '  const mocked = { run: vi.fn() };',
        '  mocked.run.mockReturnValue(7);',
        '  // @momus-ignore:TAUT-002',
        '  expect(mocked.run()).toBe(7);',
        '});',
        '',
      ].join('\n'),
    );
    try {
      const res = new AuditEngine({ root: tmp, parser: new TypeScriptParser() }).run();
      expect(res.issues.filter((i) => i.rule === 'TAUT-002')).toHaveLength(0);
      expect(res.summary.suppressed).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      void dir;
    }
  });
});
