import { describe, expect, it } from 'vitest';
import { buildMarkdownReport } from '../src/format/markdown.ts';
import { buildJsonEnvelope } from '../src/format/json.ts';
import type { AuditResult, Issue, Summary } from '../src/ir.ts';
import { span } from '../src/ir.ts';

const ROOT = '/repo';

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'i1',
    rule: 'DRIFT-001',
    severity: 'error',
    span: span('/repo/tests/a.test.ts', 10, 5, 10, 20),
    message: 'missing-member: stale does not exist',
    tokens: 12,
    ...overrides,
  };
}

function summary(overrides: Partial<Summary> = {}): Summary {
  return {
    filesAudited: 3,
    issues: 1,
    errors: 1,
    warnings: 0,
    infos: 0,
    totalIssues: 1,
    totalErrors: 1,
    totalWarnings: 0,
    totalInfos: 0,
    suppressed: 0,
    durationMs: 12,
    truncated: false,
    ...overrides,
  };
}

function result(overrides: Partial<AuditResult> = {}): AuditResult {
  return {
    summary: summary(),
    issues: [issue()],
    suppressed: [],
    diagnostics: [],
    indexStats: { modules: 2, symbols: 5, mocks: 1 },
    ...overrides,
  };
}

describe('buildMarkdownReport', () => {
  it('emits a summary-only header when verbosity is summary', () => {
    const out = buildMarkdownReport(result(), { workspaceRoot: ROOT, verbosity: 'summary', scopeLabel: 'tests' });
    expect(out).toContain('# Momus audit — tests');
    expect(out).toContain('CLEAN:false');
    expect(out).not.toContain('## Errors');
  });

  it('renders sections by severity and omits empty ones', () => {
    const r = result({
      issues: [issue({ severity: 'error', rule: 'TAUT-002' }), issue({ severity: 'warning', rule: 'DRIFT-002' })],
    });
    const out = buildMarkdownReport(r, { workspaceRoot: ROOT, verbosity: 'issues', scopeLabel: '2 files' });
    expect(out).toContain('## Errors');
    expect(out).toContain('## Warnings');
    expect(out).not.toContain('## Notes');
    expect(out).toContain('[TAUT-002] error');
  });

  it('renders fix code blocks when a fix carries code', () => {
    const r = result({
      issues: [issue({ fix: { kind: 'replace', code: 'totalFor', description: 'rename to totalFor' } })],
    });
    const out = buildMarkdownReport(r, { workspaceRoot: ROOT, verbosity: 'issues', scopeLabel: '1 file' });
    expect(out).toContain('// fix: totalFor');
    expect(out).toContain('fix: rename to totalFor');
  });

  it('folds diagnostics into Notes as SYS-001', () => {
    const r = result({
      issues: [],
      diagnostics: [{ severity: 'error', span: span('/repo/x.ts', 1, 1, 1, 2), message: 'boom' }],
    });
    const out = buildMarkdownReport(r, { workspaceRoot: ROOT, verbosity: 'issues', scopeLabel: '1 file' });
    expect(out).toContain('## Notes');
    expect(out).toContain('[SYS-001] info — boom');
  });

  it('notes truncation and suppression when present', () => {
    const r = result({
      summary: summary({ truncated: true, suppressed: 2 }),
    });
    const out = buildMarkdownReport(r, { workspaceRoot: ROOT, verbosity: 'issues', scopeLabel: '1 file' });
    expect(out).toContain('more issues omitted');
    expect(out).toContain('2 findings suppressed');
  });

  it('header uses pre-truncation totals so --max-issues 0 never reports a false 0 issues', () => {
    // 4 real findings, all truncated out of the shown list (maxIssues 0): the headline must
    // still say 4 warnings + CLEAN:false, not "0 issues … CLEAN:false".
    const r = result({
      issues: [], // shown list is empty after truncation
      summary: summary({
        issues: 0,
        errors: 0,
        warnings: 0,
        infos: 0,
        totalIssues: 4,
        totalErrors: 0,
        totalWarnings: 4,
        totalInfos: 0,
        truncated: true,
      }),
    });
    const out = buildMarkdownReport(r, { workspaceRoot: ROOT, verbosity: 'summary', scopeLabel: 'workspace' });
    expect(out).toContain('Audited 3 files · 4 issues (0 error · 4 warning · 0 info)');
    expect(out).toContain('CLEAN:false');
  });

  it('singularizes file/issue/finding labels for exactly one of each', () => {
    const r = result({
      summary: summary({ filesAudited: 1, suppressed: 1, issues: 1, errors: 1 }),
    });
    const out = buildMarkdownReport(r, { workspaceRoot: ROOT, verbosity: 'issues', scopeLabel: '1 file' });
    expect(out).toContain('Audited 1 file · 1 issue');
    expect(out).toContain('1 error · 0 warning · 0 info');
    expect(out).toContain('1 finding suppressed');
    expect(out).not.toContain('findings suppressed');
  });

  it('marks CLEAN when no errors or warnings exist (infos allowed)', () => {
    const r = result({
      summary: summary({ errors: 0, totalErrors: 0, issues: 1, totalIssues: 1, infos: 1, totalInfos: 1 }),
      issues: [issue({ severity: 'info', rule: 'MOCK-002' })],
    });
    const out = buildMarkdownReport(r, { workspaceRoot: ROOT, verbosity: 'summary', scopeLabel: '1 file' });
    expect(out).toContain('CLEAN:true');
  });
});

describe('buildJsonEnvelope', () => {
  it('includes optional evidence and fix fields when present', () => {
    const r = result({
      issues: [
        issue({
          evidence: 'line 10',
          fix: {
            kind: 'replace',
            span: span('/repo/tests/a.test.ts', 10, 5, 10, 20),
            code: 'totalFor',
            description: 'rename',
          },
        }),
      ],
    });
    const env = buildJsonEnvelope(r, { tool: 'audit', workspaceRoot: ROOT });
    const issues = (env.result as { issues: Array<Record<string, unknown>> }).issues;
    expect(issues[0]).toMatchObject({ file: 'tests/a.test.ts', line: 10, column: 5, evidence: 'line 10' });
    expect(issues[0]!.fix as Record<string, unknown>).toMatchObject({ kind: 'replace', code: 'totalFor' });
  });

  it('omits fix when absent and includes diff metadata', () => {
    const env = buildJsonEnvelope(result(), {
      tool: 'verify_mock_drift',
      workspaceRoot: ROOT,
      diffBase: 'HEAD',
      changedFiles: 4,
      staleMockCandidates: 1,
    });
    const issues = (env.result as { issues: Array<Record<string, unknown>> }).issues;
    expect(issues[0]!.fix).toBeUndefined();
    expect((env.result as { summary: Record<string, unknown> }).summary).toMatchObject({
      diffBase: 'HEAD',
      changedFiles: 4,
      staleMockCandidates: 1,
    });
    expect(env.tool).toBe('verify_mock_drift');
  });

  it('includes suppressed issues and diagnostics when present', () => {
    const r = result({
      suppressed: [issue({ id: 's1', severity: 'warning', rule: 'TAUT-004' })],
      diagnostics: [{ severity: 'error', span: span('/repo/x.ts', 2, 2, 2, 3), message: 'parse fail' }],
    });
    const env = buildJsonEnvelope(r, { tool: 'audit', workspaceRoot: ROOT });
    const res = env.result as { suppressed: unknown[]; diagnostics: Array<Record<string, unknown>> };
    expect(res.suppressed).toHaveLength(1);
    expect(res.diagnostics[0]).toMatchObject({ severity: 'error', file: 'x.ts', message: 'parse fail' });
  });
});
