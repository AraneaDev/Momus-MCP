import { describe, expect, it } from 'vitest';
import { tautologyRules } from '../src/rules/tautology.ts';
import { driftRules } from '../src/rules/drift.ts';
import { hygieneRules } from '../src/rules/hygiene.ts';
import { runRules } from '../src/rules/engine.ts';
import { SymbolIndex } from '../src/symbolIndex.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type {
  AssertionIR,
  ConfiguredValueIR,
  ExprIR,
  MockIR,
  ModuleIR,
  SignatureIR,
  SourceSpan,
  SymbolIR,
  TypeIR,
} from '../src/ir.ts';

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

const prodMember = (name: string, returnType: TypeIR): SymbolIR => ({
  id: `prod#${name}`,
  name,
  kind: 'method',
  path: PROD,
  span: sp(PROD, 1),
  signature: { parameters: [], returnType, typeParams: [] },
  members: [],
  extendsIds: [],
  implementsIds: [],
});

const phpValue = (value: TypeIR): ConfiguredValueIR => ({
  span: sp(FILE, 5),
  api: 'willReturn',
  value,
  once: false,
  assignable: 'unknown',
});

function phpModule(mocks: MockIR[]): ModuleIR {
  return testModule({
    path: '/ws/tests/fooTest.php',
    language: 'php',
    kind: 'test',
    framework: 'phpunit',
    mocks,
  });
}

const phpMock = (name: string, stubbed: Array<{ name: string; returnType: TypeIR; values: TypeIR[] }>): MockIR =>
  mock({
    id: `m:${name}`,
    pattern: 'createMock',
    target: { kind: 'class', symbolId: 'prod#Svc', exportName: 'Svc', span: sp(PROD, 1) },
    stubbedMembers: stubbed.map((s) => ({
      name: s.name,
      span: sp(FILE, 5),
      api: 'shouldReceive' as const,
      returnValues: s.values.map(phpValue),
    })),
  });

describe('TAUT-001 self-comparison', () => {
  it('flags identical non-reevaluating operands', () => {
    const m = testModule({
      assertions: [
        assertion({
          operands: [expr({ text: 'total', kind: 'identifier' }), expr({ text: 'total', kind: 'identifier' })],
        }),
      ],
    });
    const issues = runRules(rulesOf('TAUT-001'), ctx(m));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.rule).toBe('TAUT-001');
    // semantic tautology: no safe mechanical rewrite → descriptive-only suggestion
    expect(issues[0]!.fix?.code).toBe('');
    expect(issues[0]!.fix?.description).toBeTruthy();
  });
  it('does not flag identical calls (determinism test — the callee re-evaluates)', () => {
    const m = testModule({
      assertions: [
        assertion({ operands: [expr({ text: 'f(x)', kind: 'call' }), expr({ text: 'f(x)', kind: 'call' })] }),
      ],
    });
    expect(runRules(rulesOf('TAUT-001'), ctx(m))).toHaveLength(0);
  });
  it('does not flag identical new expressions (fresh instances)', () => {
    const m = testModule({
      assertions: [
        assertion({ operands: [expr({ text: 'new Foo()', kind: 'new' }), expr({ text: 'new Foo()', kind: 'new' })] }),
      ],
    });
    expect(runRules(rulesOf('TAUT-001'), ctx(m))).toHaveLength(0);
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

describe('DRIFT-003 PHP return-type assignability', () => {
  const prodId = 'prod#Svc';
  const index = new SymbolIndex([
    {
      path: PROD,
      language: 'php',
      kind: 'production',
      imports: [],
      exports: ['Svc'],
      symbols: [
        {
          id: prodId,
          name: 'Svc',
          kind: 'class',
          span: sp(PROD, 1),
          members: [
            prodMember('count', { kind: 'named', name: 'int', typeArgs: [] }),
            prodMember('label', { kind: 'named', name: 'string', typeArgs: [] }),
            prodMember('active', { kind: 'named', name: 'bool', typeArgs: [] }),
            prodMember('go', { kind: 'void' }),
            prodMember('id', {
              kind: 'union',
              members: [
                { kind: 'named', name: 'int', typeArgs: [] },
                { kind: 'named', name: 'string', typeArgs: [] },
              ],
            }),
            prodMember('tags', { kind: 'array', element: { kind: 'named', name: 'string', typeArgs: [] } }),
            prodMember('owner', { kind: 'named', name: 'User', typeArgs: [] }),
          ],
          extendsIds: [],
          implementsIds: [],
        },
        prodMember('User', { kind: 'named', name: 'User', typeArgs: [] }),
      ],
      mocks: [],
      assertions: [],
      functions: [],
      comments: [],
      diagnostics: [],
      hash: 'prod',
    },
  ]);

  const fired = (values: Array<{ name: string; returnType: TypeIR; values: TypeIR[] }>) => {
    const m = phpModule([phpMock('svc', values)]);
    return runRules(rulesOf('DRIFT-003'), ctx(m, index));
  };

  it('accepts literals matching primitive production types and rejects mismatches', () => {
    expect(
      fired([
        {
          name: 'count',
          returnType: { kind: 'named', name: 'int', typeArgs: [] },
          values: [{ kind: 'literal', value: 42 }],
        },
      ]),
    ).toHaveLength(0);
    const stringOnInt = fired([
      {
        name: 'count',
        returnType: { kind: 'named', name: 'int', typeArgs: [] },
        values: [{ kind: 'literal', value: 'x' }],
      },
    ]);
    expect(stringOnInt).toHaveLength(1);
    expect(
      fired([
        {
          name: 'label',
          returnType: { kind: 'named', name: 'string', typeArgs: [] },
          values: [{ kind: 'literal', value: 'x' }],
        },
      ]),
    ).toHaveLength(0);
    expect(
      fired([
        {
          name: 'active',
          returnType: { kind: 'named', name: 'bool', typeArgs: [] },
          values: [{ kind: 'literal', value: true }],
        },
      ]),
    ).toHaveLength(0);
  });

  it('handles void, null, arrays, and unions structurally', () => {
    expect(fired([{ name: 'go', returnType: { kind: 'void' }, values: [{ kind: 'null' }] }])).toHaveLength(0);
    expect(fired([{ name: 'go', returnType: { kind: 'void' }, values: [{ kind: 'literal', value: 1 }] }])).toHaveLength(
      1,
    );
    expect(fired([{ name: 'tags', returnType: { kind: 'array' }, values: [{ kind: 'array' }] }])).toHaveLength(0);
    expect(
      fired([{ name: 'tags', returnType: { kind: 'array' }, values: [{ kind: 'literal', value: 1 }] }]),
    ).toHaveLength(1);
    // production union accepts either member
    expect(
      fired([
        {
          name: 'id',
          returnType: {
            kind: 'union',
            members: [
              { kind: 'named', name: 'int', typeArgs: [] },
              { kind: 'named', name: 'string', typeArgs: [] },
            ],
          },
          values: [{ kind: 'literal', value: 42 }],
        },
      ]),
    ).toHaveLength(0);
    // value union must satisfy every production member (null vs int fails)
    const nullish = fired([
      {
        name: 'count',
        returnType: { kind: 'named', name: 'int', typeArgs: [] },
        values: [{ kind: 'union', members: [{ kind: 'literal', value: 42 }, { kind: 'null' }] }],
      },
    ]);
    expect(nullish).toHaveLength(1);
  });

  it('resolves class-like production types by symbol identity, conservatively when unresolvable', () => {
    const idx = new SymbolIndex([
      {
        path: PROD,
        language: 'php',
        kind: 'production',
        imports: [],
        exports: ['Svc'],
        symbols: [
          {
            id: prodId,
            name: 'Svc',
            kind: 'class',
            span: sp(PROD, 1),
            members: [
              prodMember('owner', { kind: 'named', name: 'User', typeArgs: [] }),
              prodMember('any', { kind: 'named', name: 'mixed', typeArgs: [] }),
              prodMember('mayBeNull', { kind: 'named', name: 'null', typeArgs: [] }),
            ],
            extendsIds: [],
            implementsIds: [],
          },
          prodMember('User', { kind: 'named', name: 'User', typeArgs: [] }),
          prodMember('Admin', { kind: 'named', name: 'Admin', typeArgs: [] }),
        ],
        mocks: [],
        assertions: [],
        functions: [],
        comments: [],
        diagnostics: [],
        hash: 'prod',
      },
    ]);
    const run = (values: Array<{ name: string; returnType: TypeIR; values: TypeIR[] }>) =>
      runRules(rulesOf('DRIFT-003'), ctx(phpModule([phpMock('svc', values)]), idx));
    // identical names pass; mixed accepts anything; prod-null rejects non-null
    expect(
      run([
        {
          name: 'owner',
          returnType: { kind: 'named', name: 'User', typeArgs: [] },
          values: [{ kind: 'named', name: 'User', typeArgs: [] }],
        },
      ]),
    ).toHaveLength(0);
    expect(
      run([
        {
          name: 'any',
          returnType: { kind: 'named', name: 'mixed', typeArgs: [] },
          values: [{ kind: 'literal', value: 1 }],
        },
      ]),
    ).toHaveLength(0);
    expect(
      run([
        {
          name: 'mayBeNull',
          returnType: { kind: 'named', name: 'null', typeArgs: [] },
          values: [{ kind: 'literal', value: 1 }],
        },
      ]),
    ).toHaveLength(1);
    // a literal is never a class
    expect(
      run([
        {
          name: 'owner',
          returnType: { kind: 'named', name: 'User', typeArgs: [] },
          values: [{ kind: 'literal', value: 1 }],
        },
      ]),
    ).toHaveLength(1);
    // both sides resolvable but different symbols → mismatch
    expect(
      run([
        {
          name: 'owner',
          returnType: { kind: 'named', name: 'User', typeArgs: [] },
          values: [{ kind: 'named', name: 'Admin', typeArgs: [] }],
        },
      ]),
    ).toHaveLength(1);
    // unresolvable value name → conservative pass
    expect(
      run([
        {
          name: 'owner',
          returnType: { kind: 'named', name: 'User', typeArgs: [] },
          values: [{ kind: 'named', name: 'Ghost', typeArgs: [] }],
        },
      ]),
    ).toHaveLength(0);
  });
});

describe('DRIFT-002 parameter assignability tree', () => {
  const prodPath = '/ws/src/tree.ts';
  const classId = `${prodPath}#TreeService`;
  const paramSig = (param: TypeIR): SignatureIR => ({
    parameters: [{ name: 'value', type: param, optional: false, variadic: false, hasDefault: false }],
    typeParams: [],
  });
  const prod: ModuleIR = {
    path: prodPath,
    language: 'typescript',
    kind: 'production',
    imports: [],
    exports: ['TreeService'],
    symbols: [
      {
        id: classId,
        name: 'TreeService',
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
            signature: paramSig({
              kind: 'union',
              members: [
                { kind: 'named', name: 'string', typeArgs: [] },
                { kind: 'named', name: 'number', typeArgs: [] },
              ],
            }),
          },
          {
            id: `${classId}.each`,
            name: 'each',
            kind: 'method',
            span: sp(prodPath, 3),
            members: [],
            extendsIds: [],
            implementsIds: [],
            signature: paramSig({ kind: 'array', element: { kind: 'named', name: 'number', typeArgs: [] } }),
          },
          {
            id: `${classId}.pair`,
            name: 'pair',
            kind: 'method',
            span: sp(prodPath, 4),
            members: [],
            extendsIds: [],
            implementsIds: [],
            signature: paramSig({
              kind: 'tuple',
              elements: [
                { kind: 'named', name: 'string', typeArgs: [] },
                { kind: 'named', name: 'number', typeArgs: [] },
              ],
            }),
          },
          {
            id: `${classId}.boxed`,
            name: 'boxed',
            kind: 'method',
            span: sp(prodPath, 5),
            members: [],
            extendsIds: [],
            implementsIds: [],
            signature: paramSig({
              kind: 'named',
              name: 'Array',
              typeArgs: [{ kind: 'named', name: 'string', typeArgs: [] }],
            }),
          },
          {
            id: `${classId}.s`,
            name: 's',
            kind: 'method',
            span: sp(prodPath, 6),
            members: [],
            extendsIds: [],
            implementsIds: [],
            signature: paramSig({ kind: 'named', name: 'string', typeArgs: [] }),
          },
          {
            id: `${classId}.lit`,
            name: 'lit',
            kind: 'method',
            span: sp(prodPath, 7),
            members: [],
            extendsIds: [],
            implementsIds: [],
            signature: paramSig({ kind: 'literal', value: 'open' }),
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
    hash: 'tree',
  };
  const index = new SymbolIndex([prod]);
  const fired = (member: string, stubParam: TypeIR) => {
    const m = testModule({
      mocks: [
        mock({
          id: 'tree-mock',
          target: { kind: 'class', symbolId: classId, span: sp(FILE, 5) },
          stubbedMembers: [
            {
              name: member,
              span: sp(FILE, 5),
              api: 'objectLiteralKey',
              signature: paramSig(stubParam),
              returnValues: [],
            },
          ],
        }),
      ],
    });
    return runRules(rulesOf('DRIFT-002'), ctx(m, index));
  };

  it('union production params need every member assignable to the stub type', () => {
    // stub string|number accepts both members; stub string alone cannot accept number
    expect(
      fired('run', {
        kind: 'union',
        members: [
          { kind: 'named', name: 'string', typeArgs: [] },
          { kind: 'named', name: 'number', typeArgs: [] },
        ],
      }),
    ).toHaveLength(0);
    expect(fired('run', { kind: 'named', name: 'string', typeArgs: [] })).toHaveLength(1);
  });

  it('array and tuple params compare element-wise', () => {
    expect(fired('each', { kind: 'array', element: { kind: 'named', name: 'number', typeArgs: [] } })).toHaveLength(0);
    expect(fired('each', { kind: 'array', element: { kind: 'named', name: 'string', typeArgs: [] } })).toHaveLength(1);
    expect(
      fired('pair', {
        kind: 'tuple',
        elements: [
          { kind: 'named', name: 'string', typeArgs: [] },
          { kind: 'named', name: 'number', typeArgs: [] },
        ],
      }),
    ).toHaveLength(0);
    expect(fired('pair', { kind: 'tuple', elements: [{ kind: 'named', name: 'string', typeArgs: [] }] })).toHaveLength(
      1,
    );
  });

  it('named params compare name and type arguments', () => {
    expect(
      fired('boxed', { kind: 'named', name: 'Array', typeArgs: [{ kind: 'named', name: 'string', typeArgs: [] }] }),
    ).toHaveLength(0);
    expect(
      fired('boxed', { kind: 'named', name: 'Array', typeArgs: [{ kind: 'named', name: 'number', typeArgs: [] }] }),
    ).toHaveLength(1);
    // a literal production param is accepted by a named stub of the same primitive kind
    expect(fired('lit', { kind: 'named', name: 'string', typeArgs: [] })).toHaveLength(0);
    // an over-narrow literal stub cannot accept a string production param
    expect(fired('s', { kind: 'literal', value: 'x' })).toHaveLength(1);
    // a single-literal stub cannot accept a union production param
    expect(fired('run', { kind: 'literal', value: 'x' })).toHaveLength(1);
    // kind mismatch (number vs string) is not assignable
    expect(fired('run', { kind: 'named', name: 'number', typeArgs: [] })).toHaveLength(1);
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
  it('accepts const/type/enum export keys that are not class/function symbols', () => {
    const constOnly: ModuleIR = { ...prod, symbols: [], exports: ['TOOL_DEFINITION'] };
    const idx = new SymbolIndex([constOnly]);
    const m = testModule({
      mocks: [
        mock({
          id: 'm1',
          pattern: 'vi.mock',
          target: { kind: 'module', modulePath: PROD, specifier: '../core/tool-schema', span: sp(FILE, 5) },
          stubbedMembers: [{ name: 'TOOL_DEFINITION', span: sp(FILE, 5), api: 'mockFactoryKey', returnValues: [] }],
        }),
      ],
    });
    expect(runRules(rulesOf('DRIFT-005'), ctx(m, idx))).toHaveLength(0);
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

  it('stays quiet when there are no imported dependencies to saturate', () => {
    const m = testModule({ imports: [], mocks: [] });
    expect(runRules(rulesOf('MOCK-001'), ctx(m))).toHaveLength(0);
  });

  it('dedupes same-module mocks via symbolId when modulePath is absent', () => {
    const m = testModule({
      imports: [{ specifier: '../src/a', names: ['A'] }],
      mocks: [
        mock({ id: 'a1', target: { kind: 'module', symbolId: '/ws/src/a.ts#A', span: sp(FILE, 1) } }),
        mock({ id: 'a2', target: { kind: 'module', symbolId: '/ws/src/a.ts#A', span: sp(FILE, 2) } }),
      ],
      assertions: [assertion({ operands: [expr({ provenance: 'mock-call' })] })],
    });
    const issues = runRules(rulesOf('MOCK-001'), ctx(m));
    expect(issues).toHaveLength(1); // 1/1 mocked, not 2/1
    expect(issues[0]!.message).toContain('1/1 dependencies mocked');
  });
});

describe('MOCK-002 mock-of-self', () => {
  it('flags a test that mocks the module it imports as its own subject', () => {
    const m = testModule({
      mocks: [
        mock({ id: 'self', target: { kind: 'module', modulePath: PROD, specifier: '../ledger', span: sp(FILE, 5) } }),
      ],
    });
    const issues = runRules(rulesOf('MOCK-002'), ctx(m));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('mock-of-self');
  });

  it('stays quiet when the mocked module is not the subject', () => {
    const m = testModule({
      mocks: [mock({ id: 'other', target: { kind: 'module', modulePath: '/ws/src/other.ts', span: sp(FILE, 5) } })],
    });
    expect(runRules(rulesOf('MOCK-002'), ctx(m))).toHaveLength(0);
  });

  it('stays quiet when the test file name has no test/spec suffix', () => {
    const m = testModule({
      path: '/ws/tests/helpers.manual.ts',
      mocks: [mock({ id: 'x', target: { kind: 'module', modulePath: PROD, span: sp(FILE, 5) } })],
    });
    expect(runRules(rulesOf('MOCK-002'), ctx(m))).toHaveLength(0);
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
