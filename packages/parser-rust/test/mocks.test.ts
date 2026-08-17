import { describe, expect, it } from 'vitest';
import { parseRust } from '../src/wasm.ts';
import { extractMocks } from '../src/mocks.ts';

describe('extractMocks (mockall)', () => {
  it('detects a MockRepo::new() mock with expect_.returning and a bare exportName target', () => {
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
    const mocks = extractMocks(file, '/c/src/test.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.pattern).toBe('automock');
    expect(mocks[0]!.framework).toBe('mockall');
    expect(mocks[0]!.target?.kind).toBe('class');
    expect(mocks[0]!.target?.exportName).toBe('Repo');
    expect(mocks[0]!.target?.symbolId).toBeUndefined();
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toContain('find');
  });

  it('records a return_const literal as a configured value', () => {
    const file = parseRust(
      `use crate::repo::Repo;\n#[test]\nfn t() { let mut m = MockRepo::new(); m.expect_find().return_const("nope"); }\n`,
    );
    const mocks = extractMocks(file, '/c/src/test.rs');
    const find = mocks[0]!.stubbedMembers.find((s) => s.name === 'find');
    expect(find?.returnValues[0]?.value).toEqual({ kind: 'literal', value: 'nope' });
  });

  it('maps a mock! struct to its implemented trait via MockFoo::new()', () => {
    const file = parseRust(`
mock! {
    pub Foo { }
    impl Trait for Foo {
        fn baz(&self) -> i32;
    }
}
#[test]
fn t() {
    let mut m = MockFoo::new();
    m.expect_baz().returning(1);
}
`);
    const mocks = extractMocks(file, '/c/src/test.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.pattern).toBe('mock-macro');
    expect(mocks[0]!.target?.exportName).toBe('Trait');
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['baz']);
  });

  it('emits no target for a self-defined mock! struct (inherent methods only)', () => {
    const file = parseRust(`
mock! {
    Foo {
        fn bar(&self) -> u32;
    }
}
#[test]
fn t() {
    let mut m = MockFoo::new();
    m.expect_bar().returning(42);
}
`);
    const mocks = extractMocks(file, '/c/src/test.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.pattern).toBe('mock-macro');
    expect(mocks[0]!.target?.exportName).toBeUndefined();
  });

  it('associates a wrapped mock (Box::new(MockFoo::new())) with its binding', () => {
    const file = parseRust(`
#[test]
fn t() {
    let mut m = Box::new(MockRepo::new());
    m.expect_find().returning(|_| 1);
    let got = m.find(1);
}
`);
    const mocks = extractMocks(file, '/c/src/test.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.target?.exportName).toBe('Repo');
    expect(mocks[0]!.invocationSites.length).toBeGreaterThan(0);
  });

  it('records an invocation site when a bound mock variable is actually called', () => {
    const file = parseRust(`
#[test]
fn t() {
    let mut m = MockRepo::new();
    m.expect_find().returning(|id| id + 1);
    let got = m.find(1);
}
`);
    const mocks = extractMocks(file, '/c/src/test.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.invocationSites.length).toBeGreaterThan(0);
  });

  it('does not record an invocation for expect_* configuration', () => {
    const file = parseRust(`
#[test]
fn t() {
    let mut m = MockRepo::new();
    m.expect_find().returning(|id| id + 1);
}
`);
    const mocks = extractMocks(file, '/c/src/test.rs');
    expect(mocks[0]!.invocationSites).toHaveLength(0);
  });

  it('detects a mockito route mock', () => {
    const file = parseRust(
      `#[test]\nfn t() { let m = mock("GET", "/users").with_status(200).create(); m.assert(); }\n`,
    );
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks.some((m) => m.pattern === 'mockito' && m.target?.specifier === '/users')).toBe(true);
  });

  it('detects a wiremock expectation', () => {
    const file = parseRust(
      `#[test]\nfn t() { Mock::given(method("GET")).and(path("/x")).respond_with(ResponseTemplate::new(200)); }\n`,
    );
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks.some((m) => m.pattern === 'wiremock' && m.target?.specifier === '/x')).toBe(true);
  });

  it('records an invocation site through a Box re-binding', () => {
    const file = parseRust(
      `#[test]\nfn t() {\n  let mock = MockRepo::new();\n  mock.expect_fetch().returning(|| 1);\n  let boxed: Box<dyn Repo> = Box::new(mock);\n  assert_eq!(1, boxed.fetch());\n}\n`,
    );
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks[0]!.invocationSites.length).toBeGreaterThan(0);
  });

  it('marks a mock reached when consumed by value', () => {
    const file = parseRust(
      `#[test]\nfn t() {\n  let mock = MockRepo::new();\n  mock.expect_fetch().returning(|| 1);\n  block_on(mock);\n}\n`,
    );
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks[0]!.invocationSites.length).toBeGreaterThan(0);
  });
});
