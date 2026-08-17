import { describe, expect, it } from 'vitest';
import { parsePython, walk, childField, textOf, start, type SyntaxNode } from '../src/tree.ts';

describe('python tree helpers', () => {
  it('parses and locates a function definition', () => {
    const { root, hasError } = parsePython('def f(x: int) -> int:\n    return x\n');
    expect(hasError).toBe(false);
    const nodes: SyntaxNode[] = [];
    walk(root, (n) => nodes.push(n));
    const fn = nodes.find((n) => n.type === 'function_definition')!;
    expect(fn).toBeDefined();
    expect(textOf(childField(fn, 'name'))).toBe('f');
    expect(start(fn).line).toBe(0);
  });

  it('reads the return_type field source text', () => {
    const { root } = parsePython('def f() -> list[int]:\n    pass\n');
    const nodes: SyntaxNode[] = [];
    walk(root, (n) => nodes.push(n));
    const fn = nodes.find((n) => n.type === 'function_definition')!;
    expect(textOf(childField(fn, 'return_type'))).toBe('list[int]');
  });

  it('reports parse errors', () => {
    const { hasError } = parsePython('def f(:');
    expect(hasError).toBe(true);
  });
});
