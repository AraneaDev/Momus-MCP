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
  it('rejects lookalikes and plain comments', () => {
    expect(parseSuppression(raw('// @momus-ignoree', 1))).toBeNull();
    expect(parseSuppression(raw('// regular comment', 2))).toBeNull();
    expect(parseSuppression(raw('// @momus-ignore:TAUT-002 extra text', 3))).toBeNull();
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
    expect(isSuppressed(issue('TAUT-004', 16), state)).toBe(false);
  });

  it('docblock without a following fn suppresses its own line', () => {
    const state = buildSuppressionState([raw('/** @momus-ignore */', 8, 'docblock')], '/ws/t.ts');
    expect(isSuppressed(issue('TAUT-002', 8), state)).toBe(true);
    expect(isSuppressed(issue('TAUT-002', 9), state)).toBe(false);
  });
});
