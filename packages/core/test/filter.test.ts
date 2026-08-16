import { describe, expect, it } from 'vitest';
import { filterResult, type AuditResult, type Issue, type RuleId } from '../src/index.ts';

function issue(rule: RuleId, severity: Issue['severity'], n: number): Issue {
  return {
    id: `i${n}`,
    rule,
    severity,
    span: { file: 'f.ts', startLine: n, startCol: 1, endLine: n, endCol: 1 },
    message: `msg ${n}`,
    tokens: 0,
  };
}

function result(issues: Issue[]): AuditResult {
  const count = (s: Issue['severity']) => issues.filter((i) => i.severity === s).length;
  return {
    summary: {
      filesAudited: 3,
      issues: issues.length,
      errors: count('error'),
      warnings: count('warning'),
      infos: count('info'),
      totalIssues: issues.length,
      totalErrors: count('error'),
      totalWarnings: count('warning'),
      totalInfos: count('info'),
      suppressed: 0,
      durationMs: 1,
      truncated: true,
    },
    issues,
    suppressed: [],
    diagnostics: [],
    indexStats: { modules: 3, symbols: 3, mocks: 3 },
  };
}

describe('filterResult', () => {
  it('recomputes shown and total summary counts for the kept subset', () => {
    const r = result([
      issue('TAUT-002', 'error', 1),
      issue('DRIFT-001', 'error', 2),
      issue('DRIFT-006', 'warning', 3),
      issue('MOCK-001', 'warning', 4),
    ]);
    const drift = filterResult(r, (i) => i.rule.startsWith('DRIFT'));
    expect(drift.issues.map((i) => i.rule)).toEqual(['DRIFT-001', 'DRIFT-006']);
    expect(drift.summary).toMatchObject({
      issues: 2,
      errors: 1,
      warnings: 1,
      infos: 0,
      totalIssues: 2,
      totalErrors: 1,
      totalWarnings: 1,
      totalInfos: 0,
      truncated: false,
    });
    // untouched passthrough fields
    expect(drift.summary.filesAudited).toBe(3);
    expect(drift.indexStats).toEqual({ modules: 3, symbols: 3, mocks: 3 });
  });

  it('yields a clean, empty result when nothing matches', () => {
    const r = result([issue('TAUT-002', 'error', 1)]);
    const drift = filterResult(r, (i) => i.rule.startsWith('DRIFT'));
    expect(drift.issues).toEqual([]);
    expect(drift.summary).toMatchObject({
      issues: 0,
      errors: 0,
      warnings: 0,
      infos: 0,
      totalIssues: 0,
      totalErrors: 0,
      totalWarnings: 0,
      truncated: false,
    });
  });
});
