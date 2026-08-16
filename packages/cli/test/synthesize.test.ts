import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { synthesizeForCli } from '../src/synthesize.ts';
import { RULES_CATALOG } from '../src/catalog.ts';

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'momus-synth-'));
  writeFileSync(
    join(dir, 'svc.ts'),
    [
      'export class Svc {',
      '  totalFor(id: string, opts?: number): number { return 0; }',
      '  get label(): string { return "x"; }',
      '  private hidden(): void {}',
      '}',
      'export class Other {',
      '  ping(): void {}',
      '}',
      '',
    ].join('\n'),
  );
  return dir;
}

describe('synthesizeForCli', () => {
  it('returns NOT_FOUND for a missing target', () => {
    const dir = fixture();
    try {
      const out = synthesizeForCli(dir, 'nope.ts', undefined, 'vitest');
      expect(out).toEqual({ error: expect.stringContaining('NOT_FOUND') });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns no-class for a target with no class declaration', () => {
    const dir = fixture();
    try {
      writeFileSync(join(dir, 'empty.ts'), 'export const x = 1;\n');
      const out = synthesizeForCli(dir, 'empty.ts', undefined, 'vitest');
      expect(out).toEqual({ error: expect.stringContaining('no class or interface found') });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders vitest mocks for the first class by default', () => {
    const dir = fixture();
    try {
      const out = synthesizeForCli(dir, 'svc.ts', undefined, 'vitest');
      expect(out).toHaveProperty('template');
      const template = (out as { template: string }).template;
      expect(template).toContain('const svcMock = {');
      expect(template).toContain('totalFor: vi.fn<[id: string, opts?: number], number>().mockReturnValue(0),');
      expect(template).toContain("get label() { return ''; },");
      expect(template).toContain('} satisfies Partial<Svc>;');
      // private members are not surfaced as stubbable surface
      expect(template).not.toContain('hidden');
      expect(template).not.toContain('Other');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders jest mocks and selects a named symbol', () => {
    const dir = fixture();
    try {
      const out = synthesizeForCli(dir, 'svc.ts', 'Other', 'jest');
      expect(out).toHaveProperty('template');
      const template = (out as { template: string }).template;
      expect(template).toContain('const otherMock = {');
      expect(template).toContain('ping: jest.fn<[], void>().mockReturnValue(undefined),');
      expect(template).toContain('} satisfies Partial<Other>;');
      expect(template).not.toContain('totalFor');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to plain arrow stubs for unknown frameworks', () => {
    const dir = fixture();
    try {
      const out = synthesizeForCli(dir, 'svc.ts', 'Other', 'mocha');
      expect(out).toHaveProperty('template');
      const template = (out as { template: string }).template;
      expect(template).toContain('ping: () => undefined,');
      expect(template).not.toContain('vi.fn');
      expect(template).not.toContain('jest.fn');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves typed parameters and optional markers in the comment', () => {
    const dir = fixture();
    try {
      const out = synthesizeForCli(dir, 'svc.ts', 'Svc', 'vitest');
      const template = (out as { template: string }).template;
      expect(template).toContain('// totalFor(id: string, opts?: number): number');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('derives type-appropriate placeholder return values from the return type', () => {
    const dir = mkdtempSync(join(tmpdir(), 'momus-synth-types-'));
    try {
      writeFileSync(
        join(dir, 'typed.ts'),
        [
          'export class Typed {',
          '  num(): number { return 0; }',
          "  str(): string { return ''; }",
          '  flag(): boolean { return false; }',
          '  list(): string[] { return []; }',
          '  maybe(): number | undefined { return undefined; }',
          '  late(): Promise<number> { return Promise.resolve(0); }',
          '  custom(): Widget { return {} as Widget; }',
          '  voidy(): void {}',
          '}',
          'export interface Widget { id: number }',
          '',
        ].join('\n'),
      );
      const out = synthesizeForCli(dir, 'typed.ts', undefined, 'vitest');
      const template = (out as { template: string }).template;
      expect(template).toContain('num: vi.fn<[], number>().mockReturnValue(0),');
      expect(template).toContain("str: vi.fn<[], string>().mockReturnValue(''),");
      expect(template).toContain('flag: vi.fn<[], boolean>().mockReturnValue(false),');
      expect(template).toContain('list: vi.fn<[], string[]>().mockReturnValue([]),');
      expect(template).toContain('maybe: vi.fn<[], number | undefined>().mockReturnValue(0),');
      expect(template).toContain('late: vi.fn<[], Promise<number>>().mockResolvedValue(0),');
      // named interfaces resolve through the checker → data-shape literal
      expect(template).toContain('custom: vi.fn<[], Widget>().mockReturnValue({ id: 0 }),');
      expect(template).toContain('voidy: vi.fn<[], void>().mockReturnValue(undefined),');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits typed vi.fn<[...]> generics and object-shape return values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'momus-synth-shape-'));
    try {
      writeFileSync(
        join(dir, 'shape.ts'),
        [
          'export class Shape {',
          '  build(label: string, n?: number): { ok: boolean; count: number } {',
          '    return { ok: true, count: n ?? 0 };',
          '  }',
          '  pair(): [string, number] { return ["x", 1]; }',
          '}',
          '',
        ].join('\n'),
      );
      const out = synthesizeForCli(dir, 'shape.ts', undefined, 'vitest');
      const template = (out as { template: string }).template;
      expect(template).toContain(
        'build: vi.fn<[label: string, n?: number], { ok: boolean; count: number }>().mockReturnValue({ ok: false, count: 0 }),',
      );
      expect(template).toContain('pair: vi.fn<[], [string, number]>().mockReturnValue([]),');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves named interface returns through the checker, incl. Promise<named> and nested members', () => {
    const dir = mkdtempSync(join(tmpdir(), 'momus-synth-named-'));
    try {
      writeFileSync(
        join(dir, 'named.ts'),
        [
          'export interface Address { city: string; zip?: number }',
          'export interface User { id: number; name: string; address: Address; active: boolean }',
          'export interface Session { token: string; close(): void; refresh(): Promise<string> }',
          'export class Named {',
          '  find(): Promise<User> { return Promise.resolve({} as User); }',
          '  home(): Address { return {} as Address; }',
          '  onlyMethods(): { run(): void } { return { run() {} }; }',
          '  session(): Session { return {} as Session; }',
          '}',
          '',
        ].join('\n'),
      );
      const out = synthesizeForCli(dir, 'named.ts', undefined, 'vitest');
      const template = (out as { template: string }).template;
      // Promise<named interface> unwraps to a nested data-shape literal
      expect(template).toContain(
        "find: vi.fn<[], Promise<User>>().mockResolvedValue({ id: 0, name: '', address: { city: '', zip: 0 }, active: false }),",
      );
      // named interface (non-Promise) resolves to a data-shape literal too
      expect(template).toContain("home: vi.fn<[], Address>().mockReturnValue({ city: '', zip: 0 }),");
      // an inline type with only methods → vi.fn stubs (not an empty shape)
      expect(template).toContain('onlyMethods: vi.fn<[], { run(): void }>().mockReturnValue({ run: vi.fn() }),');
      // a named interface with methods → data properties as values, methods as vi.fn stubs
      expect(template).toContain(
        "session: vi.fn<[], Session>().mockReturnValue({ token: '', close: vi.fn(), refresh: vi.fn() }),",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves string-literal union aliases (and inline literals) to real members, not { length }', () => {
    const dir = mkdtempSync(join(tmpdir(), 'momus-synth-union-'));
    try {
      writeFileSync(
        join(dir, 'union.ts'),
        [
          "export type Language = 'typescript' | 'php';",
          "export type Severity = 'error' | 'warning' | 'info';",
          'export class Union {',
          '  lang(): Language { return "typescript"; }',
          '  sev(): Severity { return "error"; }',
          '  both(): { lang: Language; sev: Severity } { return { lang: "typescript", sev: "error" }; }',
          '}',
          '',
        ].join('\n'),
      );
      const out = synthesizeForCli(dir, 'union.ts', undefined, 'vitest');
      const template = (out as { template: string }).template;
      // regression: a string-literal union must not leak the intrinsic String `{ length }` shape
      expect(template).not.toContain('length');
      expect(template).toContain('lang: vi.fn<[], Language>().mockReturnValue("typescript"),');
      expect(template).toContain('sev: vi.fn<[], Severity>().mockReturnValue("error"),');
      // inline object literals recurse through the checker too
      expect(template).toContain(
        'both: vi.fn<[], { lang: Language; sev: Severity }>().mockReturnValue({ lang: "typescript", sev: "error" }),',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('concretizes method- and class-level generics to unknown (no out-of-scope type params)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'momus-synth-generic-'));
    try {
      writeFileSync(
        join(dir, 'gen.ts'),
        [
          'export class Box<T> {',
          '  identity<U>(x: U): U { return x; }',
          '  get(): T { throw new Error(); }',
          '  put(v: T): void {}',
          '}',
          '',
        ].join('\n'),
      );
      const out = synthesizeForCli(dir, 'gen.ts', undefined, 'vitest');
      const template = (out as { template: string }).template;
      expect(template).toContain('identity: vi.fn<[x: unknown], unknown>().mockReturnValue(undefined),');
      expect(template).toContain('get: vi.fn<[], unknown>().mockReturnValue(undefined),');
      expect(template).toContain('put: vi.fn<[v: unknown], void>().mockReturnValue(undefined),');
      expect(template).toContain('} satisfies Partial<Box<unknown>>;');
      // the raw generic name must not leak into the mock as an undefined type
      expect(template).not.toMatch(/vi\.fn<[^>]*\bT\b/);
      expect(template).not.toMatch(/vi\.fn<[^>]*\bU\b/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('synthesizes interfaces as data values + method stubs (no class required)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'momus-synth-iface-'));
    try {
      writeFileSync(
        join(dir, 'iface.ts'),
        ['export interface Widget { id: number; label?: string; render(opts: string): void }', ''].join('\n'),
      );
      const out = synthesizeForCli(dir, 'iface.ts', undefined, 'vitest');
      const template = (out as { template: string }).template;
      expect(template).toContain('const widgetMock = {');
      expect(template).toContain('  id: 0,');
      expect(template).toContain("  label: '',");
      expect(template).toContain('render: vi.fn<[opts: string], void>().mockReturnValue(undefined),');
      expect(template).toContain('} satisfies Partial<Widget>;');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('infers unannotated parameter types from default initializers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'momus-synth-param-'));
    try {
      writeFileSync(
        join(dir, 'param.ts'),
        [
          'export class P {',
          '  configure(name: string, timeoutMs = 1000, label = "x", flag = false, items: string[] = [], env: NodeJS.ProcessEnv = {}): void {}',
          '  raw(x: number) {}',
          '}',
          '',
        ].join('\n'),
      );
      const out = synthesizeForCli(dir, 'param.ts', undefined, 'vitest');
      const template = (out as { template: string }).template;
      expect(template).toContain(
        'configure: vi.fn<[name: string, timeoutMs: number, label: string, flag: boolean, items: string[], env: NodeJS.ProcessEnv], void>().mockReturnValue(undefined),',
      );
      // comment reflects the inferred types too
      expect(template).toContain(
        '// configure(name: string, timeoutMs: number, label: string, flag: boolean, items: string[], env: NodeJS.ProcessEnv): void',
      );
      // an annotated param keeps its declared type; unannotated return stays unknown
      expect(template).toContain('raw: vi.fn<[x: number], unknown>().mockReturnValue(undefined),');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('synthesizes a phpunit template for a PHP class (not a TS stub)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'momus-synth-php-'));
    try {
      writeFileSync(
        join(dir, 'svc.php'),
        [
          '<?php',
          'namespace App;',
          'class Svc {',
          '  public function totalFor(string $id): int { return 0; }',
          '  public function ping(): void {}',
          '}',
          '',
        ].join('\n'),
      );
      const out = synthesizeForCli(dir, 'svc.php', undefined, 'phpunit');
      const template = (out as { template: string }).template;
      expect(template).toContain('$mock = $this->createMock(Svc::class);');
      expect(template).toContain("$mock->method('totalFor')->willReturn(0);");
      expect(template).toContain("$mock->method('ping')->willReturn(null);");
      expect(template).not.toContain('satisfies Partial');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('RULES_CATALOG', () => {
  it('declares unique rule ids with valid severities', () => {
    const ids = RULES_CATALOG.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of RULES_CATALOG) {
      expect(['error', 'warning', 'info']).toContain(r.severity);
      expect(r.name).toBeTruthy();
      expect(r.description).toBeTruthy();
    }
  });

  it('includes the documented rule set', () => {
    const ids = new Set(RULES_CATALOG.map((r) => r.id));
    for (const id of [
      'TAUT-001',
      'TAUT-002',
      'TAUT-003',
      'TAUT-004',
      'TAUT-005',
      'TAUT-006',
      'DRIFT-001',
      'DRIFT-002',
      'DRIFT-003',
      'DRIFT-005',
      'MOCK-001',
      'MOCK-002',
    ]) {
      expect(ids.has(id), `missing ${id}`).toBe(true);
    }
  });
});
