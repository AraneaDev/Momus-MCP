/** Token budget contract (spec docs/05 §5.1–§5.2). */
import type { Issue } from './ir.ts';

/** Conservative estimate: ~4 chars/token + 4 overhead per line. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4) + 4;
}

/** Canonical issue line: `file:line:col [RULE] severity — message — fix: description` */
export function renderIssueLine(issue: Issue, workspaceRoot: string): string {
  const file = toRel(issue.span.file, workspaceRoot);
  const fix = issue.fix ? ` — fix: ${issue.fix.description}` : '';
  return `${file}:${issue.span.startLine}:${issue.span.startCol} [${issue.rule}] ${issue.severity} — ${issue.message}${fix}`;
}

export function toRel(abs: string, root: string): string {
  const rel = abs.startsWith(root) ? abs.slice(root.length + 1) : abs;
  return rel.replace(/\\/g, '/');
}

/** Assert the <100 token contract; throws on violation (used in tests + dev). */
export function assertTokenBudget(line: string, max: number): void {
  const t = estimateTokens(line);
  if (t >= max) {
    throw new Error(`token budget violated: ${t} >= ${max} tokens for line: ${line}`);
  }
}

export function issueTokens(issue: Issue, workspaceRoot: string): number {
  return estimateTokens(renderIssueLine(issue, workspaceRoot));
}
