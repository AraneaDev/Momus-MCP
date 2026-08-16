import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { TypeScriptParser } from '../src/index.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const parser = new TypeScriptParser();

function parseTestFile() {
  const p = join(FIXTURES, 'tests', 'ledger.test.ts');
  return parser.parseModule(p, readFileSync(p, 'utf8'), {
    config: undefined,
    resolveImport: (spec) => parser.resolveImport(spec, p),
  });
}

describe('assertion extraction', () => {
  const test = parseTestFile();

  it('extracts matcher calls with operands', () => {
    const tBe = test.assertions.find((a) => a.api === 'toBe');
    expect(tBe).toBeDefined();
    expect(tBe!.operands.map((o) => o.text)).toEqual(['mocked.getTotal()', '42']);
  });

  it('marks the echo operand as mock-config with the configured value', () => {
    const tBe = test.assertions.find((a) => a.api === 'toBe')!;
    expect(tBe.operands[0]!.provenance).toBe('mock-config');
    expect(tBe.operands[0]!.configuredValue).toBe('42');
    expect(tBe.operands[1]!.provenance).toBe('literal');
  });

  it('marks production flows as production', () => {
    const healthy = test.assertions.find((a) => a.operands.some((o) => o.text === 'invoice.totalCents'))!;
    expect(healthy.operands[0]!.provenance).toBe('production');
  });

  it('links assertions to their enclosing test function', () => {
    const fnIds = new Set(test.assertions.map((a) => a.fnId).filter(Boolean));
    expect(fnIds.size).toBeGreaterThanOrEqual(3);
  });
});

describe('mutability tracking (regression: let/var are never constant-provable)', () => {
  it('treats a mutated let counter as unknown, not constant', () => {
    const src = [
      "import { expect, it } from 'vitest';",
      'it("counter", () => {',
      '  let orphans = 0;',
      '  orphans++;',
      '  expect(orphans).toBe(0);',
      '});',
      '',
    ].join('\n');
    const p = join(FIXTURES, 'tests', 'scratch.test.ts');
    const mod = parser.parseModule(p, src, { config: undefined, resolveImport: () => null });
    const a = mod.assertions.find((x) => x.api === 'toBe')!;
    expect(a.operands[0]!.provenance).toBe('unknown');
    expect(a.operands[0]!.constant).toBe(false);
  });

  it('keeps const bindings constant-provable', () => {
    const src = [
      "import { expect, it } from 'vitest';",
      'it("const", () => {',
      '  const orphans = 0;',
      '  expect(orphans).toBe(0);',
      '});',
      '',
    ].join('\n');
    const p = join(FIXTURES, 'tests', 'scratch.test.ts');
    const mod = parser.parseModule(p, src, { config: undefined, resolveImport: () => null });
    const a = mod.assertions.find((x) => x.api === 'toBe')!;
    expect(a.operands[0]!.provenance).toBe('literal');
    expect(a.operands[0]!.constant).toBe(true);
  });
});

describe('beforeEach/beforeAll setup scopes', () => {
  it('carries setup mock configurations into each test function scope', () => {
    const p = join(FIXTURES, 'tests', 'before-each.test.ts');
    const mod = parser.parseModule(p, readFileSync(p, 'utf8'), {
      config: undefined,
      resolveImport: (spec) => parser.resolveImport(spec, p),
    });
    const echoes = mod.assertions.filter((a) => a.api === 'toBe');
    expect(echoes).toHaveLength(4);
    expect(echoes.map((a) => a.operands[0]!.provenance)).toEqual([
      'mock-config',
      'mock-config',
      'mock-config',
      'mock-config',
    ]);
    expect(echoes.map((a) => a.operands[0]!.configuredValue)).toEqual(['42', '7', '11', '22']);
  });

  it('keeps the healthy production-flow twin out of mock provenance', () => {
    const p = join(FIXTURES, 'tests', 'before-each.test.ts');
    const mod = parser.parseModule(p, readFileSync(p, 'utf8'), {
      config: undefined,
      resolveImport: (spec) => parser.resolveImport(spec, p),
    });
    const healthy = mod.assertions.find((a) => a.api === 'toBeDefined');
    expect(healthy?.operands[0]!.provenance).toBe('production');
    expect(healthy?.fnId).not.toBe('');
  });
});

describe('assigned mock implementations', () => {
  it('lets a test-body configuration override setup configuration', () => {
    const src = [
      "import { beforeEach, expect, it, vi } from 'vitest';",
      'const fn = vi.fn();',
      'beforeEach(() => { fn.mockReturnValue(42); });',
      'it("override", () => {',
      '  fn.mockReturnValue(99);',
      '  expect(fn()).toBe(99);',
      '});',
      '',
    ].join('\\n');
    const p = join(FIXTURES, 'tests', 'setup-override.test.ts');
    const mod = parser.parseModule(p, src, { config: undefined, resolveImport: () => null });
    const assertion = mod.assertions.find((a) => a.api === 'toBe')!;
    expect(assertion.operands[0]!.configuredValue).toBe('99');
  });

  it('tracks a constant returned by mockImplementation as mock configuration', () => {
    const src = [
      "import { expect, it, vi } from 'vitest';",
      'it("implementation", () => {',
      '  const fn = vi.fn();',
      '  fn.mockImplementation(() => 42);',
      '  expect(fn()).toBe(42);',
      '});',
      '',
    ].join('\\n');
    const p = join(FIXTURES, 'tests', 'mock-implementation.test.ts');
    const mod = parser.parseModule(p, src, { config: undefined, resolveImport: () => null });
    const assertion = mod.assertions.find((a) => a.api === 'toBe')!;
    expect(assertion.operands[0]!.provenance).toBe('mock-config');
    expect(assertion.operands[0]!.configuredValue).toBe('42');
  });
});

describe('test function statistics', () => {
  const test = parseTestFile();

  it('marks production-touching tests', () => {
    const healthy = test.functions.find((f) => f.productionCallCount > 0);
    expect(healthy?.hasProductionCalls).toBe(true);
    const mockOnly = test.functions.find((f) => f.productionCallCount === 0);
    expect(mockOnly?.hasProductionCalls).toBe(false);
  });

  it('counts assertions per function', () => {
    const total = test.functions.reduce((n, f) => n + f.assertionCount, 0);
    expect(total).toBe(test.assertions.length);
  });
});

describe('production-call detection (TAUT-004 false-positive guards)', () => {
  const scratch = join(FIXTURES, 'tests', 'scratch.test.ts');
  const parse = (src: string) => parser.parseModule(scratch, src, { config: undefined, resolveImport: () => null });

  it('counts a SUT instance assigned in beforeEach as production', () => {
    const src = [
      "import { it, expect, beforeEach } from 'vitest';",
      "import { PythonEngine } from '../engine';",
      'describe("engine", () => {',
      '  let engine: PythonEngine;',
      '  beforeEach(() => { engine = new PythonEngine(); });',
      '  it("runs", async () => {',
      "    await engine.run('m.py');",
      '    expect(engine).toBeTruthy();',
      '  });',
      '});',
      '',
    ].join('\n');
    const mod = parse(src);
    expect(mod.functions).toHaveLength(1);
    expect(mod.functions[0]!.hasProductionCalls).toBe(true);
  });

  it('traces a local helper function that wraps the SUT', () => {
    const src = [
      "import { it, expect } from 'vitest';",
      "import { runCli } from '../cli';",
      'function run(flags: string[]) { runCli({ flags }); }',
      'describe("cli", () => {',
      '  it("runs", () => {',
      "    const { exitCode } = run(['--version']);",
      '    expect(exitCode).toBe(0);',
      '  });',
      '});',
      '',
    ].join('\n');
    const mod = parse(src);
    expect(mod.functions).toHaveLength(1);
    expect(mod.functions[0]!.hasProductionCalls).toBe(true);
  });

  it('collects it.each parameterized tests as test functions', () => {
    const src = [
      "import { it, expect } from 'vitest';",
      "import { handleEstimateCall } from '../handler';",
      "it.each([1, 2])('handles %i', async (v) => {",
      '  const res = await handleEstimateCall({ timeoutMs: v });',
      '  expect(res).toBeTruthy();',
      '});',
      '',
    ].join('\n');
    const mod = parse(src);
    expect(mod.functions).toHaveLength(1);
    expect(mod.functions[0]!.hasProductionCalls).toBe(true);
    expect(mod.assertions[0]!.fnId).toBe(mod.functions[0]!.id);
  });

  it('counts a dynamic import() as production (re-import + signal-handler pattern)', () => {
    const src = [
      "import { it, expect, vi } from 'vitest';",
      'it("invokes the registered handler", async () => {',
      '  vi.resetModules();',
      '  const onSpy = vi.spyOn(process, "on");',
      "  await import('../utils/sandbox.js');",
      "  const sigCall = onSpy.mock.calls.find((c) => c[0] === 'SIGTERM');",
      '  (sigCall![1] as () => void)();',
      '  expect(onSpy).toHaveBeenCalled();',
      '});',
      '',
    ].join('\n');
    const mod = parse(src);
    expect(mod.functions).toHaveLength(1);
    expect(mod.functions[0]!.hasProductionCalls).toBe(true);
  });
});
