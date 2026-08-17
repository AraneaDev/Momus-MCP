/** Tautological assertion rules (spec docs/03 §3.3.1). */
import type { Issue, ModuleIR, RuleId, Severity, AssertionIR, MockIR } from '../ir.ts';
import type { Rule, RuleContext } from './engine.ts';

const CONSTANT_API_ALLOWLIST = new Set([
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
]);

/** Operand kinds that re-execute on evaluation: a call or `new` can yield a fresh
 *  value each time, so `expect(f(x)).toBe(f(x))` is a legitimate determinism check, not
 *  a self-comparison tautology. */
const REEVALUATING_KINDS = new Set(['call', 'new']);

abstract class BaseRule implements Rule {
  abstract readonly id: RuleId;
  abstract readonly name: string;
  abstract readonly defaultSeverity: Severity;
  abstract readonly description: string;
  appliesTo(m: ModuleIR): boolean {
    return m.kind === 'test';
  }
  abstract check(ctx: RuleContext): Issue[];
}

const issue = (
  ctx: RuleContext,
  rule: RuleId,
  severity: Severity,
  a: AssertionIR | MockIR,
  message: string,
  fix?: { code: string; description: string },
): Issue => ({
  id: `${rule}:${a.span.file}:${a.span.startLine}:${a.span.startCol}:${message.slice(0, 24)}`,
  rule,
  severity,
  span: a.span,
  message: message.slice(0, 80),
  fix: fix ? { kind: 'replace', code: fix.code, description: fix.description.slice(0, 60) } : undefined,
  tokens: 0, // filled by formatter
});

export class Taut001SelfComparison extends BaseRule {
  readonly id = 'TAUT-001' as const;
  readonly name = 'self-comparison';
  readonly defaultSeverity = 'error' as const;
  readonly description = 'assertion compares an expression with itself';
  check({ module, config }: RuleContext): Issue[] {
    const out: Issue[] = [];
    for (const a of module.assertions) {
      const [l, r] = a.operands;
      if (l && r && l.text === r.text && !REEVALUATING_KINDS.has(l.kind) && !REEVALUATING_KINDS.has(r.kind)) {
        out.push(
          issue(
            { module, config } as RuleContext,
            this.id,
            this.defaultSeverity,
            a,
            `self-comparison: ${l.text} compared with itself`,
            { code: '', description: 'assert against a real business outcome' },
          ),
        );
      }
    }
    return out;
  }
}

export class Taut002MockEcho extends BaseRule {
  readonly id = 'TAUT-002' as const;
  readonly name = 'mock-echo';
  readonly defaultSeverity = 'error' as const;
  readonly description = "assertion re-asserts a stub's own configured return";
  check({ module, config }: RuleContext): Issue[] {
    const out: Issue[] = [];
    for (const a of module.assertions) {
      const [l, r] = a.operands;
      if (!l || !r) continue;
      const echo =
        (l.provenance === 'mock-config' &&
          l.configuredValue !== undefined &&
          r.provenance === 'literal' &&
          r.text === l.configuredValue) ||
        (r.provenance === 'mock-config' &&
          r.configuredValue !== undefined &&
          l.provenance === 'literal' &&
          l.text === r.configuredValue);
      if (echo) {
        const val = l.provenance === 'mock-config' ? l.configuredValue : r.configuredValue;
        out.push(
          issue(
            { module, config } as RuleContext,
            this.id,
            this.defaultSeverity,
            a,
            `mock-echo: asserts stubbed value (${val}) against itself`,
            { code: '', description: 'assert against a production-derived value' },
          ),
        );
      }
    }
    return out;
  }
}

export class Taut003ConstantTautology extends BaseRule {
  readonly id = 'TAUT-003' as const;
  readonly name = 'constant-tautology';
  readonly defaultSeverity = 'error' as const;
  readonly description = 'both assertion sides are compile-time constants';
  check({ module }: RuleContext): Issue[] {
    const out: Issue[] = [];
    for (const a of module.assertions) {
      if (CONSTANT_API_ALLOWLIST.has(a.api)) continue;
      const [l, r] = a.operands;
      if (!l || !r) continue;
      if (l.constant && r.constant && l.provenance === 'literal' && r.provenance === 'literal') {
        out.push(
          issue(
            { module } as RuleContext,
            this.id,
            this.defaultSeverity,
            a,
            `constant-tautology: ${l.text} compared with ${r.text}; cannot fail`,
            { code: '', description: 'assert a value that flows from the code under test' },
          ),
        );
      }
    }
    return out;
  }
}

export class Taut004MockOnlyAssertion extends BaseRule {
  readonly id = 'TAUT-004' as const;
  readonly name = 'mock-only-assertion';
  readonly defaultSeverity = 'warning' as const;
  readonly description = 'all assertion operands are mock-derived and the test never touches production';
  check({ module }: RuleContext): Issue[] {
    const out: Issue[] = [];
    const fns = new Map(module.functions.map((f) => [f.id, f]));
    for (const a of module.assertions) {
      const fn = fns.get(a.fnId);
      if (fn?.hasProductionCalls) continue;
      const allMock =
        a.operands.length > 0 &&
        a.operands.every((o) => o.provenance === 'mock-config' || o.provenance === 'mock-call');
      if (allMock) {
        out.push(
          issue(
            { module } as RuleContext,
            this.id,
            this.defaultSeverity,
            a,
            `mock-only-assertion: test exercises no production code`,
            { code: '', description: 'exercise the real SUT with a stubbed dependency' },
          ),
        );
      }
    }
    return out;
  }
}

export class Taut005ZeroReachStub extends BaseRule {
  readonly id = 'TAUT-005' as const;
  readonly name = 'zero-reach-stub';
  readonly defaultSeverity = 'warning' as const;
  readonly description = 'a configured mock is never invoked or asserted';
  check({ module }: RuleContext): Issue[] {
    const out: Issue[] = [];
    const asserted = new Set<string>();
    const fns = new Map(module.functions.map((f) => [f.id, f]));
    for (const a of module.assertions) for (const o of a.operands) for (const m of o.mockRefs) asserted.add(m);
    for (const mock of module.mocks) {
      if (mock.configuredValues.length === 0 && mock.stubbedMembers.every((s) => s.returnValues.length === 0)) continue;
      if (mock.invocationSites.length > 0) continue;
      if (asserted.has(mock.id)) continue;
      // A #[should_panic] test asserts the drop-time panic — the un-invoked expectation is the point.
      if (mock.fnId ? fns.get(mock.fnId)?.shouldPanic : false) continue;
      out.push(
        issue(
          { module } as RuleContext,
          this.id,
          this.defaultSeverity,
          mock,
          `zero-reach-stub: mock configured but never invoked or asserted`,
        ),
      );
    }
    return out;
  }
}

export class Taut006UnconfiguredSpyAssert extends BaseRule {
  readonly id = 'TAUT-006' as const;
  readonly name = 'unconfigured-spy-assert';
  readonly defaultSeverity = 'warning' as const;
  readonly description = 'toHaveBeenCalled* on a spy with no stub and no call path';
  check({ module }: RuleContext): Issue[] {
    const out: Issue[] = [];
    const mocks = new Map(module.mocks.map((m) => [m.id, m]));
    for (const a of module.assertions) {
      const spyApi =
        a.api.startsWith('toHaveBeenCalled') ||
        a.api.startsWith('assert_called') ||
        a.api === 'assert_not_called' ||
        a.api === 'shouldHaveReceived' ||
        a.api === 'shouldNotHaveReceived';
      if (!spyApi) continue;
      const ref = a.operands[0]?.mockRefs[0];
      if (!ref) continue;
      const mock = mocks.get(ref);
      if (!mock) continue;
      const isSpy =
        mock.pattern === 'vi.spyOn' ||
        mock.pattern === 'jest.spyOn' ||
        mock.pattern === 'mockery-spy' ||
        mock.pattern === 'autospec' ||
        mock.pattern === 'patch' ||
        mock.pattern === 'patch-object';
      const configured = mock.configuredValues.length > 0 || mock.stubbedMembers.some((s) => s.returnValues.length > 0);
      if (isSpy && !configured && mock.invocationSites.length === 0) {
        out.push(
          issue(
            { module } as RuleContext,
            this.id,
            this.defaultSeverity,
            a,
            `unconfigured-spy-assert: spy has no stub and no production call path`,
            { code: '', description: 'stub the spy or assert a production-derived value' },
          ),
        );
      }
    }
    return out;
  }
}

export const tautologyRules: Rule[] = [
  new Taut001SelfComparison(),
  new Taut002MockEcho(),
  new Taut003ConstantTautology(),
  new Taut004MockOnlyAssertion(),
  new Taut005ZeroReachStub(),
  new Taut006UnconfiguredSpyAssert(),
];
