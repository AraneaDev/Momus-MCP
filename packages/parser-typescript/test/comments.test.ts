import { describe, expect, it } from 'vitest';
import { extractComments } from '../src/comments.ts';

describe('extractComments', () => {
  it('skips line comments that sit inside a block comment', () => {
    const src = '/* outer\n// not a real comment\n*/\nconst a = 1;';
    const comments = extractComments(src);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.kind).toBe('docblock');
    expect(comments[0]!.text).toContain('// not a real comment'); // part of the block, not a line comment
    expect(comments[0]!.line).toBe(1);
  });

  it('flags trailing comments and own-line comments distinctly', () => {
    const src = 'const x = 1; // trailing\n// own line\nconst y = 2;';
    const comments = extractComments(src);
    const lines = comments.filter((c) => c.kind === 'line');
    expect(lines.map((c) => ({ text: c.text, trailing: c.trailing }))).toEqual([
      { text: '// trailing', trailing: true },
      { text: '// own line', trailing: false },
    ]);
  });

  it('ignores /* inside a string when detecting block comments', () => {
    const src = "const s = '/* not a block'; // real line comment";
    const comments = extractComments(src);
    const line = comments.find((c) => c.kind === 'line');
    expect(line?.text).toBe('// real line comment');
    expect(line?.trailing).toBe(true);
    // no docblock was opened by the /* inside the string
    expect(comments.filter((c) => c.kind === 'docblock')).toHaveLength(0);
  });

  it('handles escaped quotes and backticks before a comment', () => {
    const src = "const s = 'it\\'s /* not a block'; // comment";
    const comments = extractComments(src);
    expect(comments.filter((c) => c.kind === 'docblock')).toHaveLength(0);
    expect(comments.find((c) => c.kind === 'line')?.text).toBe('// comment');
  });

  it('extracts docblocks alongside line comments with 1-based lines', () => {
    const src = '/** @momus-ignore */\nfunction f() {}\n// line';
    const comments = extractComments(src);
    const doc = comments.find((c) => c.kind === 'docblock');
    const line = comments.find((c) => c.kind === 'line');
    expect(doc?.line).toBe(1);
    expect(doc?.text).toBe('/** @momus-ignore */');
    expect(line?.line).toBe(3);
    expect(line?.trailing).toBe(false);
  });
});
