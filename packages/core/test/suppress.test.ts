import { describe, expect, it } from 'vitest';
import { parseSuppression, buildSuppressionState, isSuppressed } from '../src/suppress.ts';
import type { Issue, RawComment, TestFnIR } from '../src/ir.ts';

const raw = (text: string, line: number, kind: 'line' | 'docblock' = 'line', trailing = false): RawComment => ({
  text,
  line,
  kind,
  trailing,
});

const issue = (rule: string, line: number): Issue => ({
  id: 'i',
  rule: rule as Issue['rule'],
  severity: 'error',
  span: { file: '/ws/t.ts', startLine: line, startCol: 1, endLine: line, endCol: 2 },
  message: 'm',
  tokens: 5,
});

describe('parseSuppression', () => {
  it('parses bare ignore (all rules)', () => {
    expect(parseSuppression(raw('// @momus-ignore', 3))).toEqual({ rules: undefined });
  });
  it('parses rule-scoped ignore', () => {
    expect(parseSuppression(raw('// @momus-ignore:TAUT-002', 5))).toEqual({ rules: ['TAUT-002'] });
  });
  it('parses multi-rule ignore', () => {
    expect(parseSuppression(raw('// @momus-ignore:TAUT-002,DRIFT-001', 5))).toEqual({
      rules: ['TAUT-002', 'DRIFT-001'],
    });
  });
  it('parses the file banner', () => {
    expect(parseSuppression(raw('// @momus-ignore-file', 1))).toEqual({ file: true });
  });
  it('parses docblocks', () => {
    expect(parseSuppression(raw('/** @momus-ignore */', 7, 'docblock'))).toEqual({ rules: undefined, docblock: true });
  });
  it('tolerates missing whitespace after // and around ** (kills \\s* -> \\s regex mutants)', () => {
    expect(parseSuppression(raw('//@momus-ignore', 1))).toEqual({ rules: undefined });
    expect(parseSuppression(raw('//@momus-ignore-file', 1))).toEqual({ file: true });
    expect(parseSuppression(raw('/**@momus-ignore */', 2, 'docblock'))).toEqual({ rules: undefined, docblock: true });
    expect(parseSuppression(raw('/** @momus-ignore*/', 3, 'docblock'))).toEqual({ rules: undefined, docblock: true });
  });
  it('trims trailing whitespace before matching (kills the .trim() removal mutant)', () => {
    expect(parseSuppression(raw('// @momus-ignore ', 1))).toEqual({ rules: undefined });
    expect(parseSuppression(raw('// @momus-ignore-file\t', 1))).toEqual({ file: true });
  });
  it('rejects lookalikes and plain comments', () => {
    expect(parseSuppression(raw('// @momus-ignoree', 1))).toBeNull();
    expect(parseSuppression(raw('// regular comment', 2))).toBeNull();
    expect(parseSuppression(raw('// @momus-ignore:TAUT-002 extra text', 3))).toBeNull();
    // the file banner must be exact too (kills the FILE_BANNER_RE $ anchor removal)
    expect(parseSuppression(raw('// @momus-ignore-file extra', 1))).toBeNull();
  });
});

describe('buildSuppressionState / isSuppressed', () => {
  it('standalone line comment suppresses the next line only', () => {
    const state = buildSuppressionState([raw('// @momus-ignore:TAUT-002', 5)], '/ws/t.ts');
    expect(isSuppressed(issue('TAUT-002', 6), state)).toBe(true);
    expect(isSuppressed(issue('TAUT-002', 5), state)).toBe(false);
    expect(isSuppressed(issue('TAUT-002', 7), state)).toBe(false);
  });

  it('trailing comment suppresses its own line', () => {
    const state = buildSuppressionState([raw('// @momus-ignore:TAUT-002', 5, 'line', true)], '/ws/t.ts');
    expect(isSuppressed(issue('TAUT-002', 5), state)).toBe(true);
    expect(isSuppressed(issue('TAUT-002', 6), state)).toBe(false);
  });

  it('bare ignore suppresses any rule', () => {
    const state = buildSuppressionState([raw('// @momus-ignore', 3)], '/ws/t.ts');
    expect(isSuppressed(issue('DRIFT-999', 4), state)).toBe(true);
  });

  it('rule-scoped ignore does not suppress other rules', () => {
    const state = buildSuppressionState([raw('// @momus-ignore:TAUT-002', 5)], '/ws/t.ts');
    expect(isSuppressed(issue('TAUT-006', 6), state)).toBe(false);
  });

  it('suppresses all rules at a line when scoped to a different rule later', () => {
    const state = buildSuppressionState([raw('// @momus-ignore:TAUT-002', 5), raw('// @momus-ignore', 5)], '/ws/t.ts');
    expect(isSuppressed(issue('DRIFT-001', 6), state)).toBe(true);
  });

  it('file banner suppresses anywhere, but only in the first 10 lines', () => {
    const ok = buildSuppressionState([raw('// @momus-ignore-file', 2)], '/ws/t.ts');
    expect(isSuppressed(issue('MOCK-001', 99), ok)).toBe(true);
    const late = buildSuppressionState([raw('// @momus-ignore-file', 42)], '/ws/t.ts');
    expect(isSuppressed(issue('MOCK-001', 99), late)).toBe(false);
    // boundary: line 10 is still in the first 10 lines (kills <= -> < mutant)
    const boundary = buildSuppressionState([raw('// @momus-ignore-file', 10)], '/ws/t.ts');
    expect(isSuppressed(issue('MOCK-001', 99), boundary)).toBe(true);
  });

  it('ignores comments that are not suppressions (kills the if (!p) continue -> false mutant)', () => {
    const state = buildSuppressionState([raw('// regular comment', 5)], '/ws/t.ts');
    expect(isSuppressed(issue('TAUT-002', 6), state)).toBe(false);
    expect(isSuppressed(issue('TAUT-002', 5), state)).toBe(false);
  });

  it('docblock above a test fn suppresses the whole function span', () => {
    const fns: TestFnIR[] = [
      {
        id: 'f1',
        span: { file: '/ws/t.ts', startLine: 9, startCol: 1, endLine: 15, endCol: 2 },
        hasProductionCalls: false,
        productionCallCount: 0,
        assertionCount: 1,
      },
    ];
    const state = buildSuppressionState([raw('/** @momus-ignore */', 8, 'docblock')], '/ws/t.ts', fns);
    expect(isSuppressed(issue('TAUT-004', 9), state)).toBe(true);
    expect(isSuppressed(issue('TAUT-004', 14), state)).toBe(true);
    // the fn's own end line is still suppressed (kills for-loop <= endLine -> < mutant)
    expect(isSuppressed(issue('TAUT-004', 15), state)).toBe(true);
    expect(isSuppressed(issue('TAUT-004', 16), state)).toBe(false);
  });

  it('docblock does NOT bind a fn too far below it (kills (f) => true / && -> || / upper-bound mutants)', () => {
    const fns: TestFnIR[] = [
      {
        id: 'far',
        span: { file: '/ws/t.ts', startLine: 20, startCol: 1, endLine: 25, endCol: 2 },
        hasProductionCalls: false,
        productionCallCount: 0,
        assertionCount: 1,
      },
    ];
    const state = buildSuppressionState([raw('/** @momus-ignore */', 8, 'docblock')], '/ws/t.ts', fns);
    expect(isSuppressed(issue('TAUT-004', 20), state)).toBe(false);
  });

  it('docblock does NOT bind a fn that starts before/on the comment (kills lower-bound mutants)', () => {
    const fns: TestFnIR[] = [
      {
        id: 'above',
        span: { file: '/ws/t.ts', startLine: 5, startCol: 1, endLine: 7, endCol: 2 },
        hasProductionCalls: false,
        productionCallCount: 0,
        assertionCount: 1,
      },
    ];
    const state = buildSuppressionState([raw('/** @momus-ignore */', 8, 'docblock')], '/ws/t.ts', fns);
    expect(isSuppressed(issue('TAUT-004', 5), state)).toBe(false);

    // a fn whose START line is the docblock's own line must not be bound either (the
    // docblock only suppresses its own line then) — kills the dropped-lower-bound mutants
    // that would match it and extend the suppression across the whole fn span.
    const sameLine: TestFnIR[] = [
      {
        id: 'same',
        span: { file: '/ws/t.ts', startLine: 8, startCol: 1, endLine: 12, endCol: 2 },
        hasProductionCalls: false,
        productionCallCount: 0,
        assertionCount: 1,
      },
    ];
    const state2 = buildSuppressionState([raw('/** @momus-ignore */', 8, 'docblock')], '/ws/t.ts', sameLine);
    expect(isSuppressed(issue('TAUT-004', 8), state2)).toBe(true); // own line still suppressed
    expect(isSuppressed(issue('TAUT-004', 12), state2)).toBe(false); // fn span NOT covered
  });

  it('docblock binds a fn starting exactly DOCBLOCK_FN_GAP lines below (kills <= -> < upper-bound mutant)', () => {
    const fns: TestFnIR[] = [
      {
        id: 'edge',
        span: { file: '/ws/t.ts', startLine: 12, startCol: 1, endLine: 14, endCol: 2 },
        hasProductionCalls: false,
        productionCallCount: 0,
        assertionCount: 1,
      },
    ];
    const state = buildSuppressionState([raw('/** @momus-ignore */', 8, 'docblock')], '/ws/t.ts', fns);
    expect(isSuppressed(issue('TAUT-004', 12), state)).toBe(true);
  });

  it('docblock without a following fn suppresses its own line', () => {
    const state = buildSuppressionState([raw('/** @momus-ignore */', 8, 'docblock')], '/ws/t.ts');
    expect(isSuppressed(issue('TAUT-002', 8), state)).toBe(true);
    expect(isSuppressed(issue('TAUT-002', 9), state)).toBe(false);
  });
});

describe('file-scoped rule suppression', () => {
  const FILE = '/ws/t.ts';
  const banner = (text: string, line = 1): RawComment => ({ kind: 'line', text, line, trailing: false });

  it('suppresses only the listed rules', () => {
    const state = buildSuppressionState([banner('// @momus-ignore-file:MOCK-001')], FILE);
    expect(isSuppressed(issue('MOCK-001', 1), state)).toBe(true);
    expect(isSuppressed(issue('TAUT-002', 5), state)).toBe(false);
  });

  it('suppresses a finding reported at file scope, which no line comment can precede', () => {
    const state = buildSuppressionState([banner('// @momus-ignore-file:MOCK-001,MOCK-002')], FILE);
    expect(isSuppressed(issue('MOCK-002', 1), state)).toBe(true);
  });

  it('keeps the bare banner suppressing everything', () => {
    const state = buildSuppressionState([banner('// @momus-ignore-file')], FILE);
    expect(isSuppressed(issue('TAUT-002', 5), state)).toBe(true);
  });

  it('lets a bare banner outrank a rule-scoped one in either order', () => {
    const scopedFirst = buildSuppressionState(
      [banner('// @momus-ignore-file:MOCK-001'), banner('// @momus-ignore-file', 2)],
      FILE,
    );
    const bareFirst = buildSuppressionState(
      [banner('// @momus-ignore-file'), banner('// @momus-ignore-file:MOCK-001', 2)],
      FILE,
    );
    expect(isSuppressed(issue('TAUT-002', 5), scopedFirst)).toBe(true);
    expect(isSuppressed(issue('TAUT-002', 5), bareFirst)).toBe(true);
  });

  it('unions two rule-scoped banners', () => {
    const state = buildSuppressionState(
      [banner('// @momus-ignore-file:MOCK-001'), banner('// @momus-ignore-file:TAUT-002', 2)],
      FILE,
    );
    expect(isSuppressed(issue('MOCK-001', 1), state)).toBe(true);
    expect(isSuppressed(issue('TAUT-002', 5), state)).toBe(true);
    expect(isSuppressed(issue('DRIFT-001', 5), state)).toBe(false);
  });

  it('ignores a rule-scoped banner below the 10-line window', () => {
    const state = buildSuppressionState([banner('// @momus-ignore-file:MOCK-001', 11)], FILE);
    expect(isSuppressed(issue('MOCK-001', 1), state)).toBe(false);
  });
});
