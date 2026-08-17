import { describe, expect, it } from 'vitest';
import { parseRust } from '../src/wasm.ts';

describe('parseRust', () => {
  it('parses a function with a typed signature', () => {
    const file = parseRust('pub fn add(a: u32, b: u32) -> u32 { a + b }\n');
    const f = file.items.find((i) => i.kind === 'fn');
    expect(f).toBeDefined();
    if (f && f.kind === 'fn') {
      expect(f.name).toBe('add');
      expect(f.sig.params).toHaveLength(2);
      expect(f.sig.returnType?.text).toBe('u32');
    }
  });

  it('returns an error string for invalid syntax', () => {
    const file = parseRust('fn broken( {');
    expect(file.error).toBeDefined();
  });

  it('carries accurate 1-based line/column spans', () => {
    const file = parseRust('pub fn add(a: u32) -> u32 { a }\n');
    const f = file.items[0];
    if (f && f.kind === 'fn') {
      expect(f.span.line).toBe(1);
      expect(f.span.column).toBeGreaterThan(0);
    }
  });
});
