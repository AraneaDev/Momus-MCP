import { describe, expect, it } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuditEngine } from '@momus/core';
import { TypeScriptParser } from '@momus/parser-typescript';

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
    expect(byRule).toEqual({ 'DRIFT-001': 'error', 'TAUT-002': 'error', 'TAUT-006': 'warning' });
  });

  it('produces deterministic issue ids (stable across runs)', () => {
    const second = engine.run();
    expect(second.issues.map((i) => i.id)).toEqual(result.issues.map((i) => i.id));
  });

  it('summary counts match the issue list', () => {
    expect(result.summary.errors).toBe(6);
    expect(result.summary.warnings).toBe(1);
    expect(result.summary.issues).toBe(7);
    expect(result.summary.suppressed).toBe(0);
  });

  it('index contains the production classes', () => {
    expect(result.indexStats.symbols).toBeGreaterThanOrEqual(3); // Db, InvoiceRow, LedgerService
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
