import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyFixes, applyFixToFiles, buildFixDiff, collectFixable, editsByFile, unifiedDiff } from '../src/fix.ts';
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

describe('collectFixable / editsByFile', () => {
  it('keeps only mechanically applicable fixes', () => {
    const replace = { kind: 'replace', span: sp('/x/t.ts', 2), code: 'x' } as FixSuggestion;
    const del = { kind: 'delete', span: sp('/x/t.ts', 3), code: '' } as FixSuggestion;
    const empty = { kind: 'replace', span: sp('/x/t.ts', 4), code: '' } as FixSuggestion;
    const noSpan = { kind: 'replace', code: 'x' } as FixSuggestion;
    expect(collectFixable([issue(replace), issue(del), issue(empty), issue(noSpan), issue()])).toHaveLength(2);
  });

  it('groups fixable issues by file', () => {
    const fix1 = { kind: 'replace', span: sp('/x/a.ts', 2), code: 'x' } as FixSuggestion;
    const fix2 = { kind: 'replace', span: sp('/x/a.ts', 3), code: 'y' } as FixSuggestion;
    const fix3 = { kind: 'replace', span: sp('/y/b.ts', 2), code: 'z' } as FixSuggestion;
    const fixable = [{ issue: issue(fix1), fix: fix1 }, { issue: issue(fix2), fix: fix2 }, { issue: issue(fix3), fix: fix3 }];
    
    const map = editsByFile(fixable);
    expect(map.get('/x/a.ts')).toEqual([fix1, fix2]);
    expect(map.get('/y/b.ts')).toEqual([fix3]);
    expect(map.size).toBe(2);
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

  it('falls back to whole-file replace for pathological inputs (> 8_000_000 iterations)', () => {
    const oldLines = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n');
    const newLines = Array.from({ length: 4000 }, (_, i) => `new line ${i}`).join('\n');
    const diff = unifiedDiff(oldLines, newLines, 'big.ts');
    expect(diff).toContain('--- a/big.ts');
    expect(diff).toContain('-line 0');
    expect(diff).toContain('+new line 0');
  });

  it('splits hunks that are separated by more than 2*CONTEXT equal lines', () => {
    // CONTEXT is 3. We need > 6 unchanged lines between two changes.
    // 8 unchanged lines.
    const oldText = 'a\n' + 'b\n'.repeat(8) + 'c\n';
    const newText = 'A\n' + 'b\n'.repeat(8) + 'C\n';
    const diff = unifiedDiff(oldText, newText, 'hunks.ts');
    // There should be two hunks
    expect(diff.split('@@').length).toBe(5); // two hunks mean two @@ -x,y +z,w @@, so 4 + 1
    expect(diff).toContain('-a\n+A\n');
    expect(diff).toContain('-c\n+C\n');
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
