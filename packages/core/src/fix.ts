/**
 * Fix mechanics (docs/01 §1.5): collect, diff, and apply rule-emitted fixes.
 *
 * Lives in core because both write surfaces share it: the CLI's `audit --fix` (gated by
 * `--yes`, refused in CI) and the MCP server's `apply_issue_fix`. It cannot live in the CLI —
 * `@momus/cli` already depends on `@momus/mcp-server`, so the server importing it back would
 * close a package cycle. One fixer, two callers, no fork.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { FixSuggestion, Issue } from './ir.ts';

export interface FixableIssue {
  issue: Issue;
  fix: FixSuggestion;
}

/** An edit is mechanically applicable only when it carries a span and, for replace/insert, real code. */
export function collectFixable(issues: Issue[]): FixableIssue[] {
  const out: FixableIssue[] = [];
  for (const issue of issues) {
    const fix = issue.fix;
    if (!fix?.span) continue;
    if (fix.kind === 'delete' || fix.code.length > 0) out.push({ issue, fix });
  }
  return out;
}

/** Group fixable issues by absolute file path (deterministic insertion order). */
export function editsByFile(fixable: FixableIssue[]): Map<string, FixSuggestion[]> {
  const map = new Map<string, FixSuggestion[]>();
  for (const { fix } of fixable) {
    const file = fix.span!.file;
    const list = map.get(file) ?? [];
    list.push(fix);
    map.set(file, list);
  }
  return map;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function offsetAt(starts: number[], text: string, line: number, col: number): number {
  const index = Math.min(Math.max(line - 1, 0), starts.length - 1);
  const lineStart = starts[index]!;
  const newline = text.indexOf('\n', lineStart);
  const lineEnd = newline === -1 ? text.length : newline;
  return Math.min(lineStart + Math.max(col - 1, 0), lineEnd);
}

/** Apply span-based fixes to a file's content (sorts descending so offsets stay valid). */
export function applyFixes(content: string, fixes: FixSuggestion[]): string {
  const starts = lineStarts(content);
  const edits = fixes
    .map((fix) => {
      const span = fix.span!;
      return {
        start: offsetAt(starts, content, span.startLine, span.startCol),
        end: offsetAt(starts, content, span.endLine, span.endCol),
        fix,
      };
    })
    .filter((edit) => edit.start <= edit.end)
    .sort((a, b) => b.start - a.start || b.end - a.end);
  let out = content;
  for (const edit of edits) {
    const code = edit.fix.kind === 'delete' ? '' : edit.fix.code;
    out = out.slice(0, edit.start) + code + out.slice(edit.end);
  }
  return out;
}

type Op = { type: 'eq' | 'del' | 'ins'; line: string };

function diffLines(oldLines: string[], newLines: string[]): Op[] {
  const n = oldLines.length;
  const m = newLines.length;
  // Guard against pathological inputs: fall back to a whole-file replace.
  if (n * m > 8_000_000) {
    return [
      ...oldLines.map((line) => ({ type: 'del' as const, line })),
      ...newLines.map((line) => ({ type: 'ins' as const, line })),
    ];
  }
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: 'eq', line: oldLines[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: 'del', line: oldLines[i]! });
      i++;
    } else {
      ops.push({ type: 'ins', line: newLines[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'del', line: oldLines[i++]! });
  while (j < m) ops.push({ type: 'ins', line: newLines[j++]! });
  return ops;
}

/** Minimal unified diff (3 lines of context); empty string when the texts are identical. */
export function unifiedDiff(oldText: string, newText: string, fileLabel: string): string {
  if (oldText === newText) return '';
  const CONTEXT = 3;
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const ops = diffLines(oldLines, newLines);
  const oldPrefix = new Array<number>(ops.length + 1).fill(0);
  const newPrefix = new Array<number>(ops.length + 1).fill(0);
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    oldPrefix[i + 1] = oldPrefix[i]! + (op.type === 'ins' ? 0 : 1);
    newPrefix[i + 1] = newPrefix[i]! + (op.type === 'del' ? 0 : 1);
  }
  // Group changed lines into hunks; a run of <= 2*CONTEXT equal lines merges neighbours.
  const groups: Array<{ start: number; end: number }> = [];
  let gStart = -1;
  let gEnd = -1;
  for (let idx = 0; idx < ops.length; idx++) {
    if (ops[idx]!.type === 'eq') continue;
    if (gStart === -1) {
      gStart = idx;
      gEnd = idx;
      continue;
    }
    if (idx - gEnd - 1 <= CONTEXT * 2) {
      gEnd = idx;
    } else {
      groups.push({ start: gStart, end: gEnd });
      gStart = idx;
      gEnd = idx;
    }
  }
  if (gStart !== -1) groups.push({ start: gStart, end: gEnd });

  const chunks: string[] = [`--- a/${fileLabel}`, `+++ b/${fileLabel}`];
  for (const group of groups) {
    const hunkStart = Math.max(0, group.start - CONTEXT);
    const hunkEnd = Math.min(ops.length, group.end + CONTEXT + 1);
    const oldStart = oldPrefix[hunkStart]! + 1;
    const oldCount = oldPrefix[hunkEnd]! - oldPrefix[hunkStart]!;
    const newStart = newPrefix[hunkStart]! + 1;
    const newCount = newPrefix[hunkEnd]! - newPrefix[hunkStart]!;
    chunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (let idx = hunkStart; idx < hunkEnd; idx++) {
      const op = ops[idx]!;
      chunks.push(op.type === 'eq' ? ` ${op.line}` : op.type === 'del' ? `-${op.line}` : `+${op.line}`);
    }
  }
  return chunks.join('\n') + '\n';
}

/** Read files, apply fixes, and return the unified diff text (dry-run output). */
export function buildFixDiff(root: string, edits: Map<string, FixSuggestion[]>): string {
  const chunks: string[] = [];
  for (const [file, fixes] of [...edits.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const content = readFileSync(file, 'utf8');
    const label = relative(root, file).replace(/\\/g, '/');
    const diff = unifiedDiff(content, applyFixes(content, fixes), label);
    if (diff) chunks.push(diff);
  }
  return chunks.join('');
}

/** Apply fixes to files (the `--yes` path); returns the number of changed files. */
export function applyFixToFiles(root: string, edits: Map<string, FixSuggestion[]>): number {
  let changed = 0;
  for (const [file, fixes] of edits) {
    const content = readFileSync(file, 'utf8');
    const next = applyFixes(content, fixes);
    if (next === content) continue;
    writeFileSync(file, next);
    changed++;
  }
  return changed;
}
