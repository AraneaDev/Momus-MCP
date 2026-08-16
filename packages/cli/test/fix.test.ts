import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyFixes, applyFixToFiles, buildFixDiff, collectFixable, unifiedDiff } from '../src/fix.ts';
import type { FixSuggestion, Issue } from '@momus/core';

const sp = (file: string, sl: number, sc = 1, el = sl, ec = 2) => ({
  file,
  startLine: sl,
  startCol: sc,
  endLine: el,
  endCol: ec,
});

function issue(fix?: FixSuggestion): Issue {
  return { id: 'i1', rule: 'TAUT-002', severity: 'error', span: sp('/x/t.ts', 1), message: 'm', tokens: 1, fix };
}

describe('collectFixable', () => {
  it('keeps only mechanically applicable fixes', () => {
    const replace = { kind: 'replace', span: sp('/x/t.ts', 2), code: 'x' } as FixSuggestion;
    const del = { kind: 'delete', span: sp('/x/t.ts', 3), code: '' } as FixSuggestion;
    const empty = { kind: 'replace', span: sp('/x/t.ts', 4), code: '' } as FixSuggestion;
    const noSpan = { kind: 'replace', code: 'x' } as FixSuggestion;
    expect(collectFixable([issue(replace), issue(del), issue(empty), issue(noSpan), issue()])).toHaveLength(2);
  });
});

describe('applyFixes', () => {
  it('applies replace, delete, and insert at span offsets', () => {
    const content = 'aaa\nbbb\nccc\n';
    const fixes: FixSuggestion[] = [
      { kind: 'replace', span: sp('/x', 2, 1, 2, 4), code: 'B' },
      { kind: 'delete', span: sp('/x', 3, 1, 3, 4), code: '' },
    ];
    expect(applyFixes(content, fixes)).toBe('aaa\nB\n\n');
  });

  it('inserts code at a zero-width span', () => {
    const content = 'aaa\n';
    expect(applyFixes(content, [{ kind: 'insert', span: sp('/x', 1, 4, 1, 4), code: '!' }])).toBe('aaa!\n');
  });
});

describe('unifiedDiff', () => {
  it('is deterministic and shows removed/added lines with context', () => {
    const a = unifiedDiff('a\nb\nc\nd\n', 'a\nB\nc\nd\n', 't.ts');
    const b = unifiedDiff('a\nb\nc\nd\n', 'a\nB\nc\nd\n', 't.ts');
    expect(a).toBe(b);
    expect(a).toContain('--- a/t.ts');
    expect(a).toContain('-b');
    expect(a).toContain('+B');
  });

  it('returns an empty string when there is no change', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb\n', 't.ts')).toBe('');
  });
});

describe('buildFixDiff / applyFixToFiles', () => {
  it('produces the same diff a dry-run previews and applies byte-identically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'momus-fix-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      const file = join(dir, 'src', 'svc.ts');
      const original = 'export class Svc {\n  totalFor(): number { return 0; }\n}\n';
      writeFileSync(file, original);
      const fixes: FixSuggestion[] = [{ kind: 'replace', span: sp(file, 2, 3, 2, 11), code: 'total' }];
      const edits = new Map([[file, fixes]]);
      const diff = buildFixDiff(dir, edits);
      expect(diff).toContain('--- a/src/svc.ts');
      expect(diff).toContain('-  totalFor(): number { return 0; }');
      expect(diff).toContain('+  total(): number { return 0; }');
      expect(applyFixToFiles(dir, edits)).toBe(1);
      expect(readFileSync(file, 'utf8')).toBe('export class Svc {\n  total(): number { return 0; }\n}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
