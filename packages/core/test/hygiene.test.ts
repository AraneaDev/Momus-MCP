import { describe, expect, it } from 'vitest';
import { hygieneRules, testSubject } from '../src/rules/hygiene.ts';
import { runRules } from '../src/rules/engine.ts';
import { SymbolIndex } from '../src/symbolIndex.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { AssertionIR, ExprIR, MockIR, ModuleIR, SourceSpan } from '../src/ir.ts';

const FILE = '/ws/tests/ledger.test.ts';
const PROD = '/ws/src/ledger.ts';
const sp = (file: string, sl: number, sc = 1, el = sl, ec = 2): SourceSpan => ({
  file,
  startLine: sl,
  startCol: sc,
  endLine: el,
  endCol: ec,
});

function testModule(over: Partial<ModuleIR> = {}): ModuleIR {
  return {
    path: FILE,
    language: 'typescript',
    kind: 'test',
    framework: 'vitest',
    imports: [{ specifier: '../src/ledger', names: ['LedgerService'] }],
    symbols: [],
    exports: [],
    mocks: [],
    assertions: [],
    functions: [],
    comments: [],
    diagnostics: [],
    hash: 'x',
    ...over,
  };
}

function prodModule(over: Partial<ModuleIR> = {}): ModuleIR {
  return testModule({ path: PROD, language: 'typescript', kind: 'production', imports: [], ...over });
}

const expr = (over: Partial<ExprIR> = {}): ExprIR => ({
  kind: 'call',
  text: 'x',
  mockRefs: [],
  provenance: 'unknown',
  constant: false,
  ...over,
});

const assertion = (over: Partial<AssertionIR> = {}): AssertionIR => ({
  id: 'a1',
  span: sp(FILE, 10),
  api: 'toBe',
  operands: [],
  fnId: 'f1',
  ...over,
});

const mock = (over: Partial<MockIR> = {}): MockIR => ({
  id: 'm1',
  span: sp(FILE, 5),
  framework: 'vitest',
  pattern: 'vi.fn',
  stubbedMembers: [],
  configuredValues: [],
  invocationSites: [],
  isAutomock: false,
  ...over,
});

const ctx = (module: ModuleIR, config = DEFAULT_CONFIG) => ({ module, index: new SymbolIndex([]), config });
const mock001 = hygieneRules.filter((r) => r.id === 'MOCK-001');
const mock002 = hygieneRules.filter((r) => r.id === 'MOCK-002');

/** 3 deps, 3 distinct module mocks → ratio 1.0. */
function saturated(): ModuleIR {
  return testModule({
    imports: [
      { specifier: '../src/a', names: ['A'] },
      { specifier: '../src/b', names: ['B'] },
      { specifier: '../src/c', names: ['C'] },
    ],
    mocks: ['a', 'b', 'c'].map((n, i) =>
      mock({
        id: n,
        target: { kind: 'module', modulePath: `/ws/src/${n}.ts`, span: sp(FILE, i + 1) },
      }),
    ),
    assertions: [assertion({ operands: [expr({ provenance: 'mock-call' })] })],
  });
}

describe('hygiene rule metadata + appliesTo gate', () => {
  it('appliesTo gates on test modules only', () => {
    for (const rule of hygieneRules) {
      expect(rule.appliesTo(testModule())).toBe(true);
      expect(rule.appliesTo(prodModule())).toBe(false);
    }
  });

  it('exposes stable ids, names, severities, descriptions', () => {
    const m1 = hygieneRules.find((r) => r.id === 'MOCK-001')!;
    expect(m1.name).toBe('mock-saturation');
    expect(m1.defaultSeverity).toBe('warning');
    expect(m1.description).toContain('over-mocking');
    const m2 = hygieneRules.find((r) => r.id === 'MOCK-002')!;
    expect(m2.name).toBe('mock-of-self');
    expect(m2.defaultSeverity).toBe('info');
    expect(m2.description).toContain('mocks a module');
  });
});

describe('MOCK-001 issue shape', () => {
  it('emits a stable id, workspace span, empty fix code and descriptive fix', () => {
    const issue = runRules(mock001, ctx(saturated()))[0]!;
    expect(issue.id).toContain('MOCK-001');
    expect(issue.id).toContain(FILE);
    expect(issue.span.file).toBe(FILE);
    expect(issue.span.startLine).toBe(1);
    expect(issue.fix?.kind).toBe('replace');
    expect(issue.fix?.code).toBe('');
    expect(issue.fix?.description).toContain('replace a mock');
  });

  it('reports the deduped dependency count in the message', () => {
    const issue = runRules(mock001, ctx(saturated()))[0]!;
    expect(issue.message).toContain('3/3 dependencies mocked');
  });

  it('truncates long messages and ids (stable, bounded)', () => {
    const longSpec = 'x'.repeat(40);
    const m = testModule({
      mocks: [
        mock({ id: 'self', target: { kind: 'module', modulePath: PROD, specifier: longSpec, span: sp(FILE, 5) } }),
      ],
    });
    const issue = runRules(mock002, ctx(m))[0]!;
    expect(issue.message.length).toBeLessThanOrEqual(80);
    expect(issue.id).toContain('MOCK-002');
    expect(issue.id).toContain(FILE);
    // id embeds only a 24-char slice of the message, so it stays bounded (a missing slice
    // would push it past 100 with the full 89-char message).
    expect(issue.id.length).toBeLessThan(100);
  });
});

describe('MOCK-001 saturation logic', () => {
  it('excludes framework specifiers from the dependency count', () => {
    const m = testModule({
      imports: [
        { specifier: 'vitest', names: [] },
        { specifier: '@vitest/coverage-v8', names: [] },
        { specifier: '@jest/globals', names: [] },
        { specifier: 'jest', names: [] },
        { specifier: '../src/a', names: ['A'] },
      ],
      mocks: [mock({ id: 'a', target: { kind: 'module', modulePath: '/ws/src/a.ts', span: sp(FILE, 1) } })],
      assertions: [assertion({ operands: [expr({ provenance: 'mock-call' })] })],
    });
    const issues = runRules(mock001, ctx(m));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('1/1 dependencies mocked');
  });

  // each row: [specifier(s), expected issue count] — pins the FRAMEWORK_SPECIFIERS regex
  // boundaries (^/$ anchors and the @scope/.* form) so a lookalike counts as a dependency.
  it.each([
    [['my-vitest', '../src/a'], 0], // 'my-vitest' must NOT be filtered (no ^ anchor leak)
    [['vitestx', '../src/a'], 0], // 'vitestx' must NOT be filtered (no $ anchor leak)
    [['@vitest/coverage-v8', '../src/a'], 1], // @scope/.* must be filtered (full subpath)
    [['@jest/globals', '../src/a'], 1], // @scope/.* must be filtered (full subpath)
  ])('framework-specifier boundary %j', (specifiers, expected) => {
    const m = testModule({
      imports: specifiers.map((s) => ({ specifier: s, names: [] })),
      mocks: [mock({ id: 'a', target: { kind: 'module', modulePath: '/ws/src/a.ts', span: sp(FILE, 1) } })],
      assertions: [assertion({ operands: [expr({ provenance: 'mock-call' })] })],
    });
    // 2 real deps, 1 mocked → 0.5 ratio stays quiet; 1 real dep, 1 mocked → fires.
    expect(runRules(mock001, ctx(m))).toHaveLength(expected);
  });

  it('stays quiet when there are mocks but zero imported dependencies', () => {
    const m = testModule({
      imports: [],
      mocks: [mock({ id: 'a', target: { kind: 'module', modulePath: '/ws/src/a.ts', span: sp(FILE, 1) } })],
      assertions: [assertion({ operands: [expr({ provenance: 'mock-call' })] })],
    });
    expect(runRules(mock001, ctx(m))).toHaveLength(0);
  });

  it('ignores mocks without a target (no crash, not counted)', () => {
    const m = testModule({
      imports: [{ specifier: '../src/a', names: ['A'] }],
      mocks: [mock({ id: 'targetless' })],
      assertions: [assertion({ operands: [expr({ provenance: 'mock-call' })] })],
    });
    expect(runRules(mock001, ctx(m))).toHaveLength(0);
  });

  it('fires at the exact ratio threshold (custom threshold)', () => {
    const m = testModule({
      imports: [
        { specifier: '../src/a', names: ['A'] },
        { specifier: '../src/b', names: ['B'] },
      ],
      mocks: [mock({ id: 'a', target: { kind: 'module', modulePath: '/ws/src/a.ts', span: sp(FILE, 1) } })],
      assertions: [assertion({ operands: [expr({ provenance: 'mock-call' })] })],
    });
    const cfg = { ...DEFAULT_CONFIG, mockSaturationThreshold: 0.5 };
    expect(runRules(mock001, ctx(m, cfg))).toHaveLength(1); // 0.5 >= 0.5
  });

  it('stays quiet when the ratio is low even with few production assertions', () => {
    const m = testModule({
      imports: [
        { specifier: '../src/a', names: ['A'] },
        { specifier: '../src/b', names: ['B'] },
      ],
      mocks: [mock({ id: 'a', target: { kind: 'module', modulePath: '/ws/src/a.ts', span: sp(FILE, 1) } })],
      assertions: [assertion({ operands: [expr({ provenance: 'production' })] })],
    });
    expect(runRules(mock001, ctx(m))).toHaveLength(0); // 0.5 < 0.7
  });

  it('stays quiet at ratio 1 when two production-provenance assertions exist', () => {
    const m = testModule({
      ...saturated(),
      assertions: [
        assertion({ operands: [expr({ provenance: 'production' }), expr({ provenance: 'production' })] }),
        assertion({ operands: [expr({ provenance: 'production' }), expr({ provenance: 'production' })] }),
      ],
    });
    expect(runRules(mock001, ctx(m))).toHaveLength(0);
  });

  it('stays quiet at ratio 1 when mixed-operand assertions count as production', () => {
    const m = testModule({
      ...saturated(),
      assertions: [
        assertion({ operands: [expr({ provenance: 'production' }), expr({ provenance: 'mock-call' })] }),
        assertion({ operands: [expr({ provenance: 'production' }), expr({ provenance: 'mock-call' })] }),
      ],
    });
    expect(runRules(mock001, ctx(m))).toHaveLength(0); // some() with a production operand counts
  });

  it('fires at ratio 1 when the only assertions are mock-only', () => {
    const m = testModule({
      ...saturated(),
      assertions: [
        assertion({ operands: [expr({ provenance: 'mock-call' }), expr({ provenance: 'mock-call' })] }),
        assertion({ operands: [expr({ provenance: 'mock-call' })] }),
      ],
    });
    expect(runRules(mock001, ctx(m))).toHaveLength(1);
  });
});

describe('MOCK-002 mock-of-self', () => {
  it('flags a test that mocks the module it imports as its own subject', () => {
    const m = testModule({
      mocks: [
        mock({ id: 'self', target: { kind: 'module', modulePath: PROD, specifier: '../ledger', span: sp(FILE, 5) } }),
      ],
    });
    const issues = runRules(mock002, ctx(m));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("'../ledger'");
  });

  it('stays quiet for a non-module target even when the path matches the subject', () => {
    const m = testModule({
      mocks: [
        mock({ id: 'x', target: { kind: 'class', modulePath: PROD, specifier: '../ledger', span: sp(FILE, 5) } }),
      ],
    });
    expect(runRules(mock002, ctx(m))).toHaveLength(0);
  });

  it('ignores mocks without a target (no crash)', () => {
    const m = testModule({ mocks: [mock({ id: 'targetless' })] });
    expect(runRules(mock002, ctx(m))).toHaveLength(0);
  });

  it('does not treat a .ts.extra target as the subject (extension must be terminal)', () => {
    const m = testModule({
      mocks: [
        mock({
          id: 'x',
          target: { kind: 'module', modulePath: '/ws/src/ledger.ts.extra', specifier: '../ledger', span: sp(FILE, 5) },
        }),
      ],
    });
    expect(runRules(mock002, ctx(m))).toHaveLength(0);
  });

  it('strips the full terminal extension (tsx), not a prefix (kills the $ anchor removal)', () => {
    const m = testModule({
      mocks: [
        mock({
          id: 'x',
          target: { kind: 'module', modulePath: '/ws/src/ledger.tsx', specifier: '../ledger', span: sp(FILE, 5) },
        }),
      ],
    });
    // real: targetBase 'ledger' == subject 'ledger' → fires; a $-less strip would leave
    // 'ledgerx' (strips the .ts prefix) and stay quiet.
    expect(runRules(mock002, ctx(m))).toHaveLength(1);
  });

  it('recognizes a test file whose subject module ends in .mts', () => {
    const m = testModule({
      path: '/ws/tests/ledger.test.mts',
      mocks: [
        mock({ id: 'self', target: { kind: 'module', modulePath: PROD, specifier: '../ledger', span: sp(FILE, 5) } }),
      ],
    });
    expect(runRules(mock002, ctx(m))).toHaveLength(1);
  });

  it('does not bind a test file name with a trailing suffix past the extension', () => {
    const m = testModule({
      path: '/ws/tests/ledger.test.ts.extra',
      mocks: [
        mock({ id: 'self', target: { kind: 'module', modulePath: PROD, specifier: '../ledger', span: sp(FILE, 5) } }),
      ],
    });
    expect(runRules(mock002, ctx(m))).toHaveLength(0);
  });

  it('derives the subject per language', () => {
    expect(testSubject({ language: 'python', path: '/ws/tests/test_ledger.py' } as ModuleIR)).toBe('ledger');
    expect(testSubject({ language: 'python', path: '/ws/tests/ledger_test.py' } as ModuleIR)).toBe('ledger');
    expect(testSubject({ language: 'php', path: '/ws/tests/LedgerTest.php' } as ModuleIR)).toBe('Ledger');
  });

  it('flags a Python test that patches its own subject class', () => {
    const m = testModule({
      path: '/ws/tests/test_ledger.py',
      language: 'python',
      mocks: [mock({ id: 'self', target: { kind: 'class', exportName: 'Ledger', span: sp(FILE, 5) } })],
    });
    expect(runRules(mock002, ctx(m))).toHaveLength(1);
  });

  it('flags a Rust test module that mocks a struct declared in the same file', () => {
    const m = testModule({
      path: '/ws/src/foo.rs',
      language: 'rust',
      symbols: [
        {
          id: '/ws/src/foo.rs#Foo',
          name: 'Foo',
          kind: 'class',
          span: sp('/ws/src/foo.rs', 1),
          members: [],
          extendsIds: [],
          implementsIds: [],
        },
      ],
      mocks: [mock({ id: 'self', target: { kind: 'class', exportName: 'Foo', span: sp('/ws/src/foo.rs', 30) } })],
    });
    expect(runRules(mock002, ctx(m))).toHaveLength(1);
  });
});
