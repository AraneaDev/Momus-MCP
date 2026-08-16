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

  it('extracts vi.fn implementation arity for object-literal stubs', () => {
    const p = join(FIXTURES, 'tests', 'signature.fixture.ts');
    const signature = parser.parseModule(p, readFileSync(p, 'utf8'), {
      config: undefined,
      resolveImport: (spec) => parser.resolveImport(spec, p),
    });
    const wrong = signature.mocks.find(
      (m) => m.pattern === 'object-literal' && m.stubbedMembers.some((s) => s.name === 'query'),
    )!;
    const healthy = signature.mocks
      .filter((m) => m.pattern === 'object-literal')
      .find((m) => m.stubbedMembers[0]?.signature?.parameters.length === 2)!;
    expect(wrong.stubbedMembers[0]?.signature?.parameters).toHaveLength(3);
    expect(healthy).toBeDefined();
    const spy = signature.mocks.find((m) => m.pattern === 'vi.spyOn');
    expect(spy?.stubbedMembers[0]?.signature?.parameters).toHaveLength(2);
    const spyTypes = signature.mocks
      .filter((m) => m.pattern === 'vi.spyOn')
      .map((m) => m.stubbedMembers[0]?.signature?.parameters[0]?.type);
    expect(spyTypes.some((type) => type?.kind === 'named' && type.name === 'number')).toBe(true);
    expect(spyTypes.some((type) => type?.kind === 'named' && type.name === 'string')).toBe(true);
  });

  it('detects module automock helper APIs and stubGlobal', () => {
    const p = join(FIXTURES, 'tests', 'automock.fixture.ts');
    const automock = parser.parseModule(p, readFileSync(p, 'utf8'), {
      config: undefined,
      resolveImport: (spec) => parser.resolveImport(spec, p),
    });
    expect(automock.mocks.filter((m) => m.isAutomock).map((m) => m.pattern)).toEqual([
      'vi.importMock',
      'jest.requireMock',
      'jest.createMockFromModule',
    ]);
    const global = automock.mocks.find((m) => m.pattern === 'vi.stubGlobal');
    expect(global?.target?.kind).toBe('global');
    expect(global?.target?.exportName).toBe('fetch');
    expect(automock.mocks.filter((m) => m.pattern === 'vi.fn')).toHaveLength(1);
    expect(automock.mocks).toHaveLength(5);
  });

  it('detects Proxy doubles whose get handler returns a mock function', () => {
    const p = join(FIXTURES, 'tests', 'proxy.fixture.ts');
    const proxy = parser.parseModule(p, readFileSync(p, 'utf8'), {
      config: undefined,
      resolveImport: (spec) => parser.resolveImport(spec, p),
    });
    const detected = proxy.mocks.filter((m) => m.pattern === 'proxy');
    expect(detected).toHaveLength(1);
    expect(detected[0]?.target?.symbolId).toContain('LedgerService');
    expect(proxy.mocks.some((m) => m.pattern === 'proxy' && m.span.startLine === 9)).toBe(false);
  });

  it('collects assigned mockImplementation configs for Vitest and Jest', () => {
    const p = join(FIXTURES, 'tests', 'mock-implementation.fixture.ts');
    const implementation = parser.parseModule(p, readFileSync(p, 'utf8'), {
      config: undefined,
      resolveImport: (spec) => parser.resolveImport(spec, p),
    });
    const mocks = implementation.mocks.filter((m) => m.pattern === 'vi.fn' || m.pattern === 'jest.fn');
    expect(mocks).toHaveLength(2);
    expect(mocks.map((m) => m.configuredValues[0]?.api)).toEqual(['mockImplementation', 'mockImplementation']);
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

describe('mock hand-off reachability (TAUT-005 scope isolation)', () => {
  const p = join(FIXTURES, 'tests', 'handoff.fixture.ts');
  const handoff = parser.parseModule(p, readFileSync(p, 'utf8'), {
    config: undefined,
    resolveImport: (spec) => parser.resolveImport(spec, p),
  });

  it('marks a chained-config mock handed off by name as reachable', () => {
    const first = handoff.mocks.find((m) => m.pattern === 'vi.fn' && m.span.startLine === 11);
    expect(first?.configuredValues).toHaveLength(1);
    expect(first?.invocationSites.map((s) => s.startLine)).toEqual([12]);
  });

  it('resolves the same name independently across test scopes', () => {
    // Both `const mockRun = vi.fn(...)` declarations share the identifier name but live in
    // different `it` scopes; each must resolve to its own mock, not the last one.
    const first = handoff.mocks.find((m) => m.pattern === 'vi.fn' && m.span.startLine === 11)!;
    const second = handoff.mocks.find((m) => m.pattern === 'vi.fn' && m.span.startLine === 17)!;
    expect(first.id).not.toBe(second.id);
    expect(first.invocationSites.map((s) => s.startLine)).toEqual([12]);
    expect(second.invocationSites.map((s) => s.startLine)).toEqual([18]);
  });

  it('marks an inline vi.fn().mockResolvedValue() inside an object literal as reachable', () => {
    const inline = handoff.mocks.find((m) => m.pattern === 'vi.fn' && m.span.startLine === 24);
    expect(inline?.invocationSites.map((s) => s.startLine)).toEqual([23]);
  });

  it('marks a mock embedded in an array literal as reachable', () => {
    const arr = handoff.mocks.find((m) => m.pattern === 'vi.fn' && m.span.startLine === 31);
    expect(arr?.invocationSites.map((s) => s.startLine)).toEqual([32]);
  });

  it('marks a spy reachable when its spied-on object is handed off (TAUT-006)', () => {
    const spy = handoff.mocks.find((m) => m.pattern === 'vi.spyOn');
    expect(spy?.stubbedMembers[0]?.name).toBe('removeEventListener');
    expect(spy?.invocationSites.map((s) => s.startLine)).toEqual([39]);
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
