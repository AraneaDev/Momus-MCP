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

  it('captures return_once / returning_st return values like returning', () => {
    const file = parseRust(
      `#[test]\nfn t() {\n  let mut m = MockFoo::new();\n  m.expect_bar().return_once(42);\n  m.expect_baz().returning_st(|| 7);\n}\n`,
    );
    const mocks = extractMocks(file, '/c/src/t.rs');
    const bar = mocks[0]!.stubbedMembers.find((s) => s.name === 'bar');
    const baz = mocks[0]!.stubbedMembers.find((s) => s.name === 'baz');
    expect(bar?.returnValues[0]?.value).toEqual({ kind: 'literal', value: 42 });
    expect(bar?.returnValues[0]?.api).toBe('return_once');
    expect(baz?.returnValues).toHaveLength(1);
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

  it('emits no target for a generic mock! struct with a where clause', () => {
    // `Foo<T> where T: Clone { … }` — the where clause between the generics and the body used to
    // defeat the struct regex, so MockFoo::new() fell through to `automock` with exportName Foo
    // and resolved against an unrelated production Foo (docs/11 row 60).
    const file = parseRust(`
mock! {
    Foo<T> where T: Clone {
        fn foo(&self, t: T) -> T;
    }
}
#[test]
fn t() {
    let mut m = MockFoo::new();
    m.expect_foo().returning(|t: u32| t.clone());
}
`);
    const mocks = extractMocks(file, '/c/src/test.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.pattern).toBe('mock-macro');
    expect(mocks[0]!.target?.exportName).toBeUndefined();
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['foo']);
  });

  it('maps a generic mock! impl with a where clause to its trait', () => {
    const file = parseRust(`
mock! {
    Foo<T> where T: Clone {
        fn foo(&self, t: T) -> T;
    }
    impl<T> Bar for Foo<T> where T: Clone {
        fn bar(&self);
    }
}
#[test]
fn t() {
    let mut m = MockFoo::new();
    m.expect_bar().returning(|| ());
}
`);
    const mocks = extractMocks(file, '/c/src/test.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.pattern).toBe('mock-macro');
    expect(mocks[0]!.target?.exportName).toBe('Bar');
    // the inherent `foo` is mock-local; only the trait-side `bar` is drift-checkable
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['bar']);
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

  it('detects a wiremock chain ended with .await in an async test (transparent await)', () => {
    const file = parseRust(
      `#[tokio::test]\nasync fn t() {\n  Mock::given(method("GET")).and(path("/a")).respond_with(ResponseTemplate::new(200)).mount(&s).await;\n}\n`,
    );
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks.some((m) => m.pattern === 'wiremock' && m.target?.specifier === '/a')).toBe(true);
  });

  it('detects the fully-qualified mockito::mock form', () => {
    const file = parseRust(`#[test]\nfn t() { mockito::mock("GET", "/users2").with_status(200).create(); }\n`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks.some((m) => m.pattern === 'mockito' && m.target?.specifier === '/users2')).toBe(true);
  });

  it('detects mockito server.mock("GET", "/x") method calls (the primary API)', () => {
    const file = parseRust(
      `#[test]\nfn t() { let s = Server::new(); s.mock("GET", "/x").with_body("ok").create(); }\n`,
    );
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks.some((m) => m.pattern === 'mockito' && m.target?.specifier === '/x')).toBe(true);
  });

  it('detects an httpmock server.mock(|when, then| …) closure and extracts when.path', () => {
    const file = parseRust(
      `#[test]\nfn t() {\n  let server = MockServer::start();\n  let m = server.mock(|when, then| { when.path("/x"); then.status(200); });\n  m.assert();\n}\n`,
    );
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks.some((m) => m.pattern === 'httpmock' && m.target?.specifier === '/x')).toBe(true);
  });

  it('still counts an httpmock closure mock without a when.path route', () => {
    const file = parseRust(
      `#[test]\nfn t() {\n  let server = MockServer::start();\n  let m = server.mock(|when, then| { when.port(0); then.status(200); });\n  m.assert();\n}\n`,
    );
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks.some((m) => m.pattern === 'httpmock')).toBe(true);
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

  it('records an invocation for a trait-qualified call (`Foo::foo(&mock)`)', () => {
    const file = parseRust(
      `#[test]\nfn t() {\n  let mut mock = MockSomeStruct::new();\n  mock.expect_foo().returning(42);\n  assert_eq!(5, Foo::foo(&mock, 4));\n}\n`,
    );
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks[0]!.invocationSites.length).toBeGreaterThan(0);
  });

  it('records an invocation for a UFCS call (`<Mock as Foo>::foo(&mock, …)`)', () => {
    const file = parseRust(
      `#[test]\nfn t() {\n  let mut mock = MockSomeStruct::<u32>::new();\n  mock.expect_foo().returning(|t| t);\n  assert_eq!(4, <MockSomeStruct<u32> as Foo<u32>>::foo(&mock, 4));\n}\n`,
    );
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks[0]!.invocationSites.length).toBeGreaterThan(0);
  });

  it('descends into unsafe blocks so `unsafe { mock.bar(…) }` counts as an invocation', () => {
    const file = parseRust(
      `#[test]\nfn t() {\n  let mut mock = MockFoo::new();\n  mock.expect_bar().returning(|x| {*x = 42;});\n  unsafe { mock.bar(&mut x); }\n}\n`,
    );
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks[0]!.invocationSites.length).toBeGreaterThan(0);
  });

  it('links a mock to its enclosing test fn id', () => {
    const file = parseRust(`
#[test]
fn t() {
    let mut m = MockRepo::new();
    m.expect_find().returning(|id| id + 1);
    let got = m.find(1);
}
`);
    const mocks = extractMocks(file, '/c/src/test.rs');
    expect(mocks[0]!.fnId).toBe('/c/src/test.rs#fn:3');
  });

  it('resolves &mut mock passed by reference to a trait-qualified call', () => {
    const file = parseRust(
      `#[test]\nfn t() {\n  let mut mock = MockRepo::new();\n  mock.expect_foo().returning(|x: &mut u32| {});\n  Foo::foo(&mut mock, 5);\n}\n`,
    );
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks[0]!.invocationSites.length).toBeGreaterThan(0);
  });

  it('does not mark a mock reached by an arg-less qualified static call', () => {
    const file = parseRust(
      `#[test]\nfn t() {\n  let mut mock = MockFoo::new();\n  mock.expect_bar().return_const(42);\n  assert_eq!(42, MockFoo::bar());\n}\n`,
    );
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks[0]!.invocationSites).toHaveLength(0);
  });

  it('detects a static-method context (MockFoo::baz_context) and binds ctx.expect()', () => {
    const file = parseRust(`
trait Bar { fn baz(x: u32) -> u64; }
mock! {
    pub Foo { }
    impl Bar for Foo {
        fn baz(x: u32) -> u64;
    }
}
#[test]
fn returning() {
    let ctx = MockFoo::baz_context();
    ctx.expect().returning(|x| u64::from(x + 1));
    assert_eq!(42, MockFoo::baz(41));
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.pattern).toBe('mock-macro');
    expect(mocks[0]!.target?.exportName).toBe('Bar');
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['baz']);
    // the configured closure is non-literal, but still recorded as a return value
    expect(mocks[0]!.stubbedMembers[0]!.returnValues).toHaveLength(1);
    // the direct `MockFoo::baz(41)` invocation reaches the static mock
    expect(mocks[0]!.invocationSites.length).toBeGreaterThan(0);
  });

  it('captures return_const on a static-method context as a literal', () => {
    const file = parseRust(`
#[automock]
trait Foo { fn bar() -> u32; }
#[test]
fn t() {
    let ctx = MockFoo::bar_context();
    ctx.expect().return_const(42u32);
    assert_eq!(42, MockFoo::bar());
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.target?.exportName).toBe('Foo');
    const bar = mocks[0]!.stubbedMembers.find((s) => s.name === 'bar');
    expect(bar?.returnValues[0]?.value).toEqual({ kind: 'literal', value: 42 });
    expect(mocks[0]!.invocationSites.length).toBeGreaterThan(0);
  });

  it('skips return-value recording for an inherent static mock (no drift target)', () => {
    // `mock! { pub Thing { fn private_deserialize(...) } }` has no trait target, and the method is
    // invoked indirectly through the SUT's own impl (serde's `impl Deserialize for MockThing`) —
    // so a zero-reach signal is unreliable. The stub stays (name only); no return value is recorded.
    const file = parseRust(`
mock! {
    pub Thing {
        fn private_deserialize(x: u32) -> Self;
    }
}
#[test]
fn t() {
    let ctx = MockThing::private_deserialize_context();
    ctx.expect().returning(|_| MockThing::default());
    let _thing: MockThing = serde_json::from_str("{}").unwrap();
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.target?.kind).toBe('unknown');
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['private_deserialize']);
    expect(mocks[0]!.stubbedMembers[0]!.returnValues).toHaveLength(0);
  });

  it('detects the module form mock_foo::bar_context() with no production target', () => {
    const file = parseRust(`
#[automock]
mod foo {
    pub fn bar(x: u32) -> i64 { unimplemented!() }
}
#[test]
fn t() {
    let ctx = mock_foo::bar_context();
    ctx.expect().returning(|x| i64::from(x));
    assert_eq!(5, mock_foo::bar(4));
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.pattern).toBe('automock');
    expect(mocks[0]!.target?.exportName).toBeUndefined();
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['bar']);
    expect(mocks[0]!.invocationSites.length).toBeGreaterThan(0);
  });

  it('normalizes raw identifiers when matching a static invocation', () => {
    const file = parseRust(`
#[automock]
trait r#while {
    fn r#loop();
}
#[test]
fn t() {
    let ctx = Mockwhile::loop_context();
    ctx.expect().returning(|| ());
    Mockwhile::r#loop();
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['loop']);
    expect(mocks[0]!.invocationSites.length).toBeGreaterThan(0);
  });

  it('marks a static mock reached when invoked through a function pointer', () => {
    const file = parseRust(`
#[automock]
mod ffi {
    pub fn foo(x: u32) -> i64 { unimplemented!() }
}
#[test]
fn t() {
    let ctx = mock_ffi::foo_context();
    ctx.expect().returning(i64::from);
    let p: fn(u32) -> i64 = mock_ffi::foo;
    assert_eq!(42, p(42));
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.invocationSites.length).toBeGreaterThan(0);
  });

  it('marks a mocked constructor reached via the UFCS form <MockA as A>::new()', () => {
    const file = parseRust(`
#[automock]
pub trait A {
    fn new() -> Self;
}
#[test]
fn t() {
    let ctx = MockA::new_context();
    ctx.expect().returning(MockA::default);
    let _a: MockA = <MockA as A>::new();
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['new']);
    expect(mocks[0]!.invocationSites.length).toBeGreaterThan(0);
  });

  it('collects mock! macros declared inside nested modules', () => {
    const file = parseRust(`
mod outer {
    mod inner {
        mock! {
            pub Foo { }
            impl Trait for Foo {
                fn baz(&self) -> i32;
            }
        }
    }
}
#[test]
fn t() {
    let mut m = MockFoo::new();
    m.expect_baz().returning(1);
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks[0]!.pattern).toBe('mock-macro');
    expect(mocks[0]!.target?.exportName).toBe('Trait');
  });
});

describe('extractMocks (mry)', () => {
  it('detects an instance mock_<method> on a #[mry::mry] struct with a type target', () => {
    const file = parseRust(`
#[mry::mry]
#[derive(Default)]
struct Cat {
    name: String,
}
#[mry::mry]
impl Cat {
    fn meow(&self, count: usize) -> String {
        "meow".repeat(count)
    }
}
#[test]
fn t() {
    let mut cat = Cat { name: "Tama".into(), ..Default::default() };
    cat.mock_meow(2).returns_with(|count| format!("meow {count}"));
    assert_eq!(cat.meow(2), "meow 2");
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.pattern).toBe('mry');
    expect(mocks[0]!.framework).toBe('mry');
    expect(mocks[0]!.target?.kind).toBe('class');
    expect(mocks[0]!.target?.exportName).toBe('Cat');
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['meow']);
    // invocation through the real `cat.meow(2)` call is marked reached
    expect(mocks[0]!.invocationSites.length).toBeGreaterThan(0);
  });

  it('detects the static Type::mock_<method> form and dedupes returns + assert_called', () => {
    const file = parseRust(`
#[mry::mry]
struct Cat {}
#[mry::mry]
impl Cat {
    fn meow(count: usize) -> String { "meow".repeat(count) }
}
#[test]
fn t() {
    Cat::mock_meow(mry::Any).returns("Called".to_string());
    Cat::meow(2);
    Cat::mock_meow(mry::Any).assert_called(1);
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    // one mock for the (static, meow) pair — the assert_called form reuses it
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.target?.exportName).toBe('Cat');
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['meow']);
  });

  it('detects the Mock<T>::mock_<method> constructor form and strips the Mock prefix', () => {
    const file = parseRust(`
#[mry::mry]
pub trait Cat {
    fn new(name: String) -> Self;
    fn meow(&self, count: usize) -> String;
}
#[test]
fn t() {
    let mut cat = MockCat::default();
    cat.mock_meow(mry::Any).returns("tama".to_string());
    MockCat::mock_new("Tama").returns(cat);
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(2);
    expect(mocks[0]!.target?.exportName).toBe('Cat');
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['meow']);
    expect(mocks[1]!.target?.exportName).toBe('Cat');
    expect(mocks[1]!.stubbedMembers.map((s) => s.name)).toEqual(['new']);
  });

  it('treats a free #[mry::mry] fn mock as untargeted (no member drift surface)', () => {
    const file = parseRust(`
#[mry::mry]
fn meow(base: &str) -> &str { base }
#[test]
fn t() {
    mock_meow(mry::Any).returns_with(|_| "a");
    assert_eq!(meow("a"), "a");
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.pattern).toBe('mry');
    expect(mocks[0]!.target?.kind).toBe('unknown');
    expect(mocks[0]!.stubbedMembers).toHaveLength(0);
  });

  it('detects the mry::m! function-style macro form', () => {
    const file = parseRust(`
mry::m! {
    #[derive(Default)]
    struct Cat {
        name: String,
    }
    impl Cat {
        fn meow(&self, count: usize) -> String {
            format!("{}", self.name)
        }
    }
}
#[test]
fn t() {
    let mut cat = Cat { name: "Tama".into(), ..Default::default() };
    cat.mock_meow(2).returns_with(|count| format!("meow {count}"));
    assert_eq!(cat.meow(2), "meow 2");
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.framework).toBe('mry');
    expect(mocks[0]!.target?.exportName).toBe('Cat');
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['meow']);
  });

  it('does not treat a mry MockCat::new() constructor as a mockall automock', () => {
    // mry's generated `Mock<Type>` type collides with mockall's `MockFoo::new()` — a mry file
    // must not emit a mockall mock for its own `MockCat::new(...)` constructor call.
    const file = parseRust(`
#[mry::mry]
pub trait Cat {
    fn new(name: String) -> Self;
}
#[test]
fn t() {
    let cat = MockCat::new("Tama".into());
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks.some((m) => m.framework === 'mockall')).toBe(false);
  });

  it('detects a cross-crate mock (no same-file #[mry::mry]) from Mock<Type>::default()', () => {
    // A type declared in a production crate and mocked in tests/ has no #[mry::mry] in the test
    // file — the receiver var must be bound from the generated `MockFoo::default()` constructor.
    const file = parseRust(`
use mry_crate_bound::Foo as _;
#[test]
fn t() {
    let mut mock = mry_crate_bound::MockFoo::default();
    mock.mock_foo().returns(42);
    assert_eq!(mock.foo(), 42);
}
`);
    const mocks = extractMocks(file, '/c/tests/probe.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.framework).toBe('mry');
    expect(mocks[0]!.target?.exportName).toBe('Foo');
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['foo']);
    expect(mocks[0]!.stubbedMembers[0]!.returnValues).toEqual([
      expect.objectContaining({ value: { kind: 'literal', value: 42 } }),
    ]);
    expect(mocks[0]!.invocationSites.length).toBeGreaterThan(0);
  });

  it('detects a cross-crate mock from the Mock<Type>::new(…) constructor (mockall skipped)', () => {
    // A file using mry's `mock_<method>` config claims `Mock<Type>::new(…)` for mry — the mockall
    // pass must not also emit an automock for the identical `MockFoo::new()` syntax.
    const file = parseRust(`
use mry_crate_bound::Foo as _;
#[test]
fn t() {
    let mut mock = mry_crate_bound::MockFoo::new("Tama");
    mock.mock_meow().returns(42);
    assert_eq!(mock.meow(), 42);
}
`);
    const mocks = extractMocks(file, '/c/tests/probe.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.framework).toBe('mry');
    expect(mocks[0]!.target?.exportName).toBe('Foo');
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['meow']);
  });

  it('detects a cross-crate mock from the mry::new!(Type { … }) constructor', () => {
    const file = parseRust(`
use mry_crate_bound::Foo;
#[test]
fn t() {
    let mut mock = mry::new!(Foo { a: 0 });
    mock.mock_no_args().returns(7);
    assert_eq!(mock.no_args(), 7);
}
`);
    const mocks = extractMocks(file, '/c/tests/probe.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.framework).toBe('mry');
    expect(mocks[0]!.target?.exportName).toBe('Foo');
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['no_args']);
  });

  it('records a literal returns(…) value for DRIFT-003 and skips non-literal returns', () => {
    const file = parseRust(`
#[mry::mry]
struct Cat {}
#[mry::mry]
impl Cat {
    fn meow(&self, count: usize) -> usize { count }
    fn name(&self) -> String { "Cat".to_string() }
}
#[test]
fn t() {
    let mut cat = mry::new!(Cat {});
    cat.mock_meow(mry::Any).returns(42);
    cat.mock_name().returns("Tama".to_string());
    cat.mock_name().returns_with(|| "Tama".to_string());
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    const meow = mocks.find((m) => m.stubbedMembers.some((s) => s.name === 'meow'))!;
    expect(meow.stubbedMembers.find((s) => s.name === 'meow')!.returnValues).toEqual([
      expect.objectContaining({ api: 'returns', value: { kind: 'literal', value: 42 } }),
    ]);
    // `.to_string()` / `returns_with(|| …)` are not literals — no value recorded (no false
    // DRIFT-003 surface, and no TAUT-005 churn from an `unknown` value).
    const name = mocks.find((m) => m.stubbedMembers.some((s) => s.name === 'name'))!;
    expect(name.stubbedMembers.find((s) => s.name === 'name')!.returnValues).toHaveLength(0);
  });

  it('marks a mock reached by a trait-qualified invocation (`Cat::meow(&cat, …)`)', () => {
    const file = parseRust(`
#[mry::mry]
trait Cat {
    async fn meow(&self, count: usize) -> &'static str;
}
#[test]
async fn t() {
    let mut cat = MockCat::default();
    cat.mock_meow(2).returns("Called");
    assert_eq!(Cat::meow(&cat, 2).await, "Called");
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['meow']);
    // the indirect `Cat::meow(&cat, 2)` invocation must mark the stub reached (no TAUT-005)
    expect(mocks[0]!.invocationSites.length).toBeGreaterThan(0);
  });
});

describe('extractMocks (faux)', () => {
  it('detects Foo::faux() + faux::when!(mock.method).then(...) with a type target', () => {
    const file = parseRust(`
#[faux::create]
pub struct Foo {
    a: u32,
}
#[faux::methods]
impl Foo {
    pub fn get_stuff(&self) -> u32 { self.a }
    pub fn add_stuff(&self, x: i32) -> i32 { self.a as i32 + x }
}
#[test]
fn t() {
    let mut mock = Foo::faux();
    faux::when!(mock.get_stuff).then(|_| 10);
    assert_eq!(mock.get_stuff(), 10);
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.framework).toBe('faux');
    expect(mocks[0]!.pattern).toBe('faux');
    expect(mocks[0]!.target?.exportName).toBe('Foo');
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['get_stuff']);
    expect(mocks[0]!.invocationSites.length).toBeGreaterThan(0);
  });

  it('extracts the method name from faux::when!(mock.method(...)) with args', () => {
    const file = parseRust(`
#[faux::create]
pub struct Foo { a: u32 }
#[faux::methods]
impl Foo {
    pub fn two_args(&self, a: i32, b: i32) -> i32 { a + b }
}
#[test]
fn t() {
    let mut mock = Foo::faux();
    faux::when!(mock.two_args(_, 4)).then_return(10);
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    // `two_args` (not `two_args (_, 4)`) must be the stub name.
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['two_args']);
  });

  it('resolves a path-qualified impl self-type (impl foo::Foo) to the Foo struct', () => {
    // faux's `paths.rs` has `#[faux::methods(path = "crate")] impl foo::Foo { fn get_chunk() }`
    // in a sibling module — the method must attach to Foo so DRIFT-001 stays quiet.
    const file = parseRust(`
mod foo {
    #[faux::create]
    pub struct Foo { f: &'static str }
    #[faux::methods]
    impl Foo {
        pub fn get(&self) -> &'static str { self.f }
    }
}
mod other {
    #[faux::methods]
    impl foo::Foo {
        pub fn get_chunk(&self, chunk: usize) -> &'static str { &self.get()[0..chunk] }
    }
}
#[test]
fn t() {
    let mut foo = foo::Foo::faux();
    faux::when!(foo.get_chunk).then(|_| "hello");
    assert_eq!(foo.get_chunk(1), "hello");
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.target?.exportName).toBe('Foo');
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['get_chunk']);
  });

  it('does not treat a faux ::faux() constructor as a mockall mock', () => {
    const file = parseRust(`
#[faux::create]
pub struct Foo { a: u32 }
#[test]
fn t() {
    let mut mock = Foo::faux();
    faux::when!(mock).then(|_| ());
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks.some((m) => m.framework === 'mockall')).toBe(false);
    expect(mocks.some((m) => m.framework === 'faux')).toBe(true);
  });

  it('records a then_return(…) literal for DRIFT-003 and skips closure returns', () => {
    const file = parseRust(`
#[faux::create]
pub struct Foo { a: u32 }
#[faux::methods]
impl Foo {
    pub fn no_args(&self) -> u32 { self.a }
    pub fn get_stuff(&self) -> u32 { self.a }
}
#[test]
fn t() {
    let mut mock = Foo::faux();
    faux::when!(mock.no_args()).then_return(10);
    faux::when!(mock.get_stuff).then(|_| 20);
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    const noArgs = mocks[0]!.stubbedMembers.find((s) => s.name === 'no_args')!;
    expect(noArgs.returnValues).toEqual([
      expect.objectContaining({ api: 'then_return', value: { kind: 'literal', value: 10 } }),
    ]);
    // `then(|_| …)` is a closure — no literal to compare.
    const getStuff = mocks[0]!.stubbedMembers.find((s) => s.name === 'get_stuff')!;
    expect(getStuff.returnValues).toHaveLength(0);
  });
});

describe('extractMocks (mockers)', () => {
  it('detects Scenario::create_mock_for::<dyn A>() with expect/and_return + invocation', () => {
    const file = parseRust(`
#[mocked]
trait A {
    fn baz(&self) -> u32;
    fn bar(&self, arg: u32);
}
#[test]
fn t() {
    let scenario = Scenario::new();
    let (mock, handle) = scenario.create_mock_for::<dyn A>();
    scenario.expect(handle.baz().and_return(2));
    scenario.expect(handle.bar(3).and_return(()));
    assert_eq!(2, mock.baz());
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.framework).toBe('mockers');
    expect(mocks[0]!.pattern).toBe('mockers');
    expect(mocks[0]!.target?.kind).toBe('class');
    expect(mocks[0]!.target?.exportName).toBe('A');
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['baz', 'bar']);
    const baz = mocks[0]!.stubbedMembers.find((s) => s.name === 'baz')!;
    expect(baz.returnValues).toEqual([
      expect.objectContaining({ api: 'and_return', value: { kind: 'literal', value: 2 } }),
    ]);
    // the real `mock.baz()` invocation marks the fake reached
    expect(mocks[0]!.invocationSites.length).toBeGreaterThan(0);
  });

  it('detects a cross-crate create_mock_for::<dyn ProdTrait>() (no in-file declaration)', () => {
    const file = parseRust(`
use prod::Foo;
#[test]
fn t() {
    let scenario = Scenario::new();
    let (mock, handle) = scenario.create_mock_for::<dyn Foo>();
    scenario.expect(handle.do_it().and_return(42));
    assert_eq!(mock.do_it(), 42);
}
`);
    const mocks = extractMocks(file, '/c/tests/probe.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.target?.exportName).toBe('Foo');
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['do_it']);
    expect(mocks[0]!.stubbedMembers[0]!.returnValues[0]?.value).toEqual({ kind: 'literal', value: 42 });
    expect(mocks[0]!.invocationSites.length).toBeGreaterThan(0);
  });

  it('strips the Mock suffix from create_mock::<FooMock>() (no #[mocked] in file)', () => {
    const file = parseRust(`
#[test]
fn t() {
    let scenario = Scenario::new();
    let (mock, handle) = scenario.create_mock::<FooMock>();
    scenario.expect(handle.foo().and_return(()));
}
`);
    const mocks = extractMocks(file, '/c/tests/probe.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.target?.exportName).toBe('Foo');
  });

  it('maps a mock! { Name, self, trait A {…} } and filters the mock-specific clone stub', () => {
    const file = parseRust(`
mock! {
    AMock,
    self,
    trait A {
        fn foo(&self, a: u32);
    }
}
#[test]
fn t() {
    let scenario = Scenario::new();
    let (mock, mock_handle) = scenario.create_mock::<AMock>();
    scenario.expect(mock_handle.clone().and_return(mock));
    scenario.expect(mock_handle.foo(2).and_return(()));
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.target?.exportName).toBe('A');
    // `clone` is added by mock_clone! (not a trait method) — filtered from drift surface
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['foo']);
  });

  it('emits no target for a multi-trait mock! (no single production type)', () => {
    const file = parseRust(`
mock! {
    BMock,
    self,
    trait A {
        fn foo(&self);
    },
    self,
    trait B {
        fn bar(&self);
    }
}
#[test]
fn t() {
    let scenario = Scenario::new();
    let (mock, handle) = scenario.create_mock::<BMock>();
    scenario.expect(handle.foo().and_return(()));
    scenario.expect(handle.bar().and_return(()));
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.target?.kind).toBe('unknown');
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['foo', 'bar']);
  });

  it('resolves a #[mocked(CustomName)] custom mock name to its trait', () => {
    const file = parseRust(`
#[mocked(MockForA)]
trait A {
    fn foo(&self);
}
#[test]
fn t() {
    let scenario = Scenario::new();
    let (mock, handle) = scenario.create_mock::<MockForA>();
    scenario.expect(handle.foo().and_return(()));
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.target?.exportName).toBe('A');
  });

  it('detects create_named_mock_for::<dyn A>(…)', () => {
    const file = parseRust(`
#[mocked]
trait A { fn foo(&self); }
#[test]
fn t() {
    let scenario = Scenario::new();
    let (mock, handle) = scenario.create_named_mock_for::<dyn A>("amock".to_owned());
    scenario.expect(handle.foo().and_return(()));
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.target?.exportName).toBe('A');
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['foo']);
  });
});

describe('extractMocks (mockiato)', () => {
  it('detects XMock::new() (suffix Mock) + expect_<m>().returns() + invocation', () => {
    const file = parseRust(`
#[mockable]
trait Greeter {
    fn greet(&self, name: &str) -> String;
}
#[test]
fn t() {
    let mut greeter = GreeterMock::new();
    greeter.expect_greet(|arg| arg.partial_eq("world")).returns("Hello world");
    assert_eq!("Hello world", greeter.greet("world"));
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.framework).toBe('mockiato');
    expect(mocks[0]!.pattern).toBe('mockiato');
    expect(mocks[0]!.target?.exportName).toBe('Greeter');
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['greet']);
    expect(mocks[0]!.stubbedMembers[0]!.returnValues[0]?.value).toEqual({
      kind: 'literal',
      value: 'Hello world',
    });
    expect(mocks[0]!.invocationSites.length).toBeGreaterThan(0);
  });

  it('detects XMock::default() and strips a module path', () => {
    const file = parseRust(`
#[test]
fn t() {
    let _ = foo::BarMock::default();
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.target?.exportName).toBe('Bar');
  });

  it('strips the _calls_in_order suffix from expect_<m>_calls_in_order', () => {
    const file = parseRust(`
#[mockable]
trait Foo { fn bar(&self) -> bool; }
#[test]
fn t() {
    let mut mock = FooMock::new();
    mock.expect_bar_calls_in_order();
    assert!(mock.bar());
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['bar']);
  });

  it('marks a mock reached when invoked inside a for loop (control-flow descent)', () => {
    const file = parseRust(`
#[mockable]
trait Foo { fn bar(&self) -> bool; }
#[test]
fn t() {
    let mut mock = FooMock::new();
    mock.expect_bar().returns(true);
    for _ in 0..3 {
        assert!(mock.bar());
    }
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks[0]!.invocationSites.length).toBeGreaterThan(0);
  });

  it('does not treat XMock::new() (suffix) as a mockall mock', () => {
    const file = parseRust(`
#[test]
fn t() {
    let mut greeter = GreeterMock::new();
    greeter.expect_greet().returns("hi");
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks.some((m) => m.framework === 'mockall')).toBe(false);
    expect(mocks.some((m) => m.framework === 'mockiato')).toBe(true);
  });
});

describe('extractMocks (mocktopus)', () => {
  it('detects a bare fn.mock_safe(…) with the function name as an informational target', () => {
    const file = parseRust(`
#[mockable]
pub fn world() -> &'static str { "world" }
#[test]
fn t() {
    world.mock_safe(|| MockResult::Return("mocking"));
    assert_eq!("mocking", world());
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.framework).toBe('mocktopus');
    expect(mocks[0]!.pattern).toBe('mocktopus');
    expect(mocks[0]!.target?.kind).toBe('unknown');
    expect(mocks[0]!.target?.exportName).toBe('world');
    // a function mock has no member drift surface, and the invocation is indirect (through the
    // SUT) — so no stubs / return values are recorded (no TAUT-005 churn)
    expect(mocks[0]!.stubbedMembers).toHaveLength(0);
  });

  it('detects a module-qualified fn and a static method via mock_raw', () => {
    const file = parseRust(`
#[mockable]
mod hello_world { pub fn world() -> &'static str { "world" } }
struct S;
#[mockable]
impl S { fn static_method() -> &'static str { "not mocked" } }
#[test]
fn t() {
    unsafe {
        hello_world::world.mock_raw(|| MockResult::Return("mocking"));
        S::static_method.mock_raw(|| MockResult::Return("mocked"));
    }
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    const names = mocks.map((m) => m.target?.exportName);
    expect(names).toContain('world');
    expect(names).toContain('static_method');
  });

  it('detects an instance method mock (receiver . method)', () => {
    const file = parseRust(`
struct S;
#[mockable]
impl S { fn ref_method(&self) -> &'static str { "not mocked" } }
#[test]
fn t() {
    let s = S;
    s.ref_method.mock_safe(|| MockResult::Return("mocked"));
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.target?.exportName).toBe('ref_method');
  });
});

describe('extractMocks (mock_derive)', () => {
  it('detects #[mock] trait + Mock<Name>::new() + method_<m>().set_result() + invocation', () => {
    const file = parseRust(`
#[mock]
pub trait CustomTrait {
    fn get_int(&self) -> u32;
}
#[test]
fn t() {
    let mut mock = MockCustomTrait::new();
    let method = mock.method_get_int().first_call().set_result(3);
    mock.set_get_int(method);
    assert_eq!(3, mock.get_int());
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.framework).toBe('mock_derive');
    expect(mocks[0]!.pattern).toBe('mock_derive');
    expect(mocks[0]!.target?.exportName).toBe('CustomTrait');
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['get_int']);
    expect(mocks[0]!.stubbedMembers[0]!.returnValues[0]?.value).toEqual({ kind: 'literal', value: 3 });
    expect(mocks[0]!.invocationSites.length).toBeGreaterThan(0);
  });

  it('strips turbofish generics from Mock<Name>::<...>::new()', () => {
    const file = parseRust(`
#[mock]
pub trait DatabaseDriver<T, U> { fn escaped_query(&self, s: &str, t: T) -> U; }
#[test]
fn t() {
    let mut mock = MockDatabaseDriver::<i32, i32>::new();
    mock.set_escaped_query(mock.method_escaped_query().called_once().set_result(7));
    mock.escaped_query("q", 5);
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.target?.exportName).toBe('DatabaseDriver');
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['escaped_query']);
  });

  it('detects a #[mock] extern block (Extern<Abi>Mocks::method_<fn>()) as an untargeted mock', () => {
    const file = parseRust(`
#[mock]
extern "C" {
    pub fn c_double(x: isize) -> isize;
    fn side_effect_fn(x: usize, y: usize);
}
#[test]
fn t() {
    let mock = ExternCMocks::method_c_double().first_call().set_result(2);
    ExternCMocks::set_c_double(mock);
    unsafe { assert_eq!(2, c_double(1)); }
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.framework).toBe('mock_derive');
    expect(mocks[0]!.target?.kind).toBe('unknown');
    expect(mocks[0]!.target?.exportName).toBe('c_double');
    expect(mocks[0]!.stubbedMembers).toHaveLength(0);
  });

  it('recognizes a cfg-gated #[cfg_attr(..., mock)] trait as mock_derive (not mockall)', () => {
    const file = parseRust(`
#[cfg_attr(feature = "nightly", mock)]
pub trait CustomTrait { fn get_int(&self) -> u32; }
#[test]
fn t() {
    let mut mock = MockCustomTrait::new();
    mock.set_get_int(mock.method_get_int().first_call().set_result(3));
    assert_eq!(3, mock.get_int());
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks.some((m) => m.framework === 'mockall')).toBe(false);
    expect(mocks.some((m) => m.framework === 'mock_derive')).toBe(true);
  });

  it('does not misattribute a mockall Mock<Name>::new() as mock_derive', () => {
    const file = parseRust(`
#[automock]
trait Repo { fn find(&self) -> u32; }
#[test]
fn t() {
    let mut m = MockRepo::new();
    m.expect_find().return_const(1);
    assert_eq!(1, m.find());
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks.some((m) => m.framework === 'mock_derive')).toBe(false);
    expect(mocks.some((m) => m.framework === 'mockall')).toBe(true);
  });

  it('records a literal return from return_result_of(|| <literal>) for DRIFT-003', () => {
    const file = parseRust(`
#[mock]
trait Foo { fn bar(&self) -> u32; }
#[test]
fn t() {
    let mut mock = MockFoo::new();
    mock.set_bar(mock.method_bar().return_result_of(|| 10));
    assert_eq!(10, mock.bar());
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks[0]!.stubbedMembers[0]!.returnValues[0]?.value).toEqual({ kind: 'literal', value: 10 });
  });

  it('skips a computed/block return_result_of closure (no comparable literal)', () => {
    const file = parseRust(`
#[mock]
trait Foo { fn bar(&self) -> u32; }
#[test]
fn t() {
    let mut mock = MockFoo::new();
    mock.set_bar(mock.method_bar().return_result_of(move || { let x = 1; x + 1 }));
    assert_eq!(2, mock.bar());
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks[0]!.stubbedMembers[0]!.returnValues).toHaveLength(0);
  });
});

describe('extractMocks (galvanic)', () => {
  it('detects new_mock!(Trait) + given!/expect_interactions! stubs + invocation', () => {
    const file = parseRust(`
#[mockable]
trait TestTrait { fn func(&self) -> usize; }
#[test]
#[use_mocks]
fn t() {
    let mock = new_mock!(TestTrait);
    given! {
        <mock as TestTrait>::func() then_return 42usize always;
    }
    expect_interactions! {
        <mock as TestTrait>::func() times 1;
    }
    assert_eq!(42usize, mock.func());
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.framework).toBe('galvanic');
    expect(mocks[0]!.pattern).toBe('galvanic');
    expect(mocks[0]!.target?.exportName).toBe('TestTrait');
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['func']);
    expect(mocks[0]!.stubbedMembers[0]!.returnValues).toHaveLength(0);
    expect(mocks[0]!.invocationSites.length).toBeGreaterThan(0);
  });

  it('strips generics from new_mock!(Trait<i32, f64, Assoc=String>)', () => {
    const file = parseRust(`
#[mockable]
pub trait TestTrait<'a, T, F> { type Assoc; fn func(&self, x: T, y: &F) -> i32; }
#[test]
#[use_mocks]
fn t() {
    let x = new_mock!(TestTrait<i32, f64, Assoc=String>);
    given! {
        <x as TestTrait<i32, f64, Assoc=String>>::func(|&a| a < 2, |&&b| b < 2.2) then_return 23 times(1);
    }
    assert!(x.func(1, &1.1) == 23);
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.target?.exportName).toBe('TestTrait');
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toEqual(['func']);
  });

  it('resolves a referred trait (new_mock!(::sub1::sub2::EmptyTrait)) to its last segment', () => {
    const file = parseRust(`
mod sub1 { pub mod sub2 { pub trait EmptyTrait {} } }
#[mockable(intern ::sub1::sub2)]
trait EmptyTrait {}
#[test]
#[use_mocks]
fn t() {
    let mock = new_mock!(::sub1::sub2::EmptyTrait);
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.target?.exportName).toBe('EmptyTrait');
  });

  it('strips an explicit mock type name and its attributes (new_mock!(Trait for MyMock))', () => {
    const file = parseRust(`
#[mockable]
trait TestTrait { fn func(&self) -> usize; }
#[test]
#[use_mocks]
fn t() {
    let mock = new_mock!(TestTrait for MyMock);
    mock.func();
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.target?.exportName).toBe('TestTrait');
    expect(mocks[0]!.invocationSites.length).toBeGreaterThan(0);
  });

  it('does not record galvanic then_return values (macro DSL is opaque)', () => {
    const file = parseRust(`
#[mockable]
trait TestTrait { fn func(&self) -> usize; }
#[test]
#[use_mocks]
fn t() {
    let mock = new_mock!(TestTrait);
    given! {
        <mock as TestTrait>::func() then_return 42usize always;
    }
    mock.func();
}
`);
    const mocks = extractMocks(file, '/c/src/t.rs');
    expect(mocks[0]!.configuredValues).toHaveLength(0);
    expect(mocks[0]!.stubbedMembers[0]!.returnValues).toHaveLength(0);
  });
});
