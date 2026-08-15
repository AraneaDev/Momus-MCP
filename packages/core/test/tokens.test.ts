import { describe, expect, it } from 'vitest';
import { estimateTokens, renderIssueLine, issueTokens, assertTokenBudget, toRel } from '../src/tokens.ts';
import type { Issue } from '../src/ir.ts';

const MAX = 100;

function makeIssue(message: string): Issue {
  return {
    id: 'i', rule: 'TAUT-002', severity: 'warning',
    span: { file: '/ws/tests/ledger.test.ts', startLine: 23, startCol: 5, endLine: 23, endCol: 30 },
    message, tokens: 0,
    fix: { kind: 'replace', code: '', description: 'assert against a production-derived value' },
  };
}

describe('estimateTokens', () => {
  it('is a conservative ~4 chars/token plus overhead', () => {
    expect(estimateTokens('a')).toBeGreaterThan(0);
    expect(estimateTokens('short message')).toBeLessThan(estimateTokens('a '.repeat(100)));
  });
});

describe('renderIssueLine / issueTokens', () => {
  it('renders the canonical line with fix', () => {
    const line = renderIssueLine(makeIssue('mock-echo: asserts stubbed value (42) against itself'), '/ws');
    expect(line).toContain('tests/ledger.test.ts:23:5 [TAUT-002] warning');
    expect(line).toContain('fix: assert against a production-derived value');
  });

  it('stays under the 100-token contract for real messages', () => {
    const line = renderIssueLine(makeIssue('mock-echo: asserts stubbed value (42) against itself'), '/ws');
    expect(estimateTokens(line)).toBeLessThan(MAX);
    expect(() => assertTokenBudget(line, MAX)).not.toThrow();
    expect(issueTokens(makeIssue('mock-echo: asserts stubbed value (42) against itself'), '/ws')).toBeLessThan(MAX);
  });

  it('assertTokenBudget throws on violations', () => {
    expect(() => assertTokenBudget('x '.repeat(500), 50)).toThrow(/token budget/);
  });
});

describe('toRel', () => {
  it('strips the workspace root and normalizes separators', () => {
    expect(toRel('/ws/tests/a.test.ts', '/ws')).toBe('tests/a.test.ts');
    expect(toRel('C:\\ws\\tests\\a.test.ts', 'C:\\ws')).toBe('tests/a.test.ts');
  });
});
