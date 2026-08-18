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

  it('marks a compile-only integration test under tests/ as a test module', () => {
    // Rust integration tests live in tests/ and need no #[test] fn (compile-only checks).
    const m = new RustParser().parseModule(
      '/c/tests/automock_compile.rs',
      '#[automock]\ntrait A { fn bar() -> u32; }\n',
      ctx,
    );
    expect(m.kind).toBe('test');
  });

  it('emits a SYS-001 diagnostic for bad syntax', () => {
    const m = new RustParser().parseModule('/c/src/broken.rs', 'fn broken( {', ctx);
    expect(m.diagnostics[0]?.message).toContain('SYS-001');
  });

  it('tolerates items the wasm serializer models as opaque (extern crate)', () => {
    // `extern crate` (and other un-modeled items) previously crashed attrsOf with
    // `Cannot read properties of undefined (reading 'some')` — the whole file degraded to SYS-001.
    const m = new RustParser().parseModule(
      '/c/tests/lib.rs',
      '#[macro_use]\nextern crate serde_json;\n\nuse mockito::Server;\n\n#[test]\nfn t() { let s = Server::new(); s.mock("GET", "/").create(); }\n',
      ctx,
    );
    expect(m.diagnostics).toHaveLength(0);
    expect(m.kind).toBe('test');
    expect(m.functions).toHaveLength(1);
  });
});
