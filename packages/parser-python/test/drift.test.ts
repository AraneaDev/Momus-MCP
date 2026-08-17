import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { AuditEngine, CompositeParser, DEFAULT_CONFIG } from '@momus/core';
import { PythonParser } from '../src/index.ts';

const FIX = join(import.meta.dirname, 'fixtures', 'drift');
const engine = () =>
  new AuditEngine({
    root: FIX,
    parser: new CompositeParser([new PythonParser()]),
    config: { ...DEFAULT_CONFIG, languages: { typescript: false, php: false, python: true } },
  });

describe('python drift rules', () => {
  it('DRIFT-001 fires when a patched method does not exist', () => {
    const result = engine().run();
    const d1 = result.issues.filter((i) => i.rule === 'DRIFT-001');
    expect(d1.some((i) => i.message.includes('save2'))).toBe(true);
  });

  it('DRIFT-003 fires when a configured value is not assignable to the annotated return type', () => {
    const result = engine().run();
    expect(result.issues.some((i) => i.rule === 'DRIFT-003')).toBe(true);
  });

  it('DRIFT-003 fires on an unannotated method whose return type is inferred via pyright', () => {
    const result = engine().run();
    const d3 = result.issues.filter((i) => i.rule === 'DRIFT-003');
    expect(d3.some((i) => i.message.includes('count'))).toBe(true);
  });

  it('DRIFT-005 fires when patch() targets a missing module attribute', () => {
    const result = engine().run();
    expect(result.issues.some((i) => i.rule === 'DRIFT-005')).toBe(true);
  });

  it('DRIFT-005 resolves src-layout packages (`src/pkg/mod.py`) and fires on a missing attr', () => {
    const fix = join(import.meta.dirname, 'fixtures', 'src-layout');
    const result = new AuditEngine({
      root: fix,
      parser: new CompositeParser([new PythonParser()]),
      config: { ...DEFAULT_CONFIG, languages: { typescript: false, php: false, python: true } },
    }).run();
    expect(result.issues.some((i) => i.rule === 'DRIFT-005' && i.message.includes('prod_missing.nope'))).toBe(true);
  });

  it('stays quiet patching a real src-layout attribute', () => {
    const fix = join(import.meta.dirname, 'fixtures', 'src-layout');
    const result = new AuditEngine({
      root: fix,
      parser: new CompositeParser([new PythonParser()]),
      config: { ...DEFAULT_CONFIG, languages: { typescript: false, php: false, python: true } },
    }).run();
    expect(result.issues.some((i) => i.rule === 'DRIFT-005' && i.message.includes('existing_attr'))).toBe(false);
  });

  it('stays quiet on the healthy module twin (no drift findings)', () => {
    const result = engine().run();
    const healthyDrift = result.issues.filter(
      (i) => i.span.file.includes('healthy_test.py') && (i.rule === 'DRIFT-001' || i.rule === 'DRIFT-003'),
    );
    expect(healthyDrift).toHaveLength(0);
  });

  it('skips Python modules entirely when the language gate is disabled', () => {
    const result = new AuditEngine({
      root: FIX,
      parser: new CompositeParser([new PythonParser()]),
      config: { ...DEFAULT_CONFIG, languages: { typescript: false, php: false, python: false } },
    }).run();
    expect(result.indexStats.symbols).toBe(0);
    expect(result.issues).toHaveLength(0);
  });
});
