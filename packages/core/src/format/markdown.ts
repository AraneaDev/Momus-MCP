/** Markdown report (spec docs/05 §5.3). */
import type { AuditResult, Issue } from '../ir.ts';
import { renderIssueLine } from '../tokens.ts';

export interface MarkdownOptions {
  workspaceRoot: string;
  verbosity: 'summary' | 'issues';
  /** file label(s) for the header, e.g. 'tests/order.test.ts' or '12 files' */
  scopeLabel: string;
}

export function buildMarkdownReport(result: AuditResult, opts: MarkdownOptions): string {
  const { workspaceRoot, scopeLabel } = opts;
  const s = result.summary;
  // The header, like CLEAN and the exit code, reports the PRE-TRUNCATION totals so a
  // summary-only run (--max-issues 0 / verbosity summary) never masks findings: a truncated
  // report prints "4 issues … CLEAN:false … more issues omitted", never "0 issues … CLEAN:false".
  const clean = s.totalErrors === 0 && s.totalWarnings === 0;
  const header =
    `# Momus audit — ${scopeLabel}\n\n` +
    `Audited ${s.filesAudited} file${s.filesAudited === 1 ? '' : 's'} · ${s.totalIssues} issue${s.totalIssues === 1 ? '' : 's'} ` +
    `(${s.totalErrors} error · ${s.totalWarnings} warning · ${s.totalInfos} info) · ${s.durationMs}ms — CLEAN:${clean}`;

  if (opts.verbosity === 'summary') return header + '\n';

  const bySeverity = (sev: Issue['severity']) => result.issues.filter((i) => i.severity === sev);
  const lines: string[] = [header, ''];

  const section = (title: string, items: Issue[]) => {
    if (items.length === 0) return;
    lines.push(`## ${title}`);
    for (const i of items) {
      lines.push(`- \`${renderIssueLine(i, workspaceRoot)}\``);
      if (i.fix?.code) {
        lines.push('  ```ts');
        lines.push(`  // fix: ${i.fix.code}`);
        lines.push('  ```');
      }
    }
    lines.push('');
  };

  section('Errors', bySeverity('error'));
  section('Warnings', bySeverity('warning'));
  section('Notes', [
    ...bySeverity('info'),
    ...result.diagnostics.map((d) => ({
      id: 'diag',
      rule: 'SYS-001' as const,
      severity: 'info' as const,
      span: d.span,
      message: d.message.slice(0, 80),
      tokens: 0,
    })),
  ]);

  if (s.truncated) {
    lines.push(`_… more issues omitted (maxIssues=${result.issues.length}) — pass maxIssues to raise the cap_\n`);
  }
  if (s.suppressed > 0) {
    lines.push(`_${s.suppressed} finding${s.suppressed === 1 ? '' : 's'} suppressed_`);
  }
  return lines.join('\n').trimEnd() + '\n';
}
