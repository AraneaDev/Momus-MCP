import { describe, expect, it } from 'vitest';
import { tautologyRules } from '../src/rules/tautology.ts';
import { driftRules } from '../src/rules/drift.ts';
import { hygieneRules } from '../src/rules/hygiene.ts';
import { runRules } from '../src/rules/engine.ts';
import { SymbolIndex } from '../src/symbolIndex.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { AssertionIR, ExprIR, MockIR, ModuleIR, SignatureIR, SourceSpan } from '../src/ir.ts';

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

function ctx(module: ModuleIR, index = new SymbolIndex([])) {
  return { module, index, config: DEFAULT_CONFIG };
}

const rulesOf = (id: string) => [...tautologyRules, ...driftRules, ...hygieneRules].filter((r) => r.id === id);

describe('TAUT-001 self-comparison', () => {
  it('flags identical operands', () => {
    const m = testModule({ assertions: [assertion({ operands: [expr({ text: 'a.b()' }), expr({ text: 'a.b()' })] })] });
    const issues = runRules(rulesOf('TAUT-001'), ctx(m));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.rule).toBe('TAUT-001');
    // semantic tautology: no safe mechanical rewrite → descriptive-only suggestion
    expect(issues[0]!.fix?.code).toBe('');
    expect(issues[0]!.fix?.description).toBeTruthy();
  });
  it('ignores different operands', () => {
    const m = testModule({ assertions: [assertion({ operands: [expr({ text: 'a.b()' }), expr({ text: 'c.d()' })] })] });
    expect(runRules(rulesOf('TAUT-001'), ctx(m))).toHaveLength(0);
  });
});

describe('TAUT-002 mock echo', () => {
  it('flags literal matching a configured mock value', () => {
    const m = testModule({
      assertions: [
        assertion({
          operands: [
            expr({ text: 'mocked.getTotal()', provenance: 'mock-config', configuredValue: '42' }),
            expr({ text: '42', provenance: 'literal', constant: true }),
          ],
        }),
      ],
    });
    const issues = runRules(rulesOf('TAUT-002'), ctx(m));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('42');
    expect(issues[0]!.fix?.code).toBe('');
    expect(issues[0]!.fix?.description).toBeTruthy();
  });
  it('ignores production-derived assertions', () => {
    const m = testModule({
      assertions: [
        assertion({
          operands: [
            expr({ text: 'invoice.totalCents', provenance: 'production' }),
            expr({ text: '4200', provenance: 'literal', constant: true }),
          ],
        }),
      ],
    });
    expect(runRules(rulesOf('TAUT-002'), ctx(m))).toHaveLength(0);
  });
});

describe('TAUT-003 constant tautology', () => {
  it('flags two literal operands', () => {
    const m = testModule({
      assertions: [
        assertion({
          api: 'toEqual',
          operands: [
            expr({ text: '1', provenance: 'literal', constant: true }),
            expr({ text: '1', provenance: 'literal', constant: true }),
          ],
        }),
      ],
    });
    const issues = runRules(rulesOf('TAUT-003'), ctx(m));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.fix?.code).toBe('');
    expect(issues[0]!.fix?.description).toBeTruthy();
  });
  it('allowlists null/truthiness assertions', () => {
    const m = testModule({
      assertions: [
        assertion({
          api: 'toBeNull',
          operands: [expr({ text: 'x', provenance: 'production' })],
        }),
      ],
    });
    expect(runRules(rulesOf('TAUT-003'), ctx(m))).toHaveLength(0);
  });
});

describe('TAUT-004 mock-only assertion', () => {
  it('flags mock-only assertion in a test with no production calls', () => {
    const m = testModule({
      functions: [
        { id: 'f1', span: sp(FILE, 1), hasProductionCalls: false, productionCallCount: 0, assertionCount: 1 },
      ],
      assertions: [
        assertion({
          fnId: 'f1',
          operands: [expr({ text: 'mocked.getTotal()', provenance: 'mock-call', mockRefs: ['m1'] })],
        }),
      ],
    });
    expect(runRules(rulesOf('TAUT-004'), ctx(m))).toHaveLength(1);
  });
  it('stays quiet when the test exercises production', () => {
    const m = testModule({
      functions: [{ id: 'f1', span: sp(FILE, 1), hasProductionCalls: true, productionCallCount: 1, assertionCount: 1 }],
      assertions: [
        assertion({
          fnId: 'f1',
          operands: [expr({ text: 'mocked.getTotal()', provenance: 'mock-call', mockRefs: ['m1'] })],
        }),
      ],
    });
    expect(runRules(rulesOf('TAUT-004'), ctx(m))).toHaveLength(0);
  });
});

describe('TAUT-005 zero-reach stub', () => {
  it('flags configured mocks that are never invoked or asserted', () => {
    const m = testModule({
      mocks: [
        mock({
          id: 'm1',
          configuredValues: [{ span: sp(FILE, 5), api: 'mockReturnValue', once: false, assignable: 'unknown' }],
        }),
      ],
    });
    expect(runRules(rulesOf('TAUT-005'), ctx(m))).toHaveLength(1);
  });
  it('ignores invoked or asserted mocks', () => {
    const invoked = testModule({
      mocks: [
        mock({
          id: 'm1',
          configuredValues: [{ span: sp(FILE, 5), api: 'mockReturnValue', once: false, assignable: 'unknown' }],
          invocationSites: [sp(FILE, 9)],
        }),
      ],
    });
    const asserted = testModule({
      mocks: [
        mock({
          id: 'm1',
          configuredValues: [{ span: sp(FILE, 5), api: 'mockReturnValue', once: false, assignable: 'unknown' }],
        }),
      ],
      assertions: [assertion({ operands: [expr({ mockRefs: ['m1'] })] })],
    });
    expect(runRules(rulesOf('TAUT-005'), ctx(invoked))).toHaveLength(0);
    expect(runRules(rulesOf('TAUT-005'), ctx(asserted))).toHaveLength(0);
  });
});

describe('TAUT-006 unconfigured spy assert', () => {
  it('flags toHaveBeenCalled on an unconfigured, unreached spy', () => {
    const m = testModule({
      mocks: [
        mock({
          id: 's1',
          pattern: 'vi.spyOn',
          stubbedMembers: [{ name: 'm', span: sp(FILE, 5), api: 'spyOn', returnValues: [] }],
        }),
      ],
      assertions: [
        assertion({ api: 'toHaveBeenCalled', operands: [expr({ mockRefs: ['s1'], provenance: 'mock-call' })] }),
      ],
    });
    expect(runRules(rulesOf('TAUT-006'), ctx(m))).toHaveLength(1);
  });
  it('stays quiet for configured or reached spies', () => {
    const configured = testModule({
      mocks: [
        mock({
          id: 's1',
          pattern: 'vi.spyOn',
          configuredValues: [{ span: sp(FILE, 5), api: 'mockReturnValue', once: false, assignable: 'unknown' }],
        }),
      ],
      assertions: [assertion({ api: 'toHaveBeenCalled', operands: [expr({ mockRefs: ['s1'] })] })],
    });
    const reached = testModule({
      mocks: [mock({ id: 's1', pattern: 'vi.spyOn', invocationSites: [sp(FILE, 8)] })],
      assertions: [assertion({ api: 'toHaveBeenCalled', operands: [expr({ mockRefs: ['s1'] })] })],
    });
    expect(runRules(rulesOf('TAUT-006'), ctx(configured))).toHaveLength(0);
    expect(runRules(rulesOf('TAUT-006'), ctx(reached))).toHaveLength(0);
  });
});

describe('DRIFT-001 missing member', () => {
  const prod: ModuleIR = {
    path: PROD,
    language: 'typescript',
    kind: 'production',
    imports: [],
    symbols: [
      {
        id: `${PROD}#LedgerService`,
        name: 'LedgerService',
        kind: 'class',
        span: sp(PROD, 1),
        members: [
          { id: `${PROD}#LedgerService.totalFor`, name: 'totalFor', kind: 'method', span: sp(PROD, 3), members: [] },
        ],
        extendsIds: [],
        implementsIds: [],
      },
    ],
    exports: ['LedgerService'],
    mocks: [],
    assertions: [],
    functions: [],
    comments: [],
    diagnostics: [],
    hash: 'y',
  };
  const index = new SymbolIndex([prod]);

  it('flags stubs for members missing from the production class', () => {
    const m = testModule({
      mocks: [
        mock({
          id: 'm1',
          pattern: 'vi.spyOn',
          target: {
            kind: 'instance-member',
            symbolId: `${PROD}#LedgerService`,
            memberName: 'totalForX',
            span: sp(FILE, 5),
          },
          stubbedMembers: [{ name: 'totalForX', span: sp(FILE, 5), api: 'spyOn', returnValues: [] }],
        }),
      ],
    });
    const issues = runRules(rulesOf('DRIFT-001'), ctx(m, index));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('totalForX');
  });
  it('accepts existing members', () => {
    const m = testModule({
      mocks: [
        mock({
          id: 'm1',
          pattern: 'vi.spyOn',
          target: {
            kind: 'instance-member',
            symbolId: `${PROD}#LedgerService`,
            memberName: 'totalFor',
            span: sp(FILE, 5),
          },
          stubbedMembers: [{ name: 'totalFor', span: sp(FILE, 5), api: 'spyOn', returnValues: [] }],
        }),
      ],
    });
    expect(runRules(rulesOf('DRIFT-001'), ctx(m, index))).toHaveLength(0);
  });
  it('emits a rename fix only for an unambiguous near-match', () => {
    const m = testModule({
      mocks: [
        mock({
          id: 'm1',
          pattern: 'vi.spyOn',
          target: {
            kind: 'instance-member',
            symbolId: `${PROD}#LedgerService`,
            memberName: 'totalForX',
            span: sp(FILE, 5),
          },
          stubbedMembers: [{ name: 'totalForX', span: sp(FILE, 5), api: 'spyOn', returnValues: [] }],
        }),
      ],
    });
    const issues = runRules(rulesOf('DRIFT-001'), ctx(m, index));
    expect(issues[0]!.fix).toMatchObject({ kind: 'replace', code: "'totalFor'" });
    expect(issues[0]!.fix?.span).toBeTruthy();
    // no near-match → no fix suggestion
    const ambiguous = testModule({
      mocks: [
        mock({
          id: 'm2',
          pattern: 'vi.spyOn',
          target: {
            kind: 'instance-member',
            symbolId: `${PROD}#LedgerService`,
            memberName: 'fetchAll',
            span: sp(FILE, 6),
          },
          stubbedMembers: [{ name: 'fetchAll', span: sp(FILE, 6), api: 'spyOn', returnValues: [] }],
        }),
      ],
    });
    expect(runRules(rulesOf('DRIFT-001'), ctx(ambiguous, index))[0]!.fix).toBeUndefined();
  });
});

describe('DRIFT-002 signature mismatch', () => {
  const prodPath = '/ws/src/typed.ts';
  const classId = `${prodPath}#TypedService`;
  const signature = (type: 'string' | 'number'): SignatureIR => ({
    parameters: [
      {
        name: 'value',
        type: { kind: 'named', name: type, typeArgs: [] },
        optional: false,
        variadic: false,
        hasDefault: false,
      },
    ],
    typeParams: [],
  });
  const prod: ModuleIR = {
    path: prodPath,
    language: 'typescript',
    kind: 'production',
    imports: [],
    exports: ['TypedService'],
    symbols: [
      {
        id: classId,
        name: 'TypedService',
        kind: 'class',
        span: sp(prodPath, 1),
        members: [
          {
            id: `${classId}.run`,
            name: 'run',
            kind: 'method',
            span: sp(prodPath, 2),
            members: [],
            extendsIds: [],
            implementsIds: [],
            signature: signature('string'),
          },
        ],
        extendsIds: [],
        implementsIds: [],
      },
    ],
    mocks: [],
    assertions: [],
    functions: [],
    comments: [],
    diagnostics: [],
    hash: 'typed',
  };
  const index = new SymbolIndex([prod]);

  const withStubType = (type: 'string' | 'number') =>
    testModule({
      mocks: [
        mock({
          id: 'typed-mock',
          target: { kind: 'class', symbolId: classId, span: sp(FILE, 5) },
          stubbedMembers: [
            { name: 'run', span: sp(FILE, 5), api: 'objectLiteralKey', signature: signature(type), returnValues: [] },
          ],
        }),
      ],
    });

  it('flags a typed stub parameter that cannot accept the production parameter', () => {
    const issues = runRules(rulesOf('DRIFT-002'), ctx(withStubType('number'), index));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('parameter 1');
  });

  it('keeps matching and untyped parameter stubs quiet', () => {
    expect(runRules(rulesOf('DRIFT-002'), ctx(withStubType('string'), index))).toHaveLength(0);
    const untyped = withStubType('number');
    untyped.mocks[0]!.stubbedMembers[0]!.signature!.parameters[0]!.type = undefined;
    expect(runRules(rulesOf('DRIFT-002'), ctx(untyped, index))).toHaveLength(0);
  });
});

describe('DRIFT-005 missing export', () => {
  const prod: ModuleIR = {
    path: PROD,
    language: 'typescript',
    kind: 'production',
    imports: [],
    symbols: [
      {
        id: `${PROD}#Db`,
        name: 'Db',
        kind: 'class',
        span: sp(PROD, 1),
        members: [],
        extendsIds: [],
        implementsIds: [],
      },
    ],
    exports: ['Db'],
    mocks: [],
    assertions: [],
    functions: [],
    comments: [],
    diagnostics: [],
    hash: 'y',
  };
  const index = new SymbolIndex([prod]);

  it('flags factory keys not exported by the target module', () => {
    const m = testModule({
      mocks: [
        mock({
          id: 'm1',
          pattern: 'vi.mock',
          target: { kind: 'module', modulePath: PROD, specifier: '../src/ledger', span: sp(FILE, 5) },
          stubbedMembers: [{ name: 'NotExported', span: sp(FILE, 5), api: 'mockFactoryKey', returnValues: [] }],
        }),
      ],
    });
    const issues = runRules(rulesOf('DRIFT-005'), ctx(m, index));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('NotExported');
  });
  it('accepts exported keys', () => {
    const m = testModule({
      mocks: [
        mock({
          id: 'm1',
          pattern: 'vi.mock',
          target: { kind: 'module', modulePath: PROD, specifier: '../src/ledger', span: sp(FILE, 5) },
          stubbedMembers: [{ name: 'Db', span: sp(FILE, 5), api: 'mockFactoryKey', returnValues: [] }],
        }),
      ],
    });
    expect(runRules(rulesOf('DRIFT-005'), ctx(m, index))).toHaveLength(0);
  });
  it('skips modules that were never indexed (node_modules)', () => {
    const m = testModule({
      mocks: [
        mock({
          id: 'm1',
          pattern: 'vi.mock',
          target: { kind: 'module', modulePath: '/ws/node_modules/pkg/index.js', specifier: 'pkg', span: sp(FILE, 5) },
          stubbedMembers: [{ name: 'Anything', span: sp(FILE, 5), api: 'mockFactoryKey', returnValues: [] }],
        }),
      ],
    });
    expect(runRules(rulesOf('DRIFT-005'), ctx(m, index))).toHaveLength(0);
  });
});

describe('MOCK-001 saturation', () => {
  it('flags high mock ratio with no production assertions', () => {
    const m = testModule({
      imports: [
        { specifier: '../src/a', names: ['A'] },
        { specifier: '../src/b', names: ['B'] },
        { specifier: '../src/c', names: ['C'] },
      ],
      mocks: [
        mock({ id: 'a', target: { kind: 'module', modulePath: '/ws/src/a.ts', span: sp(FILE, 1) } }),
        mock({ id: 'b', target: { kind: 'module', modulePath: '/ws/src/b.ts', span: sp(FILE, 1) } }),
        mock({ id: 'c', target: { kind: 'module', modulePath: '/ws/src/c.ts', span: sp(FILE, 1) } }),
      ],
      assertions: [assertion({ operands: [expr({ provenance: 'mock-call' })] })],
    });
    const issues = runRules(rulesOf('MOCK-001'), ctx(m));
    expect(issues).toHaveLength(1);
  });
  it('stays quiet when production is exercised', () => {
    const m = testModule({
      imports: [
        { specifier: '../src/a', names: ['A'] },
        { specifier: '../src/b', names: ['B'] },
      ],
      mocks: [mock({ id: 'a', target: { kind: 'module', modulePath: '/ws/src/a.ts', span: sp(FILE, 1) } })],
      assertions: [
        assertion({ operands: [expr({ provenance: 'production' })] }),
        assertion({ operands: [expr({ provenance: 'production' })] }),
      ],
    });
    expect(runRules(rulesOf('MOCK-001'), ctx(m))).toHaveLength(0);
  });
});

describe('rule engine', () => {
  it('respects severity off', () => {
    const m = testModule({
      assertions: [
        assertion({
          operands: [expr({ text: 'a.b()' }), expr({ text: 'a.b()' })],
        }),
      ],
    });
    const cfg = { ...DEFAULT_CONFIG, rules: { 'TAUT-001': { severity: 'off' } } };
    expect(runRules(rulesOf('TAUT-001'), { module: m, index: new SymbolIndex([]), config: cfg })).toHaveLength(0);
  });
  it('wraps rule crashes as internal errors without aborting', () => {
    const boom: { id: 'TAUT-001' } = {
      id: 'TAUT-001',
    };
    const m = testModule();
    const cfg = { ...DEFAULT_CONFIG };
    void boom;
    // craft a rule that throws
    const badRule = {
      id: 'TAUT-001' as const,
      name: 'bad',
      defaultSeverity: 'error' as const,
      description: '',
      appliesTo: () => true,
      check: () => {
        throw new Error('boom');
      },
    };
    const issues = runRules([badRule], { module: m, index: new SymbolIndex([]), config: cfg });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('internal error');
  });
});
