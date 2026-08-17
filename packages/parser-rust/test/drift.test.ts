import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { AuditEngine, CompositeParser, DEFAULT_CONFIG } from '@momus/core';
import { RustParser } from '../src/index.ts';

const FIX = join(import.meta.dirname, 'fixtures', 'drift');
const engine = () =>
  new AuditEngine({
    root: FIX,
    parser: new CompositeParser([new RustParser()]),
    config: { ...DEFAULT_CONFIG, languages: { typescript: false, php: false, python: false, rust: true } },
  });

describe('rust drift rules', () => {
  it('DRIFT-001 fires when a mock stubs a member missing from the trait', () => {
    const result = engine().run();
    const d1 = result.issues.filter((i) => i.rule === 'DRIFT-001');
    expect(d1.some((i) => i.message.includes('save2'))).toBe(true);
  });

  it('DRIFT-003 fires when a configured value is not assignable to the return type', () => {
    const result = engine().run();
    expect(result.issues.some((i) => i.rule === 'DRIFT-003')).toBe(true);
  });

  it('stays quiet on the healthy twin (no drift findings)', () => {
    const result = engine().run();
    const healthyDrift = result.issues.filter(
      (i) => i.span.file.includes('healthy_test.rs') && (i.rule === 'DRIFT-001' || i.rule === 'DRIFT-003'),
    );
    expect(healthyDrift).toHaveLength(0);
  });
});
