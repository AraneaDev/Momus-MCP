/** Mock hygiene rules (spec docs/03 §3.3.3). */
import type { Issue, ModuleIR, RuleId, Severity } from '../ir.ts';
import type { Rule, RuleContext } from './engine.ts';

abstract class HygieneRule implements Rule {
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
  span: { file: string; startLine: number; startCol: number; endLine: number; endCol: number },
  message: string,
  fix?: { code: string; description: string },
): Issue => ({
  id: `${rule}:${span.file}:${span.startLine}:${span.startCol}:${message.slice(0, 24)}`,
  rule,
  severity,
  span,
  message: message.slice(0, 80),
  fix: fix ? { kind: 'replace', code: fix.code, description: fix.description.slice(0, 60) } : undefined,
  tokens: 0,
});

const FRAMEWORK_SPECIFIERS = /^(vitest|@vitest\/.*|jest|@jest\/.*)$/;

/** Test file's subject: ledger.test.ts -> ledger */
function testSubject(modulePath: string): string | undefined {
  const base = modulePath.split('/').pop() ?? '';
  const m = base.match(/^(.+?)\.(test|spec)\.[cm]?[jt]sx?$/);
  return m?.[1];
}

export class Mock001Saturation extends HygieneRule {
  readonly id = 'MOCK-001' as const;
  readonly name = 'mock-saturation';
  readonly defaultSeverity = 'warning' as const;
  readonly description = 'over-mocking heuristic: high mock ratio with no production-provenance assertions';
  check({ module, config }: RuleContext): Issue[] {
    const out: Issue[] = [];
    const threshold = config.mockSaturationThreshold;
    const mockedTargets = new Set<string>();
    for (const m of module.mocks) {
      // prefer module path; symbol ids of the same module would double-count
      if (m.target?.modulePath) mockedTargets.add(m.target.modulePath);
      else if (m.target?.symbolId) mockedTargets.add(m.target.symbolId);
    }
    const deps = module.imports.filter((i) => !FRAMEWORK_SPECIFIERS.test(i.specifier));
    const totalDeps = new Set(deps.map((i) => i.resolvedPath ?? i.specifier)).size;
    if (totalDeps === 0) return out;
    const ratio = mockedTargets.size / totalDeps;
    const productionAssertions = module.assertions.filter((a) =>
      a.operands.some((o) => o.provenance === 'production'),
    ).length;
    if (ratio >= threshold && productionAssertions < 2) {
      out.push(
        issue(
          { module, config } as RuleContext,
          this.id,
          this.defaultSeverity,
          { file: module.path, startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
          `${mockedTargets.size}/${totalDeps} dependencies mocked, ${productionAssertions} production-provenance assertions; over-mocked`,
          { code: '', description: 'replace a mock with the real dependency' },
        ),
      );
    }
    return out;
  }
}

export class Mock002MockOfSelf extends HygieneRule {
  readonly id = 'MOCK-002' as const;
  readonly name = 'mock-of-self';
  readonly defaultSeverity = 'info' as const;
  readonly description = 'the test mocks a module it also imports as the SUT';
  check({ module }: RuleContext): Issue[] {
    const out: Issue[] = [];
    const subject = testSubject(module.path);
    if (!subject) return out;
    for (const m of module.mocks) {
      if (m.target?.kind === 'module' && m.target.modulePath) {
        const targetBase = m.target.modulePath
          .split('/')
          .pop()
          ?.replace(/\.(ts|tsx|js|jsx|mts|cts|mjs)$/, '');
        if (targetBase === subject) {
          out.push(
            issue(
              { module } as RuleContext,
              this.id,
              this.defaultSeverity,
              m.span,
              `mock-of-self: '${m.target.specifier}' is mocked but also imported as the subject under test`,
            ),
          );
        }
      }
    }
    return out;
  }
}

export const hygieneRules: Rule[] = [new Mock001Saturation(), new Mock002MockOfSelf()];
