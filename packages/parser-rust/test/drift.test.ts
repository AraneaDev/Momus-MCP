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

  it('stays quiet on generic-dependent return types (type params, qself projections)', () => {
    // mockall dogfood (docs/11 row 31): `fn myfunc<V>(&self) -> V` and
    // `fn bar<T>(&self, _t: T) -> <T as OutputTrait>::Output` with return_const(42u32)
    // are unprovable statically — DRIFT-003 must not fire.
    const result = engine().run();
    const genericDrift = result.issues.filter(
      (i) => i.span.file.includes('generic_test.rs') && (i.rule === 'DRIFT-001' || i.rule === 'DRIFT-003'),
    );
    expect(genericDrift).toHaveLength(0);
  });

  it('still fires DRIFT-003 for a scalar literal against a resolvable struct return', () => {
    // repo.rs defines `pub struct Record` in production, so `return_const(42)` on
    // `fn record(&self) -> Record` is provably a mismatch — the conservative pass only
    // applies to unresolvable names.
    const result = engine().run();
    const d3 = result.issues.filter((i) => i.rule === 'DRIFT-003');
    expect(d3.some((i) => i.message.includes("'record'"))).toBe(true);
  });

  it('resolves a member inherited from a trait supertrait (no DRIFT-001 false flag)', () => {
    // `trait Derived : Base` — `add` is declared on Base and inherited by Derived, so stubbing
    // it on MockDerived must not read as "missing member" (mock_derive's advanced_traits.rs).
    const result = engine().run();
    const d1 = result.issues.filter((i) => i.span.file.includes('supertrait_test.rs') && i.rule === 'DRIFT-001');
    expect(d1).toHaveLength(0);
  });
});
