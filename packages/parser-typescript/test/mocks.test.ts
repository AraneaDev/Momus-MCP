import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { TypeScriptParser } from '../src/index.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const parser = new TypeScriptParser();

function parseTestFile(): ReturnType<TypeScriptParser['parseModule']> {
  const p = join(FIXTURES, 'tests', 'ledger.test.ts');
  return parser.parseModule(p, readFileSync(p, 'utf8'), {
    config: undefined,
    resolveImport: (spec) => parser.resolveImport(spec, p),
  });
}

describe('module classification', () => {
  it('marks test files as test and production files as production', () => {
    const test = parseTestFile();
    expect(test.kind).toBe('test');
    expect(test.framework).toBe('vitest');
    const prod = parser.parseModule(
      join(FIXTURES, 'src', 'services', 'ledger.ts'),
      readFileSync(join(FIXTURES, 'src', 'services', 'ledger.ts'), 'utf8'),
      { config: undefined, resolveImport: () => null },
    );
    expect(prod.kind).toBe('production');
  });
});

describe('symbol extraction', () => {
  it('extracts classes, members, and signatures with return types', () => {
    const prod = parser.parseModule(
      join(FIXTURES, 'src', 'services', 'ledger.ts'),
      readFileSync(join(FIXTURES, 'src', 'services', 'ledger.ts'), 'utf8'),
      { config: undefined, resolveImport: () => null },
    );
    const cls = prod.symbols.find((s) => s.name === 'LedgerService');
    expect(cls?.kind).toBe('class');
    const totalFor = cls?.members.find((m) => m.name === 'totalFor');
    expect(totalFor?.signature?.parameters[0]).toMatchObject({ name: 'id', optional: false });
    expect(totalFor?.signature?.returnType?.kind).toBe('named');
  });
});

describe('mock detection (fixture test file)', () => {
  const test = parseTestFile();

  it('detects the vi.mock module mock with factory keys', () => {
    const m = test.mocks.find((x) => x.pattern === 'vi.mock');
    expect(m?.target?.kind).toBe('module');
    expect(m?.target?.specifier).toBe('../src/services/db');
    expect(m?.stubbedMembers.map((s) => s.name)).toEqual(['Db']);
  });

  it('detects object-literal doubles with vi.fn keys', () => {
    const m = test.mocks.find((x) => x.pattern === 'object-literal');
    expect(m?.stubbedMembers.map((s) => s.name)).toEqual(['getTotal']);
  });

  it('detects vi.spyOn with resolved instance-member targets', () => {
    const spies = test.mocks.filter((x) => x.pattern === 'vi.spyOn');
    expect(spies).toHaveLength(2);
    const bad = spies.find((s) => s.target?.memberName === 'totalForX');
    expect(bad?.target?.symbolId).toContain('LedgerService');
  });

  it('detects vi.mocked(new Db()) instance mocks', () => {
    const m = test.mocks.find((x) => x.pattern === 'vi.mocked-instance');
    expect(m?.target?.kind).toBe('class');
    expect(m?.target?.symbolId).toContain('Db');
  });

  it('collects configured values; generic return types are marked unknown', () => {
    const m = test.mocks.find((x) => x.pattern === 'vi.mocked-instance')!;
    expect(m.configuredValues).toHaveLength(1);
    expect(m.configuredValues[0]!.api).toBe('mockResolvedValue');
    // query<T>(): Promise<T[]> — unresolved type parameter -> not statically checkable
    expect(m.configuredValues[0]!.assignable).toBe('unknown');
  });

  it('does not treat the SUT instance as a mock', () => {
    // `new LedgerService(...)` must not appear as a mock in the final list
    const sutLike = test.mocks.filter((m) => m.target?.symbolId?.includes('LedgerService') && m.pattern !== 'vi.spyOn');
    expect(sutLike).toHaveLength(0);
  });
});

describe('suppression comments', () => {
  it('extracts trailing vs standalone line comments', () => {
    const src = 'const a = 1; // @momus-ignore\n// @momus-ignore:TAUT-002\nconst b = 2;';
    const mod = parser.parseModule(join(FIXTURES, 'tests', 'scratch.test.ts'), src, {
      config: undefined,
      resolveImport: () => null,
    });
    const trailing = mod.comments.find((c) => c.text.includes('@momus-ignore') && c.trailing);
    const standalone = mod.comments.find((c) => c.text.includes('@momus-ignore') && !c.trailing);
    expect(trailing?.line).toBe(1);
    expect(standalone?.line).toBe(2);
  });
});
