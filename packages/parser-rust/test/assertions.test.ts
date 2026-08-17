import { describe, expect, it } from 'vitest';
import { parseRust } from '../src/wasm.ts';
import { extractAssertions, extractTestFunctions } from '../src/assertions.ts';

describe('extractAssertions', () => {
  it('extracts assert_eq! operands', () => {
    const file = parseRust(`#[test]\nfn t() { let a = 1; assert_eq!(a, a); }\n`);
    const asr = extractAssertions(file, '/c/src/t.rs');
    expect(asr).toHaveLength(1);
    expect(asr[0]!.api).toBe('assert_eq');
    expect(asr[0]!.operands.map((o) => o.text)).toEqual(['a', 'a']);
  });

  it('extracts assert!(x == y) operands from the comparison', () => {
    const file = parseRust(`#[test]\nfn t() { assert!(left == right); }\n`);
    const asr = extractAssertions(file, '/c/src/t.rs');
    expect(asr[0]!.operands.map((o) => o.text)).toEqual(['left', 'right']);
  });
});

describe('extractTestFunctions', () => {
  it('counts test functions and their assertions', () => {
    const file = parseRust(
      `#[cfg(test)]\nmod tests {\n  #[test]\n  fn a() { assert_eq!(1, 1); assert!(2 == 2); }\n}\n`,
    );
    const fns = extractTestFunctions(file, '/c/src/t.rs');
    expect(fns).toHaveLength(1);
    expect(fns[0]!.assertionCount).toBe(2);
  });

  it('flags #[should_panic] test functions', () => {
    const file = parseRust(`#[test]\n#[should_panic(expected = "fails as designed")]\nfn a() { assert_eq!(1, 1); }\n`);
    const fns = extractTestFunctions(file, '/c/src/t.rs');
    expect(fns[0]!.shouldPanic).toBe(true);
  });

  it('leaves shouldPanic false for ordinary tests', () => {
    const file = parseRust(`#[test]\nfn a() { assert_eq!(1, 1); }\n`);
    const fns = extractTestFunctions(file, '/c/src/t.rs');
    expect(fns[0]!.shouldPanic).toBe(false);
  });
});
