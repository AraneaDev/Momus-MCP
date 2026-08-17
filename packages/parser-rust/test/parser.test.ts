import { describe, expect, it } from 'vitest';
import { RustParser } from '../src/index.ts';

const ctx = { config: {}, resolveImport: () => null };

describe('RustParser', () => {
  it('marks a #[test] fn as a test module', () => {
    const m = new RustParser().parseModule('/c/src/t.rs', '#[test]\nfn t() { assert_eq!(1, 1); }\n', ctx);
    expect(m.kind).toBe('test');
    expect(m.language).toBe('rust');
  });

  it('marks plain production code as production', () => {
    const m = new RustParser().parseModule('/c/src/lib.rs', 'pub fn add(a: u32, b: u32) -> u32 { a + b }\n', ctx);
    expect(m.kind).toBe('production');
    expect(m.symbols.map((s) => s.name)).toContain('add');
  });

  it('emits a SYS-001 diagnostic for bad syntax', () => {
    const m = new RustParser().parseModule('/c/src/broken.rs', 'fn broken( {', ctx);
    expect(m.diagnostics[0]?.message).toContain('SYS-001');
  });
});
