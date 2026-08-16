/** Rule engine (spec docs/03 §3.1). Rules are pure functions over IR + index. */
import type { Issue, ModuleIR, RuleId, Severity } from '../ir.ts';
import type { SymbolIndex } from '../symbolIndex.ts';
import type { MomusConfig } from '../config.ts';

/** Present only in git-diff mode (spec docs/03 §3.1). */
export interface DiffScope {
  baseRef: string;
  changedPaths: string[]; // absolute paths of files changed vs baseRef
  changedSymbolIds: Set<string>; // production symbol ids whose defining file changed
}

export interface RuleContext {
  index: SymbolIndex;
  module: ModuleIR; // the test file under audit
  config: MomusConfig;
  diff?: DiffScope;
}

export interface Rule {
  readonly id: RuleId;
  readonly name: string;
  readonly defaultSeverity: Severity;
  readonly description: string;
  /** Framework/language gate: return false to skip this module. */
  appliesTo(m: ModuleIR): boolean;
  check(ctx: RuleContext): Issue[];
}

export function runRules(rules: Rule[], ctx: RuleContext): Issue[] {
  const issues: Issue[] = [];
  for (const rule of rules) {
    if (!rule.appliesTo(ctx.module)) continue;
    const sev = ctx.config.rules[rule.id];
    if (sev && typeof sev === 'object' && sev.severity === 'off') continue;
    try {
      issues.push(...rule.check(ctx));
    } catch (e) {
      issues.push({
        id: `SYS-INTERNAL-${rule.id}`,
        rule: rule.id,
        severity: 'error',
        span: { file: ctx.module.path, startLine: 0, startCol: 0, endLine: 0, endCol: 0 },
        message: `internal error in rule ${rule.id}: ${(e as Error).message}`.slice(0, 80),
        tokens: 10,
      });
    }
  }
  return issues;
}

/** Sort deterministically: severity rank, file, line, col, rule id. */
export function sortIssues(issues: Issue[]): Issue[] {
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return [...issues].sort((a, b) => {
    const r = rank[a.severity] - rank[b.severity];
    if (r !== 0) return r;
    const f = a.span.file.localeCompare(b.span.file);
    if (f !== 0) return f;
    const l = a.span.startLine - b.span.startLine;
    if (l !== 0) return l;
    const c = a.span.startCol - b.span.startCol;
    if (c !== 0) return c;
    return a.rule.localeCompare(b.rule);
  });
}
