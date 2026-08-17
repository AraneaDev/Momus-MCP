import { describe, expect, it } from 'vitest';
import { matchGlob, anyMatch } from '../src/glob.ts';

describe('matchGlob(pattern, path)', () => {
  it('matches literal paths', () => {
    expect(matchGlob('src/ledger.ts', 'src/ledger.ts')).toBe(true);
    expect(matchGlob('src/ledger.ts', 'src/other.ts')).toBe(false);
  });

  it('matches single-segment stars', () => {
    expect(matchGlob('src/*.ts', 'src/ledger.ts')).toBe(true);
    expect(matchGlob('src/*.ts', 'src/ledger.js')).toBe(false);
    expect(matchGlob('src/*.ts', 'src/a/ledger.ts')).toBe(false); // * stays in segment
  });

  it('matches double-star across segments', () => {
    expect(matchGlob('**/*.test.ts', 'src/a/b/ledger.test.ts')).toBe(true);
    expect(matchGlob('**/*.test.ts', 'ledger.test.ts')).toBe(true);
    expect(matchGlob('**/*.test.ts', 'src/a/b/ledger.ts')).toBe(false);
    expect(matchGlob('**/node_modules/**', 'node_modules/x/y.ts')).toBe(true);
    expect(matchGlob('**/node_modules/**', 'src/node_modules/x/y.ts')).toBe(true);
  });

  it('matches {a,b} alternation', () => {
    expect(matchGlob('src/*.{test,spec}.ts', 'src/a.test.ts')).toBe(true);
    expect(matchGlob('src/*.{test,spec}.ts', 'src/a.spec.ts')).toBe(true);
    expect(matchGlob('src/*.{test,spec}.ts', 'src/a.ts')).toBe(false);
  });

  it('matches ? single characters within a segment', () => {
    expect(matchGlob('src/a?c.ts', 'src/abc.ts')).toBe(true);
    expect(matchGlob('src/a?c.ts', 'src/abbc.ts')).toBe(false);
    expect(matchGlob('src/?', 'src/x')).toBe(true);
    expect(matchGlob('src/?', 'src/x/y')).toBe(false); // ? never crosses '/'
  });

  it('matches [abc] character classes', () => {
    expect(matchGlob('src/[ab].ts', 'src/a.ts')).toBe(true);
    expect(matchGlob('src/[ab].ts', 'src/b.ts')).toBe(true);
    expect(matchGlob('src/[ab].ts', 'src/c.ts')).toBe(false);
    // kills the mutations that treat EVERY char as a class start (if (true) / c !== '['):
    // a class followed by a wildcard must still let the wildcard see the rest of the name.
    expect(matchGlob('src/[a]*.ts', 'src/ab.ts')).toBe(true);
    // a literal ']' outside a class must stay literal, not be swept into a fake class slice.
    expect(matchGlob('src/?].ts', 'src/x].ts')).toBe(true);
  });

  it('treats unbalanced special chars as literals', () => {
    expect(matchGlob('src/a{b.ts', 'src/a{b.ts')).toBe(true);
    expect(matchGlob('src/a[b.ts', 'src/a[b.ts')).toBe(true);
  });

  it('normalizes windows separators', () => {
    expect(matchGlob('**/*.test.ts', 'src\\a\\ledger.test.ts')).toBe(true);
    // path normalization: 'src\\a.ts' must normalize to 'src/a.ts' and match (real bug
    // found by mutation testing — only the pattern side was normalized before).
    expect(matchGlob('src/a.ts', 'src\\a.ts')).toBe(true);
    // pattern normalization: a backslash pattern must match a backslash path — kills the
    // mutation that REMOVES backslashes instead of replacing them with '/'.
    expect(matchGlob('src\\a.ts', 'src\\a.ts')).toBe(true);
  });

  it('rejects empty patterns', () => {
    expect(matchGlob('', 'anything')).toBe(false);
  });
});

describe('anyMatch', () => {
  it('matches when any pattern matches', () => {
    expect(anyMatch(['**/a.ts', '**/b.ts'], 'src/b.ts')).toBe(true);
    expect(anyMatch(['**/a.ts'], 'src/b.ts')).toBe(false);
    expect(anyMatch([], 'src/b.ts')).toBe(false);
  });
});
