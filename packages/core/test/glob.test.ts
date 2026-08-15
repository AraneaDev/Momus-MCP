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

  it('matches character classes', () => {
    expect(matchGlob('src/*.{test,spec}.ts', 'src/a.test.ts')).toBe(true);
    expect(matchGlob('src/*.{test,spec}.ts', 'src/a.spec.ts')).toBe(true);
    expect(matchGlob('src/*.{test,spec}.ts', 'src/a.ts')).toBe(false);
  });

  it('normalizes windows separators', () => {
    expect(matchGlob('**/*.test.ts', 'src\\a\\ledger.test.ts')).toBe(true);
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
