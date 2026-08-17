import { describe, expect, it } from 'vitest';
import { tautologyRules } from '../src/rules/tautology.ts';
import { runRules } from '../src/rules/engine.ts';
import { SymbolIndex } from '../src/symbolIndex.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { AssertionIR, ExprIR, MockIR, ModuleIR, SourceSpan } from '../src/ir.ts';

const FILE = '/ws/tests/ledger.test.ts';
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
    imports: [],
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
  return testModule({ path: '/ws/src/ledger.ts', language: 'typescript', kind: 'production', ...over });
}

const expr = (over: Partial<ExprIR> = {}): ExprIR => ({
  kind: 'identifier',
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

const ctx = (module: ModuleIR) => ({ module, index: new SymbolIndex([]), config: DEFAULT_CONFIG });
const rulesOf = (id: string) => tautologyRules.filter((r) => r.id === id);

const LIT = (text: string): ExprIR => ({ kind: 'literal', text, provenance: 'literal', constant: true, mockRefs: [] });

describe('rule metadata + appliesTo gate', () => {
  it('exposes stable ids, names, severities, descriptions and the test-module gate', () => {
    const expected: Array<[string, string, string, string]> = [
      ['TAUT-001', 'self-comparison', 'error', 'compares an expression with itself'],
      ['TAUT-002', 'mock-echo', 'error', "re-asserts a stub's own configured return"],
      ['TAUT-003', 'constant-tautology', 'error', 'compile-time constants'],
      ['TAUT-004', 'mock-only-assertion', 'warning', 'never touches production'],
      ['TAUT-005', 'zero-reach-stub', 'warning', 'never invoked or asserted'],
      ['TAUT-006', 'unconfigured-spy-assert', 'warning', 'no stub and no call path'],
    ];
    for (const [id, name, sev, desc] of expected) {
      const rule = tautologyRules.find((r) => r.id === id)!;
      expect(rule.name).toBe(name);
      expect(rule.defaultSeverity).toBe(sev);
      expect(rule.description).toContain(desc);
      expect(rule.appliesTo(testModule())).toBe(true);
      expect(rule.appliesTo(prodModule())).toBe(false);
    }
  });
});

describe('TAUT-001 issue shape', () => {
  it('reports a descriptive message and stable id', () => {
    const m = testModule({
      assertions: [
        assertion({
          operands: [expr({ text: 'total', kind: 'identifier' }), expr({ text: 'total', kind: 'identifier' })],
        }),
      ],
    });
    const issue = runRules(rulesOf('TAUT-001'), ctx(m))[0]!;
    expect(issue.message).toContain('self-comparison');
    expect(issue.id).toContain('TAUT-001');
    expect(issue.id).toContain(FILE);
    expect(issue.fix?.kind).toBe('replace');
    expect(issue.fix?.code).toBe('');
  });
});

describe('TAUT-002 mock-echo predicate edges', () => {
  it('does not echo when the configured side is mock-call, not mock-config', () => {
    const m = testModule({
      assertions: [
        assertion({
          operands: [expr({ text: 'mocked.getTotal()', provenance: 'mock-call', configuredValue: '42' }), LIT('42')],
        }),
      ],
    });
    expect(runRules(rulesOf('TAUT-002'), ctx(m))).toHaveLength(0);
  });

  it('does not echo when the other operand is not a literal', () => {
    const m = testModule({
      assertions: [
        assertion({
          operands: [
            expr({ text: 'mocked.getTotal()', provenance: 'mock-config', configuredValue: '42' }),
            expr({ text: '42', provenance: 'production' }),
          ],
        }),
      ],
    });
    expect(runRules(rulesOf('TAUT-002'), ctx(m))).toHaveLength(0);
  });

  it('does not echo when the literal does not match the configured value', () => {
    const m = testModule({
      assertions: [
        assertion({
          operands: [expr({ text: 'mocked.getTotal()', provenance: 'mock-config', configuredValue: '42' }), LIT('43')],
        }),
      ],
    });
    expect(runRules(rulesOf('TAUT-002'), ctx(m))).toHaveLength(0);
  });

  it('does not echo when the right side is mock-call, not mock-config', () => {
    const m = testModule({
      assertions: [
        assertion({
          operands: [LIT('42'), expr({ text: 'mocked.getTotal()', provenance: 'mock-call', configuredValue: '42' })],
        }),
      ],
    });
    expect(runRules(rulesOf('TAUT-002'), ctx(m))).toHaveLength(0);
  });

  it('does not echo when the left operand is not a literal', () => {
    const m = testModule({
      assertions: [
        assertion({
          operands: [
            expr({ text: '42', provenance: 'production' }),
            expr({ text: 'mocked.getTotal()', provenance: 'mock-config', configuredValue: '42' }),
          ],
        }),
      ],
    });
    expect(runRules(rulesOf('TAUT-002'), ctx(m))).toHaveLength(0);
  });

  it('does not echo when the left literal does not match the configured value', () => {
    const m = testModule({
      assertions: [
        assertion({
          operands: [LIT('43'), expr({ text: 'mocked.getTotal()', provenance: 'mock-config', configuredValue: '42' })],
        }),
      ],
    });
    expect(runRules(rulesOf('TAUT-002'), ctx(m))).toHaveLength(0);
  });

  it('stays quiet for a single-operand assertion (no crash)', () => {
    const m = testModule({
      assertions: [
        assertion({
          operands: [expr({ text: 'mocked.getTotal()', provenance: 'mock-config', configuredValue: '42' })],
        }),
      ],
    });
    const issues = runRules(rulesOf('TAUT-002'), ctx(m));
    expect(issues).toHaveLength(0);
    expect(issues[0]).toBeUndefined();
  });

  it('echoes a right-side configured value into the message', () => {
    const m = testModule({
      assertions: [
        assertion({
          operands: [LIT('42'), expr({ text: 'mocked.getTotal()', provenance: 'mock-config', configuredValue: '42' })],
        }),
      ],
    });
    const issue = runRules(rulesOf('TAUT-002'), ctx(m))[0]!;
    expect(issue.message).toContain('(42)');
  });

  it('truncates long messages and ids (stable, bounded)', () => {
    const longVal = 'x'.repeat(60);
    const m = testModule({
      assertions: [
        assertion({
          operands: [
            expr({ text: 'mocked.getTotal()', provenance: 'mock-config', configuredValue: longVal }),
            LIT(longVal),
          ],
        }),
      ],
    });
    const issue = runRules(rulesOf('TAUT-002'), ctx(m))[0]!;
    expect(issue.message.length).toBeLessThanOrEqual(80);
    expect(issue.id).toContain('TAUT-002');
    expect(issue.id.length).toBeLessThan(100);
  });
});

describe('TAUT-003 constant-tautology edges', () => {
  const ALLOWED = [
    'toBeNull',
    'toBeUndefined',
    'toBeTruthy',
    'toBeFalsy',
    'toBeInstanceOf',
    'toHaveLength',
    'assertNull',
    'assertNotNull',
    'assertInstanceOf',
    'assertCount',
    'assertEmpty',
    'assertNotEmpty',
  ];

  it.each(ALLOWED)('%s is allowlisted even with two literal operands', (api) => {
    const m = testModule({
      assertions: [assertion({ api, operands: [LIT('1'), LIT('1')] })],
    });
    expect(runRules(rulesOf('TAUT-003'), ctx(m))).toHaveLength(0);
  });

  it('stays quiet for a single-operand assertion (no crash)', () => {
    const m = testModule({
      assertions: [assertion({ api: 'toBe', operands: [LIT('1')] })],
    });
    expect(runRules(rulesOf('TAUT-003'), ctx(m))).toHaveLength(0);
  });

  it('requires both operands to be literals (production on either side)', () => {
    const m = testModule({
      assertions: [
        assertion({
          operands: [
            expr({ text: '1', provenance: 'literal', constant: true }),
            expr({ text: '1', provenance: 'production', constant: true }),
          ],
        }),
        assertion({
          operands: [
            expr({ text: '1', provenance: 'production', constant: true }),
            expr({ text: '1', provenance: 'literal', constant: true }),
          ],
        }),
      ],
    });
    expect(runRules(rulesOf('TAUT-003'), ctx(m))).toHaveLength(0);
  });

  it('requires both operands to be constant', () => {
    const m = testModule({
      assertions: [
        assertion({
          operands: [expr({ text: '1', provenance: 'literal', constant: false }), LIT('1')],
        }),
      ],
    });
    expect(runRules(rulesOf('TAUT-003'), ctx(m))).toHaveLength(0);
  });

  it('reports a descriptive message for a real constant tautology', () => {
    const m = testModule({
      assertions: [assertion({ api: 'toBe', operands: [LIT('1'), LIT('1')] })],
    });
    const issue = runRules(rulesOf('TAUT-003'), ctx(m))[0]!;
    expect(issue.message).toContain('constant-tautology');
    expect(issue.id).toContain('TAUT-003');
  });
});

describe('TAUT-004 mock-only-assertion edges', () => {
  it('treats an assertion with no enclosing function as having no production calls (no crash)', () => {
    const m = testModule({
      assertions: [assertion({ fnId: 'missing', operands: [expr({ provenance: 'mock-call' })] })],
    });
    const issues = runRules(rulesOf('TAUT-004'), ctx(m));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).not.toContain('internal error'); // kills the fn?. optional-chaining removal
  });

  it('stays quiet for an assertion with no operands', () => {
    const m = testModule({ assertions: [assertion({ operands: [] })] });
    expect(runRules(rulesOf('TAUT-004'), ctx(m))).toHaveLength(0);
  });

  it('flags mock-config operands as mock-only too', () => {
    const m = testModule({
      functions: [
        { id: 'f1', span: sp(FILE, 1), hasProductionCalls: false, productionCallCount: 0, assertionCount: 1 },
      ],
      assertions: [
        assertion({
          fnId: 'f1',
          operands: [
            expr({ text: 'mocked.getTotal()', provenance: 'mock-config', configuredValue: '42' }),
            expr({ text: 'mocked.run()', provenance: 'mock-call', mockRefs: ['m1'] }),
          ],
        }),
      ],
    });
    const issues = runRules(rulesOf('TAUT-004'), ctx(m));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('mock-only-assertion');
    expect(issues[0]!.id).toContain('TAUT-004');
    expect(issues[0]!.fix?.code).toBe('');
    expect(issues[0]!.fix?.description).toContain('exercise the real SUT');
  });
});

describe('TAUT-005 zero-reach-stub edges', () => {
  it('stays quiet for a mock with no config and no stubbed return values', () => {
    const m = testModule({ mocks: [mock({ id: 'bare' })] });
    expect(runRules(rulesOf('TAUT-005'), ctx(m))).toHaveLength(0);
  });

  it('stays quiet for a mock whose stubbed members are all unconfigured (empty return values)', () => {
    const m = testModule({
      mocks: [
        mock({
          id: 'm1',
          configuredValues: [],
          stubbedMembers: [{ name: 'run', span: sp(FILE, 5), api: 'objectLiteralKey', returnValues: [] }],
        }),
      ],
    });
    expect(runRules(rulesOf('TAUT-005'), ctx(m))).toHaveLength(0);
  });

  it('flags a mock whose only config lives in a stubbed member', () => {
    const m = testModule({
      mocks: [
        mock({
          id: 'm1',
          configuredValues: [],
          stubbedMembers: [
            {
              name: 'run',
              span: sp(FILE, 5),
              api: 'objectLiteralKey',
              returnValues: [{ span: sp(FILE, 5), api: 'mockReturnValue', once: false, assignable: 'unknown' }],
            },
          ],
        }),
      ],
    });
    expect(runRules(rulesOf('TAUT-005'), ctx(m))).toHaveLength(1);
  });

  it('flags a mock with one configured and one empty stubbed member', () => {
    const m = testModule({
      mocks: [
        mock({
          id: 'm1',
          configuredValues: [],
          stubbedMembers: [
            { name: 'a', span: sp(FILE, 5), api: 'objectLiteralKey', returnValues: [] },
            {
              name: 'b',
              span: sp(FILE, 5),
              api: 'objectLiteralKey',
              returnValues: [{ span: sp(FILE, 5), api: 'mockReturnValue', once: false, assignable: 'unknown' }],
            },
          ],
        }),
      ],
    });
    expect(runRules(rulesOf('TAUT-005'), ctx(m))).toHaveLength(1);
  });

  it('reports a descriptive message', () => {
    const m = testModule({
      mocks: [
        mock({
          id: 'm1',
          configuredValues: [{ span: sp(FILE, 5), api: 'mockReturnValue', once: false, assignable: 'unknown' }],
        }),
      ],
    });
    const issue = runRules(rulesOf('TAUT-005'), ctx(m))[0]!;
    expect(issue.message).toContain('zero-reach');
    expect(issue.id).toContain('TAUT-005');
  });

  it('stays quiet for a zero-reach mock inside a #[should_panic] test (drop-panic is the assertion)', () => {
    const m = testModule({
      functions: [
        {
          id: 'f1',
          span: sp(FILE, 1),
          hasProductionCalls: false,
          productionCallCount: 0,
          assertionCount: 0,
          shouldPanic: true,
        },
      ],
      mocks: [
        mock({
          id: 'm1',
          fnId: 'f1',
          stubbedMembers: [
            {
              name: 'foo',
              span: sp(FILE, 5),
              api: 'unknown',
              returnValues: [{ span: sp(FILE, 5), api: 'returning', once: false, assignable: 'unknown' }],
            },
          ],
        }),
      ],
    });
    expect(runRules(rulesOf('TAUT-005'), ctx(m))).toHaveLength(0);
  });

  it('still flags a configured mock whose enclosing test fn is not should_panic', () => {
    const m = testModule({
      functions: [
        { id: 'f1', span: sp(FILE, 1), hasProductionCalls: false, productionCallCount: 0, assertionCount: 0 },
      ],
      mocks: [
        mock({
          id: 'm1',
          fnId: 'f1',
          stubbedMembers: [
            {
              name: 'foo',
              span: sp(FILE, 5),
              api: 'unknown',
              returnValues: [{ span: sp(FILE, 5), api: 'returning', once: false, assignable: 'unknown' }],
            },
          ],
        }),
      ],
    });
    expect(runRules(rulesOf('TAUT-005'), ctx(m))).toHaveLength(1);
  });
});

describe('TAUT-006 unconfigured-spy-assert edges', () => {
  it('stays quiet for a non-toHaveBeenCalled api even when it refs a spy', () => {
    const m = testModule({
      mocks: [mock({ id: 's1', pattern: 'vi.spyOn' })],
      assertions: [assertion({ api: 'toBeCalled', operands: [expr({ mockRefs: ['s1'] })] })],
    });
    expect(runRules(rulesOf('TAUT-006'), ctx(m))).toHaveLength(0);
  });

  it('flags toHaveBeenCalledTimes on an unconfigured, unreached spy', () => {
    const m = testModule({
      mocks: [mock({ id: 's1', pattern: 'vi.spyOn' })],
      assertions: [assertion({ api: 'toHaveBeenCalledTimes', operands: [expr({ mockRefs: ['s1'] })] })],
    });
    expect(runRules(rulesOf('TAUT-006'), ctx(m))).toHaveLength(1);
  });

  it('does not crash for an assertion with no operands', () => {
    const m = testModule({ assertions: [assertion({ api: 'toHaveBeenCalled', operands: [] })] });
    expect(runRules(rulesOf('TAUT-006'), ctx(m))).toHaveLength(0);
  });

  it('stays quiet when the asserted mockRef does not exist (no crash)', () => {
    const m = testModule({
      assertions: [assertion({ api: 'toHaveBeenCalled', operands: [expr({ mockRefs: ['ghost'] })] })],
    });
    const issues = runRules(rulesOf('TAUT-006'), ctx(m));
    expect(issues).toHaveLength(0);
    expect(issues[0]).toBeUndefined();
  });

  it('stays quiet for a non-spy mock (vi.fn) even when asserted', () => {
    const m = testModule({
      mocks: [mock({ id: 'f1', pattern: 'vi.fn' })],
      assertions: [assertion({ api: 'toHaveBeenCalled', operands: [expr({ mockRefs: ['f1'] })] })],
    });
    expect(runRules(rulesOf('TAUT-006'), ctx(m))).toHaveLength(0);
  });

  it('flags a jest.spyOn spy like a vi.spyOn', () => {
    const m = testModule({
      mocks: [mock({ id: 's1', pattern: 'jest.spyOn' })],
      assertions: [assertion({ api: 'toHaveBeenCalled', operands: [expr({ mockRefs: ['s1'] })] })],
    });
    expect(runRules(rulesOf('TAUT-006'), ctx(m))).toHaveLength(1);
  });

  it('stays quiet for a spy configured through a stubbed member with a return value', () => {
    const m = testModule({
      mocks: [
        mock({
          id: 's1',
          pattern: 'vi.spyOn',
          stubbedMembers: [
            { name: 'run', span: sp(FILE, 5), api: 'spyOn', returnValues: [] },
            {
              name: 'run',
              span: sp(FILE, 5),
              api: 'spyOn',
              returnValues: [{ span: sp(FILE, 5), api: 'mockReturnValue', once: false, assignable: 'unknown' }],
            },
          ],
        }),
      ],
      assertions: [assertion({ api: 'toHaveBeenCalled', operands: [expr({ mockRefs: ['s1'] })] })],
    });
    expect(runRules(rulesOf('TAUT-006'), ctx(m))).toHaveLength(0);
  });

  it('reports a descriptive message and fix', () => {
    const m = testModule({
      mocks: [mock({ id: 's1', pattern: 'vi.spyOn' })],
      assertions: [assertion({ api: 'toHaveBeenCalled', operands: [expr({ mockRefs: ['s1'] })] })],
    });
    const issue = runRules(rulesOf('TAUT-006'), ctx(m))[0]!;
    expect(issue.message).toContain('unconfigured-spy');
    expect(issue.id).toContain('TAUT-006');
    expect(issue.fix?.kind).toBe('replace');
    expect(issue.fix?.code).toBe('');
    expect(issue.fix?.description).toContain('stub the spy');
  });
});
