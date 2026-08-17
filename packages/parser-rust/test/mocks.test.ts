import { describe, expect, it } from 'vitest';
import { parseRust } from '../src/wasm.ts';
import { extractMocks } from '../src/mocks.ts';
import { RustCrateIndex } from '../src/crateIndex.ts';

const idx = () =>
  new RustCrateIndex([{ path: '/c/src/repo.rs', source: 'pub trait Repo { fn find(&self, id: u32) -> u32; }\n' }]);

describe('extractMocks (mockall)', () => {
  it('detects a MockRepo::new() mock with expect_.returning and resolves the target', () => {
    const file = parseRust(`
use crate::repo::Repo;
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn t() {
        let mut m = MockRepo::new();
        m.expect_find().returning(|id| id + 1);
    }
}
`);
    const mocks = extractMocks(file, '/c/src/test.rs', idx());
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.pattern).toBe('automock');
    expect(mocks[0]!.framework).toBe('mockall');
    expect(mocks[0]!.target?.symbolId).toBe('/c/src/repo.rs#Repo');
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toContain('find');
  });

  it('records a return_const literal as a configured value', () => {
    const file = parseRust(
      `use crate::repo::Repo;\n#[test]\nfn t() { let mut m = MockRepo::new(); m.expect_find().return_const("nope"); }\n`,
    );
    const mocks = extractMocks(file, '/c/src/test.rs', idx());
    const find = mocks[0]!.stubbedMembers.find((s) => s.name === 'find');
    expect(find?.returnValues[0]?.value).toEqual({ kind: 'literal', value: 'nope' });
  });

  it('parses a mock! macro targeting a trait with stubbed members', () => {
    const file = parseRust(
      `mock! {\n    pub Foo {\n        fn bar(&self, x: u32) -> u32;\n    }\n    impl Trait for Foo {\n        fn baz(&self) -> i32;\n    }\n}\n`,
    );
    const mocks = extractMocks(file, '/c/src/test.rs', idx());
    expect(mocks[0]!.pattern).toBe('mock-macro');
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['bar', 'baz']);
  });
});
