import type { MockIR, SourceSpan, TypeIR } from '@momus/core';
import type { RustExpr, RustFile, RustItem, RustMacroCall, RustSpan } from './ast.ts';

/**
 * Extract Rust mocks into MockIR. A mockall mock is a single entity: `mock! { … }` (or
 * `#[automock]`) *declares* the mock type and `MockFoo::new()` *instantiates* it, so we emit one
 * MockIR per `MockFoo::new()` — never one for the `mock!` macro itself. The mock's target is a
 * bare `exportName` (`kind: 'class'`) that the audit engine resolves against the production
 * SymbolIndex (file-local first) exactly like the TS/PHP parsers:
 *
 * - `#[automock]` on a trait/struct → target is that type (`MockRepo::new()` → `Repo`).
 * - `mock! { pub Foo { … } impl Trait for Foo { … } }` → target is the implemented `Trait`.
 * - `mock! { pub Foo { … } }` with no trait impl → self-defined mock struct, no production
 *   target (exportName unset), so no drift check fires.
 *
 * `invocationSites` are recorded when a mock variable's non-`expect_*` method is called, so a
 * used mock is not a zero-reach stub (TAUT-005).
 */
/** What a `mock! { … }` macro declares: the implemented trait (if any) and its method names. */
interface MockStructInfo {
  trait: string | null;
  methods: Set<string>;
}

/** A mockall static/associated/constructor method context (`MockFoo::baz_context()`). */
interface StaticContext {
  mock: MockIR;
  method: string;
}

/** Trait-side method set per mock, used to keep inherent mock methods out of drift checks. */
const traitMethodsByMock = new WeakMap<MockIR, Set<string> | null>();

export function extractMocks(file: RustFile, path: string): MockIR[] {
  const mocks: MockIR[] = [];
  // mock! struct name -> implemented trait info (trait = null for inherent methods only)
  const mockStructs = new Map<string, MockStructInfo>();
  collectMockStructs(file.items, mockStructs);
  // mock_derive (`#[mock]` on a trait/extern block) generates `Mock<Name>` (a *prefix* `Mock`, same
  // as mockall) — so the mockall pass would misattribute its `Mock<Name>::new()` constructors. The
  // `#[mock]`-declared trait names disambiguate: those constructors belong to the mock_derive pass.
  const mockDeriveTraits = new Set<string>();
  const mockDeriveExtern = new Map<string, string[]>(); // `Extern<Abi>Mocks` struct -> foreign fn names
  collectMockDerive(file.items, mockDeriveTraits, mockDeriveExtern);
  // mry (`#[mry::mry]` + `x.mock_<method>(…)`) is a distinct framework; its generated `Mock<Type>`
  // constructor collides with mockall's `MockFoo::new()` syntactically, so a mry file skips the
  // mockall/mockito/wiremock/httpmock pass entirely and uses its own scan.
  const typeTargets = new Map<string, string>(); // method name -> declaring type
  const fnNames = new Set<string>(); // free `#[mry::mry] fn` names
  collectMry(file.items, typeTargets, fnNames);
  if (typeTargets.size === 0 && fnNames.size === 0) {
    // No same-file `#[mry::mry]`: run the mockall/mockito/wiremock/httpmock pass, then a
    // cross-crate mry scan. mry's `mock_<method>(…)` carries no embedded type, so a type declared
    // in a production crate (`use crate::Foo; … mock.mock_foo()`) needs the mry pass to bind the
    // receiver from its constructor (`Mock<Foo>::default()` / `Mock<Foo>::new(…)` /
    // `mry::new!(Foo { … })`). A file using mry's `mock_<method>` config signal has its
    // `Mock<Foo>::new(…)` claimed by the mry pass, so the mockall pass skips that constructor
    // (they are syntactically identical — `mock_` vs `expect_` is the disambiguator).
    const hasMryCalls = hasMryMockCalls(file.items);
    collect(file.items, mocks, path, mockStructs, hasMryCalls, mockDeriveTraits);
    scanMry(file.items, typeTargets, fnNames, mocks, path);
  } else {
    scanMry(file.items, typeTargets, fnNames, mocks, path);
  }
  // faux (`#[faux::create]` + `Foo::faux()` + `faux::when!(…)`) is orthogonal — its `::faux` /
  // `faux::when` signals never collide with mockall/mockito/wiremock/httpmock, so it always runs.
  scanFaux(file.items, mocks, path);
  // mockers (`Scenario::create_mock_for::<dyn A>()` + `scenario.expect(handle.m(…).and_return(…))`)
  // is likewise orthogonal (its `create_mock*` / `scenario.expect` signals never collide), so it
  // always runs too.
  const mockersStructs = new Map<string, MockersMockInfo>();
  const mockersTraits = new Map<string, Set<string>>();
  collectMockers(file.items, mockersStructs, mockersTraits);
  scanMockers(file.items, mocks, path, mockersStructs, mockersTraits);
  // mockiato (`#[mockable]` + `XMock::new()` + `x.expect_<m>(…).returns(v)`) uses a *suffix*
  // `Mock` naming convention (`GreeterMock`, not mockall's `MockGreeter`), so the mockall pass
  // never sees its constructors — run this pass unconditionally.
  scanMockiato(file.items, mocks, path);
  // mocktopus (`#[mockable]` + `foo.mock_safe/mock_raw(…)`) replaces individual functions — its
  // `mock_safe`/`mock_raw` signals never collide, so it always runs too.
  scanMocktopus(file.items, mocks, path);
  // mock_derive (`#[mock]` trait/extern + `Mock<Name>::new()` / `Extern<Abi>Mocks::method_<fn>()`)
  // runs after the mockall pass; the mockall pass already skipped its `#[mock]` trait constructors.
  scanMockDerive(file.items, mockDeriveTraits, mockDeriveExtern, mocks, path);
  // galvanic (`#[mockable]` + `new_mock!(Trait)` + `given!`/`expect_interactions!` + `mock.method()`)
  // is orthogonal — its `new_mock!`/`given!`/`expect_interactions!` macro signals never collide
  // with any other framework's, so it always runs too.
  scanGalvanic(file.items, mocks, path);
  return mocks;
}

/** First pass: record the struct→trait mapping declared by every `mock! { … }` macro. */
function collectMockStructs(items: RustItem[], mockStructs: Map<string, MockStructInfo>): void {
  for (const item of items) {
    if (item.kind === 'macro' && (item.path === 'mock' || item.path === 'Mock')) {
      recordMockMacro(item, mockStructs);
    } else if (item.kind === 'mod') {
      collectMockStructs(item.items, mockStructs);
    }
  }
}

function recordMockMacro(m: RustMacroCall, mockStructs: Map<string, MockStructInfo>): void {
  // `impl [<T>] Trait for Foo [<T>] [where …] { fn a; fn b; }` — the trait methods are the
  // drift-checkable surface. The optional generic-args and `where`-clause groups make the
  // generic-struct shapes (`impl<T> Bar for Foo<T> where T: Clone { … }`) parse too.
  const traitMatch =
    /impl\s*(?:<[^>]*>)?\s*([A-Za-z_][\w:]*)\s+for\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*(?:where\s[^{]*)?\s*\{([^}]*)\}/.exec(
      m.tokens,
    );
  if (traitMatch) {
    const methods = new Set<string>();
    for (const fnMatch of traitMatch[3]!.matchAll(/fn\s+([A-Za-z_]\w*)/g)) methods.add(fnMatch[1]!);
    mockStructs.set(traitMatch[2]!, { trait: traitMatch[1]!.split('::').pop() ?? null, methods });
    return;
  }
  // `[pub] Foo [<T>] [where …] { … }` — self-defined mock struct (inherent methods only).
  const structMatch = /(?:pub\s+)?([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*(?:where\s[^{]*)?\s*\{/.exec(m.tokens);
  if (structMatch) mockStructs.set(structMatch[1]!, { trait: null, methods: new Set() });
}

/**
 * First pass for mock_derive: record `#[mock]`-declared trait names and `#[mock] extern` foreign fn
 * names. A `#[mock] trait Name` generates `Mock<Name>` (instance mock via `Mock<Name>::new()`); a
 * `#[mock] extern "C" { fn x(…); }` block generates a static `Extern<Abi>Mocks` mock with
 * `Extern<Abi>Mocks::method_<fn>()` + `Extern<Abi>Mocks::set_<fn>(…)` config verbs.
 */
function collectMockDerive(items: RustItem[], traitNames: Set<string>, externFns: Map<string, string[]>): void {
  for (const item of items) {
    if (item.kind === 'mod') {
      collectMockDerive(item.items, traitNames, externFns);
      continue;
    }
    // `use`/`macro` items carry no `attrs` key. `#[mock]` may also appear cfg-gated via
    // `#[cfg_attr(feature = "nightly", mock)]` — the `cfg_attr` attr wraps the `mock` attr as its
    // last argument (mock_derive's `stable_or_nightly` example).
    if (item.kind === 'use' || item.kind === 'macro') continue;
    const hasMock = item.attrs.some(
      (a) => a.path === 'mock' || (a.path === 'cfg_attr' && /\bmock\s*$/.test(a.args ?? '')),
    );
    if (!hasMock) continue;
    if (item.kind === 'trait') {
      traitNames.add(item.name);
    } else if (item.kind === 'extern') {
      externFns.set(
        `Extern${item.name}Mocks`,
        item.items.map((i) => i.name),
      );
    }
  }
}

function collect(
  items: RustItem[],
  mocks: MockIR[],
  path: string,
  mockStructs: Map<string, MockStructInfo>,
  skipMockConstructor = false,
  skipMockDerive: Set<string> = new Set(),
): void {
  for (const item of items) {
    if (item.kind === 'fn' && item.attrs.some((a) => a.path === 'test')) {
      // variable name -> mock, so `m.foo()` invocations attach to the right mock
      const bindings = new Map<string, MockIR>();
      const contexts = new Map<string, StaticContext>();
      const staticCalls = new Map<string, MockIR>();
      const fnId = `${path}#fn:${item.span.line}`;
      for (const expr of item.body) {
        walkExpr(
          expr,
          mocks,
          path,
          bindings,
          mockStructs,
          undefined,
          fnId,
          contexts,
          staticCalls,
          skipMockConstructor,
          skipMockDerive,
        );
        scanWiremock(expr, mocks, path);
      }
    } else if (item.kind === 'mod') {
      collect(item.items, mocks, path, mockStructs, skipMockConstructor, skipMockDerive);
    }
  }
}

const WRAPPER_CONSTRUCTORS = new Set(['Box::new', 'Arc::new', 'Rc::new', 'Pin::new']);

/** mockall's value-producing config methods (incl. the `_st` non-Send and `return_once` variants). */
function isReturnMethod(
  method: string | undefined,
): method is 'returning' | 'returning_st' | 'return_const' | 'return_once' | 'return_once_st' {
  return (
    method === 'returning' ||
    method === 'returning_st' ||
    method === 'return_const' ||
    method === 'return_once' ||
    method === 'return_once_st'
  );
}

/** The mock a path or wrapper constructor flows from, or undefined. */
function resolveMockRef(e: RustExpr | undefined, bindings: Map<string, MockIR>): MockIR | undefined {
  if (!e) return undefined;
  if (e.kind === 'path') return bindings.get(e.text);
  // Unwrap `&mock`, `&mut mock`, `(mock)`, `*mock` — any wrapper that serializes its inner
  // expression as `receiver` — so references work as receivers/args.
  if (e.kind === 'other' && e.receiver) return resolveMockRef(e.receiver, bindings);
  if (e.kind === 'call' && e.callee?.text && WRAPPER_CONSTRUCTORS.has(e.callee.text)) {
    return resolveMockRef(e.args?.[0], bindings);
  }
  return undefined;
}

function markReached(mock: MockIR, path: string, span: RustSpan): void {
  if (!mock.invocationSites.some((s) => s.startLine === span.line && s.startCol === span.column)) {
    mock.invocationSites.push(spanOf(path, span));
  }
}

/** Normalize a UFCS callee (`<MockA as A>::new`) to the plain `MockA::new` static-call key. */
function ufcsStaticKey(callee: string): string | undefined {
  const m = /^<([^>]+)>::([A-Za-z_]\w*)$/.exec(callee);
  if (!m) return undefined;
  return `${m[1]!.split(/\s+as\s+/)[0]!.trim()}::${m[2]}`;
}

function walkExpr(
  e: RustExpr,
  mocks: MockIR[],
  path: string,
  bindings: Map<string, MockIR>,
  mockStructs: Map<string, MockStructInfo>,
  pendingBinding?: string,
  fnId?: string,
  contexts?: Map<string, StaticContext>,
  staticCalls?: Map<string, MockIR>,
  skipMockConstructor = false,
  skipMockDerive: Set<string> = new Set(),
): void {
  // A `let NAME = <expr>;` binding applies to a `MockFoo::new()` anywhere in the initializer
  // (e.g. `let m = Box::new(MockFoo::new())`), so thread it down the expression tree.
  const boundName = e.binding ?? pendingBinding;
  if (
    !skipMockConstructor &&
    e.kind === 'call' &&
    e.callee?.text?.startsWith('Mock') &&
    e.callee.text.endsWith('::new')
  ) {
    // `MockRepo::new()` — strip the `Mock` prefix to recover the mocked type name. A mock_derive
    // `#[mock]` trait also uses the `Mock<Name>` prefix, so those constructors belong to the
    // mock_derive pass and are skipped here (the `#[mock]` attr is the disambiguator).
    const typeName = e.callee.text.replace(/^Mock/, '').split('::')[0]!;
    if (!skipMockDerive.has(typeName)) {
      const declared = mockStructs.get(typeName); // MockStructInfo | undefined (automock)
      const exportName = declared?.trait ?? (declared ? null : typeName);
      const mock = mockOf(path, e.span, declared === undefined ? 'automock' : 'mock-macro', exportName);
      mock.fnId = fnId;
      traitMethodsByMock.set(mock, declared?.trait ? declared.methods : null);
      mocks.push(mock);
      if (boundName) bindings.set(boundName, mock);
    }
  }

  // mockall's static/associated/constructor method API: `MockFoo::baz_context()` (or the module
  // form `mock_foo::bar_context()`) returns a context object configured via `ctx.expect()` —
  // there is no `MockFoo::new()` instance to hang it on. Emit one mock per context and record
  // the static method as a stub so DRIFT-001/003 and TAUT-005 still see it.
  if (e.kind === 'call' && e.callee?.kind === 'path') {
    const ctxMatch = /^(.+?)::([A-Za-z_]\w*)_context$/.exec(e.callee.text);
    if (ctxMatch) {
      const raw = ctxMatch[1]!.split('::').pop()!;
      const method = ctxMatch[2]!;
      const isModule = raw.startsWith('mock_');
      if (raw.startsWith('Mock') || isModule) {
        const typeName = isModule ? raw.slice('mock_'.length) : raw.slice('Mock'.length);
        const declared = mockStructs.get(typeName);
        const exportName = isModule ? null : (declared?.trait ?? (declared ? null : typeName));
        const mock = mockOf(path, e.span, declared === undefined ? 'automock' : 'mock-macro', exportName);
        mock.fnId = fnId;
        traitMethodsByMock.set(mock, declared?.trait ? declared.methods : null);
        if (!mock.stubbedMembers.some((s) => s.name === method)) {
          mock.stubbedMembers.push({ name: method, span: spanOf(path, e.span), returnValues: [], api: 'unknown' });
        }
        mocks.push(mock);
        if (boundName) contexts?.set(boundName, { mock, method });
        staticCalls?.set(`${raw}::${method}`, mock);
      }
    }
  }

  // A static-method invocation (`MockFoo::baz(41)`, `mock_foo::bar(5)`, `MockFoo::new(5)` for a
  // mocked constructor, or the UFCS form `<MockA as A>::new()`) reaches the context mock for that
  // method. Direct calls end in `::method`; UFCS keeps the `<Ty as Trait>::` prefix. Raw
  // identifiers serialize with their `r#` prefix (`r#loop`), so normalize it before the lookup.
  if (e.kind === 'call' && e.callee?.kind === 'path' && e.callee.text.includes('::') && staticCalls) {
    const ufcsKey = ufcsStaticKey(e.callee.text);
    const sm =
      staticCalls.get(e.callee.text) ??
      staticCalls.get(e.callee.text.replace(/::r#/g, '::')) ??
      (ufcsKey ? staticCalls.get(ufcsKey) : undefined);
    if (sm) markReached(sm, path, e.span);
  }

  // A function item referenced as a value (`let p = mock_ffi::foo;` then `p(42)`) also reaches the
  // static mock — the method is exercised through a function pointer, not a direct call.
  if (e.kind === 'path' && staticCalls) {
    const sm = staticCalls.get(e.text) ?? staticCalls.get(e.text.replace(/::r#/g, '::'));
    if (sm) markReached(sm, path, e.span);
  }

  // `mock("GET", ...)` or the fully-qualified `mockito::mock("GET", ...)` form.
  const calleeText = e.callee?.text ?? '';
  if (e.kind === 'call' && (calleeText === 'mock' || calleeText.endsWith('::mock'))) {
    const route = e.args?.map((a) => a.literal?.value).find((v) => v?.startsWith('/'));
    mocks.push(httpMock(path, e.span, 'mockito', route));
  }

  // mockito's primary API is a method call: `server.mock("GET", "/x").create()`.
  if (e.kind === 'method-call' && e.method === 'mock') {
    const route = e.args?.map((a) => a.literal?.value).find((v) => v?.startsWith('/'));
    if (route) mocks.push(httpMock(path, e.span, 'mockito', route));
  }

  // httpmock's primary API: `server.mock(|when, then| { … })` — a closure argument (mockito's
  // `server.mock("GET", "/x")` uses string literals instead). The route is configured via
  // `when.path("/x")` inside the closure; mocks without a path still count.
  if (e.kind === 'method-call' && e.method === 'mock' && e.args?.[0]?.kind === 'other') {
    const routeMatch = /when\s*\.\s*path\s*\(\s*"([^"]+)"/.exec(e.args[0].text);
    mocks.push(httpMock(path, e.span, 'httpmock', routeMatch?.[1]));
  }

  if (e.kind === 'method-call') {
    const mock = mocks[mocks.length - 1];
    // For a `mock!` with a trait impl, inherent mock methods (declared in the struct block) are
    // mock-local — they have no production counterpart and must not be drift-checked.
    const traitMethods = mock ? traitMethodsByMock.get(mock) : undefined;
    const onTraitSurface = (name: string): boolean => !traitMethods || traitMethods.has(name);
    if (
      e.method?.startsWith('expect_') &&
      mock &&
      onTraitSurface(e.method.slice('expect_'.length)) &&
      !mock.stubbedMembers.some((s) => s.name === e.method!.slice('expect_'.length))
    ) {
      mock.stubbedMembers.push({
        name: e.method.slice('expect_'.length),
        span: spanOf(path, e.span),
        returnValues: [],
        api: 'unknown',
      });
    }
    if (isReturnMethod(e.method)) {
      // Walk up a `.with(...)`/`.times(...)` chain to the `expect_X` (instance) or `expect`
      // (static-context) call.
      let recv = e.receiver;
      while (recv?.kind === 'method-call' && !recv.method?.startsWith('expect_') && recv.method !== 'expect')
        recv = recv.receiver;
      if (
        recv?.kind === 'method-call' &&
        recv.method?.startsWith('expect_') &&
        mock &&
        onTraitSurface(recv.method.slice('expect_'.length))
      ) {
        const name = recv.method.slice('expect_'.length);
        let stub = mock.stubbedMembers.find((s) => s.name === name);
        if (!stub) {
          stub = { name, span: spanOf(path, recv.span), returnValues: [], api: 'unknown' };
          mock.stubbedMembers.push(stub);
        }
        if (e.args?.[0]) {
          stub.returnValues.push({
            span: spanOf(path, e.args[0].span),
            api: e.method,
            once: false,
            assignable: 'unknown',
            value: literalType(e.args[0]),
          });
        }
      } else if (recv?.kind === 'method-call' && recv.method === 'expect' && recv.receiver?.kind === 'path') {
        // Static-context config: `ctx.expect().returning(...)` / `ctx.expect().return_const(...)`.
        const ctx = contexts?.get(recv.receiver.text);
        if (ctx) {
          let stub = ctx.mock.stubbedMembers.find((s) => s.name === ctx.method);
          if (!stub) {
            stub = { name: ctx.method, span: spanOf(path, recv.span), returnValues: [], api: 'unknown' };
            ctx.mock.stubbedMembers.push(stub);
          }
          // Inherent static mocks (`mock! { pub Foo { fn x(); } }`, no trait) have no production
          // target to drift-check, and their method is usually invoked indirectly through the
          // SUT's own impls or library code (serde's `MockThing::private_deserialize` is called
          // from `impl Deserialize for MockThing`) — so a "configured but never invoked" signal
          // is unreliable there. Skip the return value so TAUT-005 treats them as unconfigured.
          if (e.args?.[0] && ctx.mock.target?.kind !== 'unknown') {
            stub.returnValues.push({
              span: spanOf(path, e.args[0].span),
              api: e.method,
              once: false,
              assignable: 'unknown',
              value: literalType(e.args[0]),
            });
          }
        }
      }
    }
    // An actual call on a mock variable (`m.foo()`) marks the mock as invoked; `expect_*`
    // is stub configuration, not invocation.
    if (e.receiver?.kind === 'path' && e.method && !e.method.startsWith('expect_')) {
      const bound = bindings.get(e.receiver.text);
      if (bound && !bound.invocationSites.some((s) => s.startLine === e.span.line && s.startCol === e.span.column)) {
        bound.invocationSites.push(spanOf(path, e.span));
      }
    }
  }

  // Wrapper re-binding: `let boxed = Box::new(mock)` (or Arc/Rc/Pin, possibly nested) registers
  // the new variable as an alias of the mock so a later `boxed.method()` counts as an invocation.
  if (e.kind === 'call' && e.callee?.text && WRAPPER_CONSTRUCTORS.has(e.callee.text) && boundName) {
    const inner = resolveMockRef(e.args?.[0], bindings);
    if (inner) bindings.set(boundName, inner);
  }

  // By-value consumption: passing the mock/alias into any call (`block_on(mock)`) or calling a
  // method on a wrapper receiver (`Arc::new(mock).bean()`) means the mock is exercised.
  if (e.kind === 'call' || e.kind === 'method-call') {
    for (const a of e.args ?? []) {
      const inner = resolveMockRef(a, bindings);
      if (inner) markReached(inner, path, e.span);
    }
    if (e.kind === 'method-call' && e.receiver?.kind === 'call') {
      const inner = resolveMockRef(e.receiver, bindings);
      if (inner) markReached(inner, path, e.span);
    }
  }

  // Trait-qualified / UFCS invocation: `Foo::foo(&mock)` or `<Mock as Foo>::foo(&mock, 4)` —
  // the mock is the receiver passed as the first argument. `MockX::new()` (creation) and
  // arg-less static calls (`MockManyArgs::bean(...)`) don't resolve, so they stay unmarked.
  if (
    e.kind === 'call' &&
    e.callee?.kind === 'path' &&
    e.callee.text.includes('::') &&
    !e.callee.text.endsWith('::new')
  ) {
    const recv = resolveMockRef(e.args?.[0], bindings);
    if (recv) markReached(recv, path, e.span);
  }

  if (e.receiver)
    walkExpr(
      e.receiver,
      mocks,
      path,
      bindings,
      mockStructs,
      boundName,
      fnId,
      contexts,
      staticCalls,
      skipMockConstructor,
      skipMockDerive,
    );
  for (const a of e.args ?? [])
    walkExpr(
      a,
      mocks,
      path,
      bindings,
      mockStructs,
      boundName,
      fnId,
      contexts,
      staticCalls,
      skipMockConstructor,
      skipMockDerive,
    );
  if (e.left)
    walkExpr(
      e.left,
      mocks,
      path,
      bindings,
      mockStructs,
      boundName,
      fnId,
      contexts,
      staticCalls,
      skipMockConstructor,
      skipMockDerive,
    );
  if (e.right)
    walkExpr(
      e.right,
      mocks,
      path,
      bindings,
      mockStructs,
      boundName,
      fnId,
      contexts,
      staticCalls,
      skipMockConstructor,
      skipMockDerive,
    );
  for (const s of e.stmts ?? [])
    walkExpr(
      s,
      mocks,
      path,
      bindings,
      mockStructs,
      boundName,
      fnId,
      contexts,
      staticCalls,
      skipMockConstructor,
      skipMockDerive,
    );
}

/** A `Mock::given(...).and(path("/x")).respond_with(...)` statement -> one wiremock mock. */
function scanWiremock(e: RustExpr, mocks: MockIR[], path: string): void {
  if (hasCallee(e, 'Mock::given')) {
    mocks.push(httpMock(path, e.span, 'wiremock', findRoute(e)));
  }
}

// ---------------------------------------------------------------- mry

/** True when a file uses mry's distinctive `mock_<method>(…)` config call (vs mockall's `expect_`). */
function hasMryMockCalls(items: RustItem[]): boolean {
  for (const item of items) {
    if (item.kind === 'fn' || item.kind === 'impl' || item.kind === 'trait' || item.kind === 'mod') {
      if (item.kind === 'mod' && hasMryMockCalls(item.items)) return true;
      if (item.kind === 'fn') for (const e of item.body) if (exprHasMryMockCall(e)) return true;
    }
  }
  return false;
}

function exprHasMryMockCall(e: RustExpr): boolean {
  if (e.kind === 'method-call' && e.method?.startsWith('mock_')) return true;
  if (e.receiver && exprHasMryMockCall(e.receiver)) return true;
  for (const a of e.args ?? []) if (exprHasMryMockCall(a)) return true;
  if (e.left && exprHasMryMockCall(e.left)) return true;
  if (e.right && exprHasMryMockCall(e.right)) return true;
  for (const s of e.stmts ?? []) if (exprHasMryMockCall(s)) return true;
  return false;
}

/** True for the `mry` / `mry::mry` attribute (the wasm serializer drops the `mry::` prefix). */
function hasMryAttr(item: RustItem): boolean {
  if (item.kind === 'use' || item.kind === 'macro') return false;
  return (item.attrs ?? []).some((a) => a.path === 'mry' || a.path === 'mry::mry');
}

/** mry's value-producing config verbs (the `returns_once_st` non-Send variant included). */
function isMryReturn(method: string | undefined): boolean {
  return method === 'returns' || method === 'returns_with' || method === 'returns_once' || method === 'returns_once_st';
}

/** mry config/verify chain verbs — the outer method of a `mock_<method>(…).<verb>(…)` call. */
function isMryChainVerb(method: string | undefined): boolean {
  return isMryReturn(method) || method === 'calls_real_impl' || method === 'assert_called';
}

/**
 * First pass: record the mockable surface of a mry file. `typeTargets` maps a method name to the
 * type that declares it (struct/trait/enum via `#[mry::mry] impl` or `#[mry::mry] trait`), and
 * `fnNames` is the set of free `#[mry::mry] fn` names (mocked as a bare `mock_<fn>(…)` — no
 * member drift surface, so those get an untargeted mock).
 */
function collectMry(items: RustItem[], typeTargets: Map<string, string>, fnNames: Set<string>): void {
  for (const item of items) {
    if (item.kind === 'trait') {
      if (hasMryAttr(item)) for (const ti of item.items) typeTargets.set(ti.name, item.name);
    } else if (item.kind === 'struct' || item.kind === 'enum') {
      // type existence is implied by the `#[mry::mry] impl` that follows; nothing to map here.
    } else if (item.kind === 'impl') {
      if (hasMryAttr(item)) {
        const typeName = item.selfType.name ?? item.selfType.text.replace(/<.*/, '');
        for (const fn of item.items) typeTargets.set(fn.name, typeName);
      }
    } else if (item.kind === 'fn') {
      if (hasMryAttr(item)) fnNames.add(item.name);
    } else if (item.kind === 'macro' && (item.path === 'mry::m' || item.path === 'm')) {
      // `mry::m! { struct Cat { … } impl Cat { fn meow(…); … } }` — the function-style macro form
      // (an alternative to the `#[mry::mry]` attribute). Parse the token stream for the type and
      // its `fn` methods.
      recordMryMacro(item, typeTargets);
    } else if (item.kind === 'mod') {
      collectMry(item.items, typeTargets, fnNames);
    }
  }
}

/** Parse a `mry::m! { … }` token stream: map every `fn <name>` to the wrapped type. */
function recordMryMacro(m: RustMacroCall, typeTargets: Map<string, string>): void {
  const tokens = m.tokens;
  // The type is the `impl`'s target, else the wrapped `struct`/`enum`/`trait` (trait-only form).
  const typeName =
    /impl\s+([A-Za-z_]\w*)/.exec(tokens)?.[1] ?? /(?:struct|enum|trait)\s+([A-Za-z_]\w*)/.exec(tokens)?.[1];
  if (!typeName) return;
  for (const fnMatch of tokens.matchAll(/fn\s+([A-Za-z_]\w*)/g)) typeTargets.set(fnMatch[1]!, typeName);
}

/** A type-targeted mry mock: `x.mock_<method>` / `Type::mock_<method>` / `Mock<T>::mock_<method>`. */
function mryTypeMock(path: string, span: RustSpan, target: string, method: string, fnId: string): MockIR {
  return {
    id: `${path}#mock:${span.line}:${span.column}`,
    span: spanOf(path, span),
    framework: 'mry',
    pattern: 'mry',
    target: { kind: 'class', exportName: target, span: spanOf(path, span) },
    stubbedMembers: [{ name: method, span: spanOf(path, span), returnValues: [], api: 'unknown' }],
    configuredValues: [],
    invocationSites: [],
    isAutomock: false,
    fnId,
  };
}

/** A free-function mry mock (`mock_<fn>(…)`) — no member drift surface, no stub. */
function mryFnMock(path: string, span: RustSpan, fnId: string): MockIR {
  return {
    id: `${path}#mock:${span.line}:${span.column}`,
    span: spanOf(path, span),
    framework: 'mry',
    pattern: 'mry',
    target: { kind: 'unknown', span: spanOf(path, span) },
    stubbedMembers: [],
    configuredValues: [],
    invocationSites: [],
    isAutomock: false,
    fnId,
  };
}

/** Second pass: extract mry mocks from test fns. */
function scanMry(
  items: RustItem[],
  typeTargets: Map<string, string>,
  fnNames: Set<string>,
  mocks: MockIR[],
  path: string,
): void {
  for (const item of items) {
    if (item.kind === 'fn' && item.attrs.some((a) => a.path === 'test')) {
      const fnId = `${path}#fn:${item.span.line}`;
      const byVar = new Map<string, MockIR[]>(); // receiver var -> its mry mocks (for invocation marking)
      const byKey = new Map<string, MockIR>(); // `var:method` -> one mock (dedupe config vs assert_called)
      const varTypes = new Map<string, string>(); // receiver var -> mocked type (cross-crate constructors)
      for (const expr of item.body) scanMryExpr(expr, typeTargets, fnNames, mocks, path, fnId, byVar, byKey, varTypes);
    } else if (item.kind === 'mod') {
      scanMry(item.items, typeTargets, fnNames, mocks, path);
    }
  }
}

/**
 * Cross-crate mry constructors bind a receiver variable to the mocked type:
 * `Mock<Foo>::default()` / `Mock<Foo>::new(…)` (the generated full mock) and
 * `mry::new!(Foo { … })` (partial mock). `Mock<Foo>::new(…)` is only safe here because the
 * mockall pass has already skipped the constructor when the file uses `mock_<method>` (the
 * `hasMryMockCalls` signal); in a pure-mockall file there is no `mock_` call to emit, so the
 * binding is inert.
 */
function mryConstructorType(e: RustExpr): string | undefined {
  if (e.kind === 'call') {
    const m = /^(?:[a-z_]\w*::)*Mock([A-Z][A-Za-z0-9_]*)::(?:default|new)$/.exec(e.callee?.text ?? '');
    if (m) return m[1]!;
  }
  if (e.kind === 'macro' && e.macroPath === 'mry::new') {
    const m = /^(?:[a-z_]\w*::)*([A-Z][A-Za-z0-9_]*)/.exec((e.args?.[0]?.text ?? '').trim());
    if (m) return m[1]!;
  }
  return undefined;
}

/** The variable name a mry mock/ref expression resolves to (`cat`, `&cat`, `&mut cat`). */
function mryPathVar(e: RustExpr | undefined): string | undefined {
  if (!e) return undefined;
  if (e.kind === 'path') return e.text;
  if (e.kind === 'other' && e.receiver) return mryPathVar(e.receiver);
  return undefined;
}

function scanMryExpr(
  e: RustExpr,
  typeTargets: Map<string, string>,
  fnNames: Set<string>,
  mocks: MockIR[],
  path: string,
  fnId: string,
  byVar: Map<string, MockIR[]>,
  byKey: Map<string, MockIR>,
  varTypes: Map<string, string>,
  pendingBinding?: string,
): void {
  const boundName = e.binding ?? pendingBinding;
  // A cross-crate mry constructor binds the receiver var to the mocked type so an instance
  // `mock_<method>(…)` call resolves without a same-file `#[mry::mry]` declaration.
  if (boundName) {
    const type = mryConstructorType(e);
    if (type) varTypes.set(boundName, type);
  }
  if (e.kind === 'method-call') {
    // A `mock_<method>(…).<verb>(…)` chain: the outer method is the config/verify verb, and the
    // receiver is either an instance `x.mock_<method>` (method-call) or a static
    // `Type::mock_<method>` / `mock_<fn>` (call).
    if (isMryChainVerb(e.method)) {
      let recv = e.receiver;
      while (recv?.kind === 'method-call' && !recv.method?.startsWith('mock_')) recv = recv.receiver;
      let mock: MockIR | undefined;
      if (recv?.kind === 'method-call' && recv.method?.startsWith('mock_')) {
        mock = emitMryMock(recv, typeTargets, mocks, path, fnId, byVar, byKey, varTypes);
      } else if (recv?.kind === 'call') {
        mock = emitMryStatic(recv, typeTargets, fnNames, mocks, path, fnId, byKey);
      }
      // Record a literal return value (`returns(1)`, `returns("Called")`) for DRIFT-003
      // (return-type assignability). Non-literal returns (`returns("x".to_string())`,
      // `returns_with(|…|)`, `returns_once(NotClone)`) have no literal to compare and are skipped
      // (`literalType` yields `unknown`).
      if (mock && isMryReturn(e.method) && e.args?.[0]) {
        const method = e.method!;
        const value = literalType(e.args[0]);
        if (value.kind !== 'unknown') {
          const stub = mock.stubbedMembers[0];
          if (stub) {
            stub.returnValues.push({
              span: spanOf(path, e.args[0].span),
              api: method,
              once: false,
              assignable: 'unknown',
              value,
            });
          }
        }
      }
    }
    // Bare `x.mock_<method>(…)` (no chained verb).
    if (e.method?.startsWith('mock_')) {
      emitMryMock(e, typeTargets, mocks, path, fnId, byVar, byKey, varTypes);
    }
    // Real invocation: `x.meow(…)` after `x.mock_meow(…)` marks the mock reached.
    if (e.receiver?.kind === 'path' && e.method && !e.method.startsWith('mock_')) {
      const list = byVar.get(e.receiver.text);
      if (list)
        for (const m of list) if (m.stubbedMembers.some((s) => s.name === e.method)) markReached(m, path, e.span);
    }
  }

  // Trait-qualified / UFCS invocation: `Cat::meow(&cat, 2)` (or `<Mock as Cat>::meow(&cat, 2)`)
  // passes the mock as the first argument — mark the matching stub reached (mry's async
  // trait-variant tests invoke the mock through the trait, not the instance variable).
  if (e.kind === 'call' && e.callee?.kind === 'path' && e.callee.text.includes('::')) {
    const method = e.callee.text.split('::').pop()!.replace(/^r#/, '');
    const varName = mryPathVar(e.args?.[0]);
    if (varName) {
      const list = byVar.get(varName);
      if (list) for (const m of list) if (m.stubbedMembers.some((s) => s.name === method)) markReached(m, path, e.span);
    }
  }

  if (e.receiver) scanMryExpr(e.receiver, typeTargets, fnNames, mocks, path, fnId, byVar, byKey, varTypes, boundName);
  for (const a of e.args ?? [])
    scanMryExpr(a, typeTargets, fnNames, mocks, path, fnId, byVar, byKey, varTypes, boundName);
  if (e.left) scanMryExpr(e.left, typeTargets, fnNames, mocks, path, fnId, byVar, byKey, varTypes, boundName);
  if (e.right) scanMryExpr(e.right, typeTargets, fnNames, mocks, path, fnId, byVar, byKey, varTypes, boundName);
  for (const s of e.stmts ?? [])
    scanMryExpr(s, typeTargets, fnNames, mocks, path, fnId, byVar, byKey, varTypes, boundName);
}

/** Emit (or reuse) the instance mry mock for `recv` (`x.mock_<method>(…)`); returns it. */
function emitMryMock(
  recv: RustExpr,
  typeTargets: Map<string, string>,
  mocks: MockIR[],
  path: string,
  fnId: string,
  byVar: Map<string, MockIR[]>,
  byKey: Map<string, MockIR>,
  varTypes: Map<string, string>,
): MockIR | undefined {
  const method = recv.method!.slice('mock_'.length);
  const varName = recv.receiver?.kind === 'path' ? recv.receiver.text : undefined;
  // Same-file `#[mry::mry]` declarations map the method -> type directly; cross-crate files bind
  // the receiver var from its constructor (`Mock<Foo>::default()` / `mry::new!(Foo { … })`).
  const target = typeTargets.get(method) ?? (varName ? varTypes.get(varName) : undefined);
  if (!target) return undefined; // free-function name reached via an instance — no type surface
  const key = `${varName ?? '<static>'}:${method}`;
  let mock = byKey.get(key);
  if (!mock) {
    mock = mryTypeMock(path, recv.span, target, method, fnId);
    mocks.push(mock);
    byKey.set(key, mock);
    if (varName) {
      const list = byVar.get(varName) ?? [];
      list.push(mock);
      byVar.set(varName, list);
    }
  }
  return mock;
}

// ---------------------------------------------------------------- faux

/** faux's stub-config verbs (`faux::when!(…).then*`) — a closure or a literal return value. */
function isFauxConfigVerb(method: string | undefined): boolean {
  return method === 'then' || method === 'then_return' || method === 'then_unchecked';
}

function fauxMockOf(path: string, span: RustSpan, target: string, fnId: string): MockIR {
  return {
    id: `${path}#mock:${span.line}:${span.column}`,
    span: spanOf(path, span),
    framework: 'faux',
    pattern: 'faux',
    target: { kind: 'class', exportName: target, span: spanOf(path, span) },
    stubbedMembers: [],
    configuredValues: [],
    invocationSites: [],
    isAutomock: false,
    fnId,
  };
}

/**
 * faux's mock API: `#[faux::create] struct Foo` + `Foo::faux()` instantiates a mock, and
 * `faux::when!(mock.method).then*()` configures a stub. The `Foo::faux()` constructor is
 * distinctive (never collides with mockall's `MockFoo::new()`), so this pass runs unconditionally.
 * `then_return(value)` records a literal return for DRIFT-003; `then`/`then_unchecked` closures
 * carry no literal and are skipped.
 */
function scanFaux(items: RustItem[], mocks: MockIR[], path: string): void {
  for (const item of items) {
    if (item.kind === 'fn' && item.attrs.some((a) => a.path === 'test')) {
      const fnId = `${path}#fn:${item.span.line}`;
      const bindings = new Map<string, MockIR>(); // receiver var -> its faux mock
      for (const expr of item.body) scanFauxExpr(expr, mocks, path, fnId, bindings, undefined);
    } else if (item.kind === 'mod') {
      scanFaux(item.items, mocks, path);
    }
  }
}

function scanFauxExpr(
  e: RustExpr,
  mocks: MockIR[],
  path: string,
  fnId: string,
  bindings: Map<string, MockIR>,
  pendingBinding: string | undefined,
): void {
  const boundName = e.binding ?? pendingBinding;
  // `Foo::faux()` — instantiate a faux mock of `Foo` (strip the `::faux` suffix).
  if (e.kind === 'call' && e.callee?.text?.endsWith('::faux')) {
    const typeName = e.callee.text.slice(0, -'::faux'.length).split('::').pop()!;
    const mock = fauxMockOf(path, e.span, typeName, fnId);
    mocks.push(mock);
    if (boundName) bindings.set(boundName, mock);
  }
  // `faux::when!(mock.method).then*()` — the `faux::when!` macro captures `mock.method`; the outer
  // method is the config verb. Resolve `mock` against the binding and add `method` as a stub.
  if (
    e.kind === 'method-call' &&
    isFauxConfigVerb(e.method) &&
    e.receiver?.kind === 'macro' &&
    e.receiver.macroPath === 'faux::when'
  ) {
    const arg = e.receiver.args?.[0];
    const varName = arg?.receiver?.kind === 'path' ? arg.receiver.text : undefined;
    // `mock.method(…)` captures as a method-call (use its clean `method`); `mock.method` with no
    // args captures as `other` (take the segment after the last `.`).
    const method =
      arg?.kind === 'method-call' ? arg.method : arg?.kind === 'other' ? arg.text?.split('.').pop()?.trim() : undefined;
    if (varName && method) {
      const mock = bindings.get(varName);
      if (mock) {
        let stub = mock.stubbedMembers.find((s) => s.name === method);
        if (!stub) {
          stub = { name: method, span: spanOf(path, e.span), returnValues: [], api: 'unknown' };
          mock.stubbedMembers.push(stub);
        }
        // `then_return(value)` records a literal return for DRIFT-003 (return-type
        // assignability). `then`/`then_unchecked` take closures — no literal to compare.
        if (e.method === 'then_return' && e.args?.[0]) {
          const value = literalType(e.args[0]);
          if (value.kind !== 'unknown') {
            stub.returnValues.push({
              span: spanOf(path, e.args[0].span),
              api: 'then_return',
              once: false,
              assignable: 'unknown',
              value,
            });
          }
        }
      }
    }
  }
  // A real call on the mock variable (`mock.get_stuff()`) marks it reached.
  if (e.kind === 'method-call' && e.receiver?.kind === 'path') {
    const mock = bindings.get(e.receiver.text);
    if (mock) markReached(mock, path, e.span);
  }

  if (e.receiver) scanFauxExpr(e.receiver, mocks, path, fnId, bindings, boundName);
  for (const a of e.args ?? []) scanFauxExpr(a, mocks, path, fnId, bindings, boundName);
  if (e.left) scanFauxExpr(e.left, mocks, path, fnId, bindings, boundName);
  if (e.right) scanFauxExpr(e.right, mocks, path, fnId, bindings, boundName);
  for (const s of e.stmts ?? []) scanFauxExpr(s, mocks, path, fnId, bindings, boundName);
}

/** Emit a static mry mock: `Mock<T>::mock_<method>` / `T::mock_<method>` / bare `mock_<fn>`; returns it. */
function emitMryStatic(
  recv: RustExpr,
  typeTargets: Map<string, string>,
  fnNames: Set<string>,
  mocks: MockIR[],
  path: string,
  fnId: string,
  byKey: Map<string, MockIR>,
): MockIR | undefined {
  const callee = recv.callee?.text ?? '';
  const sm = /^(?:([A-Za-z_]\w*)::)?mock_([A-Za-z_]\w*)$/.exec(callee);
  if (!sm) return undefined;
  const typePrefix = sm[1]; // `MockCat`, `Cat`, or undefined (free function)
  const method = sm[2]!;
  if (typePrefix) {
    const target = typePrefix.startsWith('Mock') ? typePrefix.slice('Mock'.length) : typePrefix;
    const key = `static:${typePrefix}:${method}`;
    if (!byKey.has(key)) {
      byKey.set(key, mryTypeMock(path, recv.span, target, method, fnId));
      mocks.push(byKey.get(key)!);
    }
    return byKey.get(key);
  } else if (fnNames.has(method)) {
    const key = `fn:${method}`;
    if (!byKey.has(key)) {
      byKey.set(key, mryFnMock(path, recv.span, fnId));
      mocks.push(byKey.get(key)!);
    }
    return byKey.get(key);
  }
  return undefined;
}

// ---------------------------------------------------------------- mockers

/** mockers' instantiation methods — `Scenario::create_mock_for::<dyn A>()` / `create_mock::<X>()`. */
const MOCKERS_CREATE = new Set(['create_mock', 'create_mock_for', 'create_named_mock_for']);

/** A mockers mock struct: the traits it implements and the union of their declared methods. */
interface MockersMockInfo {
  traits: string[];
  methods: Set<string>;
}

/** Per-mock drift-checkable method set (null = unknown, trust all stubs). */
const mockersMethodsByMock = new WeakMap<MockIR, Set<string> | null>();

/**
 * First pass: map mockers' mock structs to the traits they mock (and the traits to their methods).
 * - `mock! { Name, self, trait A { … } [, self, trait B { … }] }` (mockers' form, distinct from
 *   mockall's `mock!`).
 * - `#[mocked] trait A` → `AMock` / `AMockStatic`; `#[mocked(CustomName)] trait A` →
 *   `CustomName` / `CustomNameStatic`.
 */
function collectMockers(
  items: RustItem[],
  mockStructs: Map<string, MockersMockInfo>,
  traitMethods: Map<string, Set<string>>,
): void {
  for (const item of items) {
    if (item.kind === 'macro' && (item.path === 'mock' || item.path === 'Mock')) {
      const structMatch = /^\s*([A-Za-z_]\w*)\s*,/.exec(item.tokens);
      if (!structMatch) continue;
      const traits: string[] = [];
      const methods = new Set<string>();
      for (const t of item.tokens.matchAll(/trait\s+([A-Za-z_]\w*)\s*\{([^}]*)\}/g)) {
        traits.push(t[1]!);
        const ms = new Set<string>();
        for (const fn of t[2]!.matchAll(/fn\s+([A-Za-z_]\w*)/g)) ms.add(fn[1]!);
        for (const m of ms) methods.add(m);
        const existing = traitMethods.get(t[1]!) ?? new Set<string>();
        for (const m of ms) existing.add(m);
        traitMethods.set(t[1]!, existing);
      }
      if (traits.length > 0) mockStructs.set(structMatch[1]!, { traits, methods });
    } else if (item.kind === 'trait') {
      const attr = item.attrs.find((a) => a.path === 'mocked');
      if (attr) {
        const methods = new Set(item.items.map((ti) => ti.name));
        const existing = traitMethods.get(item.name) ?? new Set<string>();
        for (const m of methods) existing.add(m);
        traitMethods.set(item.name, existing);
        const custom =
          attr.args && !/^\s*derive\b/.test(attr.args) ? /^\s*([A-Za-z_]\w*)/.exec(attr.args)?.[1] : undefined;
        const structNames = custom ? [custom, `${custom}Static`] : [`${item.name}Mock`, `${item.name}MockStatic`];
        for (const n of structNames) mockStructs.set(n, { traits: [item.name], methods });
      }
    } else if (item.kind === 'mod') {
      collectMockers(item.items, mockStructs, traitMethods);
    }
  }
}

/** The turbofish type argument of `scenario.create_mock_for::<dyn A>()` (leading path, `dyn` stripped). */
function mockersTypeArg(e: RustExpr): string | undefined {
  const m = /::\s*<\s*(?:dyn\s+)?([A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)*)/.exec(e.text ?? '');
  return m ? m[1]!.replace(/\s+/g, '') : undefined;
}

/**
 * Resolve a mockers type argument to its production target + drift-checkable method set.
 * `create_mock::<XMock>()` uses the mock struct name; `create_mock_for::<dyn Trait>()` uses the
 * trait name directly. A multi-trait mock has no single production type → untargeted.
 */
function mockersResolve(
  typeArg: string,
  isDyn: boolean,
  mockStructs: Map<string, MockersMockInfo>,
  traitMethods: Map<string, Set<string>>,
): { target: string | null; methods: Set<string> | null } {
  const last = typeArg.split('::').pop()!;
  if (!isDyn) {
    const info = mockStructs.get(last);
    if (info) {
      if (info.traits.length !== 1) return { target: null, methods: info.methods };
      return { target: info.traits[0]!, methods: info.methods };
    }
    if (last.endsWith('MockStatic')) return { target: last.slice(0, -'MockStatic'.length), methods: null };
    if (last.endsWith('Mock')) return { target: last.slice(0, -'Mock'.length), methods: null };
    return { target: last, methods: null };
  }
  return { target: last, methods: traitMethods.get(last) ?? null };
}

/** True when `method` is a drift-checkable trait method (or the surface is unknown). */
function mockersOnTraitSurface(mock: MockIR, method: string): boolean {
  const methods = mockersMethodsByMock.get(mock);
  return !methods || methods.has(method);
}

function mockersMockOf(path: string, span: RustSpan, target: string | null, fnId: string): MockIR {
  return {
    id: `${path}#mock:${span.line}:${span.column}`,
    span: spanOf(path, span),
    framework: 'mockers',
    pattern: 'mockers',
    target: target
      ? { kind: 'class', exportName: target, span: spanOf(path, span) }
      : { kind: 'unknown', span: spanOf(path, span) },
    stubbedMembers: [],
    configuredValues: [],
    invocationSites: [],
    isAutomock: false,
    fnId,
  };
}

/** Resolve a fake mock variable through `&mock` / `&mut mock` wrappers. */
function resolveMockersRef(e: RustExpr | undefined, fakeVars: Map<string, MockIR>): MockIR | undefined {
  if (!e) return undefined;
  if (e.kind === 'path') return fakeVars.get(e.text);
  if (e.kind === 'other' && e.receiver) return resolveMockersRef(e.receiver, fakeVars);
  return undefined;
}

/**
 * mockers' mock API: `scenario.create_mock_for::<dyn A>()` returns `(mock, handle)` — `mock` is
 * the fake (invocations mark it reached) and `handle` configures expectations via
 * `scenario.expect(handle.method(…).and_return(…))`. The `create_mock*` signals never collide
 * with mockall/mockito/wiremock/httpmock/mry/faux, so this pass runs unconditionally.
 */
function scanMockers(
  items: RustItem[],
  mocks: MockIR[],
  path: string,
  mockStructs: Map<string, MockersMockInfo>,
  traitMethods: Map<string, Set<string>>,
): void {
  for (const item of items) {
    if (item.kind === 'fn' && item.attrs.some((a) => a.path === 'test')) {
      const fnId = `${path}#fn:${item.span.line}`;
      const fakeVars = new Map<string, MockIR>(); // fake var -> mock (invocation marking)
      const handleVars = new Map<string, MockIR>(); // handle var -> mock (stub/config attachment)
      for (const expr of item.body)
        scanMockersExpr(expr, mocks, path, fnId, mockStructs, traitMethods, fakeVars, handleVars);
    } else if (item.kind === 'mod') {
      scanMockers(item.items, mocks, path, mockStructs, traitMethods);
    }
  }
}

function scanMockersExpr(
  e: RustExpr,
  mocks: MockIR[],
  path: string,
  fnId: string,
  mockStructs: Map<string, MockersMockInfo>,
  traitMethods: Map<string, Set<string>>,
  fakeVars: Map<string, MockIR>,
  handleVars: Map<string, MockIR>,
): void {
  if (e.kind === 'method-call') {
    // `scenario.create_mock_for::<dyn A>()` / `create_mock::<X>()` / `create_named_mock_for::<…>()`
    // — emit one mock and bind the tuple-destructured fake (element 0) + handle (element 1).
    if (MOCKERS_CREATE.has(e.method ?? '')) {
      const typeArg = mockersTypeArg(e);
      if (typeArg) {
        const isDyn = e.method === 'create_mock_for' || e.method === 'create_named_mock_for';
        const { target, methods } = mockersResolve(typeArg, isDyn, mockStructs, traitMethods);
        const mock = mockersMockOf(path, e.span, target, fnId);
        mockersMethodsByMock.set(mock, methods);
        mocks.push(mock);
        const names = e.bindings ?? [];
        if (names[0]) fakeVars.set(names[0], mock);
        if (names[1]) handleVars.set(names[1], mock);
      }
    }
    // `handle.<method>(…)` — the bottom of a `scenario.expect(handle.method(…).and_return(…))`
    // chain — attaches the stubbed member. Mock-specific methods (`clone` from `mock_clone!` /
    // `derive(Clone)`) are filtered out when the trait surface is known.
    if (e.receiver?.kind === 'path' && handleVars.has(e.receiver.text) && !MOCKERS_CREATE.has(e.method ?? '')) {
      const mock = handleVars.get(e.receiver.text)!;
      if (mockersOnTraitSurface(mock, e.method!) && !mock.stubbedMembers.some((s) => s.name === e.method)) {
        mock.stubbedMembers.push({ name: e.method!, span: spanOf(path, e.span), returnValues: [], api: 'unknown' });
      }
    }
    // `.and_return(value)` — record a literal return for DRIFT-003 (return-type assignability).
    // The stub is attached here too (the `handle.<method>` receiver is walked *after* this branch,
    // so the member may not exist yet).
    if (e.method === 'and_return' && e.args?.[0]) {
      let recv = e.receiver;
      while (recv?.kind === 'method-call' && !(recv.receiver?.kind === 'path' && handleVars.has(recv.receiver.text)))
        recv = recv.receiver;
      if (
        recv?.kind === 'method-call' &&
        recv.receiver?.kind === 'path' &&
        handleVars.has(recv.receiver.text) &&
        mockersOnTraitSurface(handleVars.get(recv.receiver.text)!, recv.method!)
      ) {
        const mock = handleVars.get(recv.receiver.text)!;
        let stub = mock.stubbedMembers.find((s) => s.name === recv.method);
        if (!stub) {
          stub = { name: recv.method!, span: spanOf(path, recv.span), returnValues: [], api: 'unknown' };
          mock.stubbedMembers.push(stub);
        }
        const value = literalType(e.args[0]);
        if (value.kind !== 'unknown') {
          stub.returnValues.push({
            span: spanOf(path, e.args[0].span),
            api: 'and_return',
            once: false,
            assignable: 'unknown',
            value,
          });
        }
      }
    }
    // A real call on the fake (`mock.method(…)`) marks the mock reached.
    if (e.receiver?.kind === 'path' && fakeVars.has(e.receiver.text)) {
      markReached(fakeVars.get(e.receiver.text)!, path, e.span);
    }
  }
  // Passing the fake into production (`use_foo(mock)`, `set_temperature_20(&mut mock)`) is an
  // invocation too.
  if (e.kind === 'call' || e.kind === 'method-call') {
    for (const a of e.args ?? []) {
      const inner = resolveMockersRef(a, fakeVars);
      if (inner) markReached(inner, path, e.span);
    }
  }

  if (e.receiver) scanMockersExpr(e.receiver, mocks, path, fnId, mockStructs, traitMethods, fakeVars, handleVars);
  for (const a of e.args ?? []) scanMockersExpr(a, mocks, path, fnId, mockStructs, traitMethods, fakeVars, handleVars);
  if (e.left) scanMockersExpr(e.left, mocks, path, fnId, mockStructs, traitMethods, fakeVars, handleVars);
  if (e.right) scanMockersExpr(e.right, mocks, path, fnId, mockStructs, traitMethods, fakeVars, handleVars);
  for (const s of e.stmts ?? []) scanMockersExpr(s, mocks, path, fnId, mockStructs, traitMethods, fakeVars, handleVars);
}

// ---------------------------------------------------------------- mockiato

/** mockiato's value-producing return verbs (`returns` / `returns_once`). */
function isMockiatoReturn(method: string | undefined): method is 'returns' | 'returns_once' {
  return method === 'returns' || method === 'returns_once';
}

function mockiatoMockOf(path: string, span: RustSpan, target: string, fnId: string): MockIR {
  return {
    id: `${path}#mock:${span.line}:${span.column}`,
    span: spanOf(path, span),
    framework: 'mockiato',
    pattern: 'mockiato',
    target: { kind: 'class', exportName: target, span: spanOf(path, span) },
    stubbedMembers: [],
    configuredValues: [],
    invocationSites: [],
    isAutomock: false,
    fnId,
  };
}

/**
 * mockiato's mock API: `#[mockable] trait X` generates `XMock` (a *suffix* `Mock`, vs mockall's
 * `MockX` prefix), instantiated via `XMock::new()`/`XMock::default()` and configured via
 * `x.expect_<method>(…).returns(v)`. `expect_<method>_calls_in_order` is the same stub with a
 * `_calls_in_order` suffix. The suffix naming means this pass never collides with mockall's
 * `MockX::new()` prefix, so it runs unconditionally.
 */
function scanMockiato(items: RustItem[], mocks: MockIR[], path: string): void {
  for (const item of items) {
    if (item.kind === 'fn' && item.attrs.some((a) => a.path === 'test')) {
      const fnId = `${path}#fn:${item.span.line}`;
      const bindings = new Map<string, MockIR>(); // receiver var -> its mockiato mock
      for (const expr of item.body) scanMockiatoExpr(expr, mocks, path, fnId, bindings);
    } else if (item.kind === 'mod') {
      scanMockiato(item.items, mocks, path);
    }
  }
}

function scanMockiatoExpr(
  e: RustExpr,
  mocks: MockIR[],
  path: string,
  fnId: string,
  bindings: Map<string, MockIR>,
): void {
  // `GreeterMock::new()` / `GreeterMock::default()` — strip the `Mock` suffix to recover the
  // mocked trait name (the `#[mockable]` trait).
  if (e.kind === 'call' && e.callee?.text && /::(?:new|default)$/.test(e.callee.text)) {
    const last = e.callee.text
      .replace(/::(?:new|default)$/, '')
      .split('::')
      .pop()!;
    if (last.endsWith('Mock')) {
      const mock = mockiatoMockOf(path, e.span, last.slice(0, -'Mock'.length), fnId);
      mocks.push(mock);
      if (e.binding) bindings.set(e.binding, mock);
    }
  }

  if (e.kind === 'method-call') {
    // `x.expect_<method>(…)` (and `x.expect_<method>_calls_in_order(…)`) attaches the stub.
    if (e.method?.startsWith('expect_')) {
      const mock = e.receiver?.kind === 'path' ? bindings.get(e.receiver.text) : undefined;
      if (mock) {
        const method = e.method.slice('expect_'.length).replace(/_calls_in_order$/, '');
        if (!mock.stubbedMembers.some((s) => s.name === method)) {
          mock.stubbedMembers.push({ name: method, span: spanOf(path, e.span), returnValues: [], api: 'unknown' });
        }
      }
    }
    // `.returns(v)` / `.returns_once(v)` — record a literal return for DRIFT-003. The stub is
    // attached here too (the `expect_<m>` receiver is walked *after* this branch).
    if (isMockiatoReturn(e.method) && e.args?.[0]) {
      let recv = e.receiver;
      while (recv?.kind === 'method-call' && !recv.method?.startsWith('expect_')) recv = recv.receiver;
      if (recv?.kind === 'method-call' && recv.method?.startsWith('expect_')) {
        const mock = recv.receiver?.kind === 'path' ? bindings.get(recv.receiver.text) : undefined;
        if (mock) {
          const method = recv.method.slice('expect_'.length).replace(/_calls_in_order$/, '');
          let stub = mock.stubbedMembers.find((s) => s.name === method);
          if (!stub) {
            stub = { name: method, span: spanOf(path, recv.span), returnValues: [], api: 'unknown' };
            mock.stubbedMembers.push(stub);
          }
          const value = literalType(e.args[0]);
          if (value.kind !== 'unknown') {
            stub.returnValues.push({
              span: spanOf(path, e.args[0].span),
              api: e.method,
              once: false,
              assignable: 'unknown',
              value,
            });
          }
        }
      }
    }
    // A real call on the mock (`greeter.greet(…)`) marks it reached.
    if (e.receiver?.kind === 'path' && bindings.has(e.receiver.text) && !e.method?.startsWith('expect_')) {
      markReached(bindings.get(e.receiver.text)!, path, e.span);
    }
  }

  if (e.receiver) scanMockiatoExpr(e.receiver, mocks, path, fnId, bindings);
  for (const a of e.args ?? []) scanMockiatoExpr(a, mocks, path, fnId, bindings);
  if (e.left) scanMockiatoExpr(e.left, mocks, path, fnId, bindings);
  if (e.right) scanMockiatoExpr(e.right, mocks, path, fnId, bindings);
  for (const s of e.stmts ?? []) scanMockiatoExpr(s, mocks, path, fnId, bindings);
}

// ---------------------------------------------------------------- mocktopus

/** The function/method name a mocktopus receiver mocks (`world`, `static_method`, `ref_method`). */
function mocktopusFnName(e: RustExpr | undefined): string | undefined {
  if (!e) return undefined;
  const last = (e.text ?? '').split('::').pop()?.split('.').pop()?.trim();
  return last && /^[A-Za-z_]\w*$/.test(last) ? last : undefined;
}

function mocktopusMockOf(path: string, span: RustSpan, target: string, fnId: string): MockIR {
  return {
    id: `${path}#mock:${span.line}:${span.column}`,
    span: spanOf(path, span),
    framework: 'mocktopus',
    pattern: 'mocktopus',
    // A mocked *function* has no member drift surface and no class target — the exportName is
    // informational only (the invocation is indirect through the SUT, so no return values are
    // recorded and TAUT-005 stays quiet).
    target: { kind: 'unknown', exportName: target, span: spanOf(path, span) },
    stubbedMembers: [],
    configuredValues: [],
    invocationSites: [],
    isAutomock: false,
    fnId,
  };
}

/**
 * mocktopus's mock API: `#[mockable]` on a fn/method/impl and `foo.mock_safe(…)` /
 * `foo.mock_raw(…)` replaces `foo` (the receiver) with the closure result. The `mock_safe` /
 * `mock_raw` method names never collide with mockall/mockito/wiremock/httpmock/mry/faux/mockers /
 * mockiato, so this pass runs unconditionally.
 */
function scanMocktopus(items: RustItem[], mocks: MockIR[], path: string): void {
  for (const item of items) {
    if (item.kind === 'fn' && item.attrs.some((a) => a.path === 'test')) {
      const fnId = `${path}#fn:${item.span.line}`;
      for (const expr of item.body) scanMocktopusExpr(expr, mocks, path, fnId);
    } else if (item.kind === 'mod') {
      scanMocktopus(item.items, mocks, path);
    }
  }
}

function scanMocktopusExpr(e: RustExpr, mocks: MockIR[], path: string, fnId: string): void {
  if (e.kind === 'method-call' && (e.method === 'mock_safe' || e.method === 'mock_raw')) {
    const name = mocktopusFnName(e.receiver);
    if (name) mocks.push(mocktopusMockOf(path, e.span, name, fnId));
  }
  if (e.receiver) scanMocktopusExpr(e.receiver, mocks, path, fnId);
  for (const a of e.args ?? []) scanMocktopusExpr(a, mocks, path, fnId);
  if (e.left) scanMocktopusExpr(e.left, mocks, path, fnId);
  if (e.right) scanMocktopusExpr(e.right, mocks, path, fnId);
  for (const s of e.stmts ?? []) scanMocktopusExpr(s, mocks, path, fnId);
}

// ---------------------------------------------------------------- mock_derive

function mockDeriveMockOf(path: string, span: RustSpan, target: string, fnId: string): MockIR {
  return {
    id: `${path}#mock:${span.line}:${span.column}`,
    span: spanOf(path, span),
    framework: 'mock_derive',
    pattern: 'mock_derive',
    target: { kind: 'class', exportName: target, span: spanOf(path, span) },
    stubbedMembers: [],
    configuredValues: [],
    invocationSites: [],
    isAutomock: false,
    fnId,
  };
}

function mockDeriveExternMockOf(path: string, span: RustSpan, fnName: string, fnId: string): MockIR {
  return {
    id: `${path}#mock:${span.line}:${span.column}`,
    span: spanOf(path, span),
    framework: 'mock_derive',
    pattern: 'mock_derive',
    // A mocked extern *function* has no class target and no member drift surface, and its
    // invocation is indirect (the SUT calls the extern fn by name) — so the exportName is
    // informational only and no stubs/return values are recorded (no false DRIFT/TAUT surface).
    target: { kind: 'unknown', exportName: fnName, span: spanOf(path, span) },
    stubbedMembers: [],
    configuredValues: [],
    invocationSites: [],
    isAutomock: false,
    fnId,
  };
}

/**
 * mock_derive's mock API: `#[mock] trait Name` generates `Mock<Name>` (instantiated via
 * `Mock<Name>::new()`, configured via `mock.method_<m>(…).first_call().set_result(v)` and
 * committed via `mock.set_<m>(…)`); `#[mock] extern "C" { … }` generates a static
 * `Extern<Abi>Mocks` mock (configured via `Extern<Abi>Mocks::method_<fn>()` +
 * `Extern<Abi>Mocks::set_<fn>(…)`). The mockall pass already skipped the `#[mock]` trait
 * constructors, so this pass owns them.
 */
function scanMockDerive(
  items: RustItem[],
  traitNames: Set<string>,
  externFns: Map<string, string[]>,
  mocks: MockIR[],
  path: string,
): void {
  for (const item of items) {
    if (item.kind === 'fn' && item.attrs.some((a) => a.path === 'test')) {
      const fnId = `${path}#fn:${item.span.line}`;
      const bindings = new Map<string, MockIR>(); // receiver var -> its mock_derive trait mock
      const externKeys = new Set<string>(); // `Extern<Abi>Mocks::<fn>` dedupe
      for (const expr of item.body)
        scanMockDeriveExpr(expr, traitNames, externFns, mocks, path, fnId, bindings, externKeys, undefined);
    } else if (item.kind === 'mod') {
      scanMockDerive(item.items, traitNames, externFns, mocks, path);
    }
  }
}

function scanMockDeriveExpr(
  e: RustExpr,
  traitNames: Set<string>,
  externFns: Map<string, string[]>,
  mocks: MockIR[],
  path: string,
  fnId: string,
  bindings: Map<string, MockIR>,
  externKeys: Set<string>,
  pendingBinding: string | undefined,
): void {
  const boundName = e.binding ?? pendingBinding;

  // `Mock<Name>::new()` — instantiate a mock_derive mock (the mockall pass already skipped these;
  // turbofish generics are stripped from the callee path, so `MockDatabaseDriver::<i32, i32>::new()`
  // reads as `MockDatabaseDriver::new`).
  if (e.kind === 'call' && e.callee?.text?.startsWith('Mock') && e.callee.text.endsWith('::new')) {
    const typeName = e.callee.text.replace(/^Mock/, '').split('::')[0]!;
    if (traitNames.has(typeName)) {
      const mock = mockDeriveMockOf(path, e.span, typeName, fnId);
      mocks.push(mock);
      if (boundName) bindings.set(boundName, mock);
    }
  }

  // `Extern<Abi>Mocks::method_<fn>()` — emit one static mock per foreign fn.
  if (e.kind === 'call' && e.callee?.kind === 'path') {
    const em = /^(.+?)::method_([A-Za-z_]\w*)$/.exec(e.callee.text);
    if (em && externFns.has(em[1]!)) {
      const key = `${em[1]}::${em[2]}`;
      if (!externKeys.has(key)) {
        externKeys.add(key);
        mocks.push(mockDeriveExternMockOf(path, e.span, em[2]!, fnId));
      }
    }
  }

  if (e.kind === 'method-call') {
    // `mock.method_<m>()` — the Method builder attaches the stub; `set_<m>(…)` commits it and
    // `set_fallback(…)` installs a fallback — neither carries a return value.
    if (e.method?.startsWith('method_') && e.receiver?.kind === 'path') {
      const mock = bindings.get(e.receiver.text);
      if (mock) {
        const name = e.method.slice('method_'.length);
        if (!mock.stubbedMembers.some((s) => s.name === name)) {
          mock.stubbedMembers.push({ name, span: spanOf(path, e.span), returnValues: [], api: 'unknown' });
        }
      }
    }
    // `.set_result(<literal>)` / `.return_result_of(|| <literal>)` — record a literal return for
    // DRIFT-003 (walk the `.first_call()/.second_call()/.nth_call()` chain up to the `method_<m>`
    // builder). `set_result` takes a bare literal; `return_result_of` takes a closure whose body may
    // be a single scalar literal (a computed/block closure carries no comparable literal).
    if ((e.method === 'set_result' || e.method === 'return_result_of') && e.args?.[0]) {
      let recv = e.receiver;
      while (recv?.kind === 'method-call' && !recv.method?.startsWith('method_')) recv = recv.receiver;
      if (recv?.kind === 'method-call' && recv.method?.startsWith('method_') && recv.receiver?.kind === 'path') {
        const mock = bindings.get(recv.receiver.text);
        if (mock) {
          const name = recv.method.slice('method_'.length);
          let stub = mock.stubbedMembers.find((s) => s.name === name);
          if (!stub) {
            stub = { name, span: spanOf(path, recv.span), returnValues: [], api: 'unknown' };
            mock.stubbedMembers.push(stub);
          }
          const value = e.method === 'return_result_of' ? closureLiteralType(e.args[0]) : literalType(e.args[0]);
          if (value.kind !== 'unknown') {
            stub.returnValues.push({
              span: spanOf(path, e.args[0].span),
              api: e.method,
              once: false,
              assignable: 'unknown',
              value,
            });
          }
        }
      }
    }
    // A real call on the mock (`mock.get_int()`) marks it reached; `method_*`/`set_*` are config.
    if (e.receiver?.kind === 'path' && e.method && !e.method.startsWith('method_') && !e.method.startsWith('set_')) {
      const mock = bindings.get(e.receiver.text);
      if (mock) markReached(mock, path, e.span);
    }
  }

  if (e.receiver)
    scanMockDeriveExpr(e.receiver, traitNames, externFns, mocks, path, fnId, bindings, externKeys, boundName);
  for (const a of e.args ?? [])
    scanMockDeriveExpr(a, traitNames, externFns, mocks, path, fnId, bindings, externKeys, boundName);
  if (e.left) scanMockDeriveExpr(e.left, traitNames, externFns, mocks, path, fnId, bindings, externKeys, boundName);
  if (e.right) scanMockDeriveExpr(e.right, traitNames, externFns, mocks, path, fnId, bindings, externKeys, boundName);
  for (const s of e.stmts ?? [])
    scanMockDeriveExpr(s, traitNames, externFns, mocks, path, fnId, bindings, externKeys, boundName);
}

// ---------------------------------------------------------------- galvanic

/**
 * galvanic-mock's mock API (`#[mockable]` + `#[use_mocks]`): a `#[mockable]` trait is instantiated
 * via `let mock = new_mock!(Trait);` (with optional generics `Trait<i32, f64, Assoc=String>` or an
 * explicit mock type name `new_mock!(Trait for MyMock)`), configured through the `given! { … }` and
 * `expect_interactions! { … }` macro DSL (`<mock as Trait>::method(…) then_return …`), and invoked
 * directly (`mock.method(…)`). The `given!`/`expect_interactions!` bodies are macro token streams
 * (opaque to syn), so returns are deliberately *not* recorded — the `then_return` values are
 * frequently closures/matchers (`then_return_from |&(a,)| a*2`) and the invocation sites sit inside
 * `assert_eq!`/`assert!` macros the parser can't see — avoiding false TAUT-005/DRIFT-003. Stub
 * member names are still recorded from the DSL (for DRIFT-001), and `mock.method()` marks the mock
 * reached.
 */
function scanGalvanic(items: RustItem[], mocks: MockIR[], path: string): void {
  for (const item of items) {
    if (item.kind === 'fn') {
      const fnId = `${path}#fn:${item.span.line}`;
      const bindings = new Map<string, MockIR>(); // receiver var -> its galvanic mock
      for (const expr of item.body) scanGalvanicExpr(expr, mocks, path, fnId, bindings);
    } else if (item.kind === 'mod') {
      scanGalvanic(item.items, mocks, path);
    }
  }
}

function scanGalvanicExpr(
  e: RustExpr,
  mocks: MockIR[],
  path: string,
  fnId: string,
  bindings: Map<string, MockIR>,
): void {
  // `let mock = new_mock!(Trait)` — instantiate a galvanic mock. The trait name is recovered from
  // the macro's first path arg (`new_mock!(TestTrait)`), falling back to the token text for the
  // generic (`TestTrait<i32, f64, Assoc=String>`) and `for MyMock` forms (which `macro_args` can't
  // parse into expressions).
  if (e.kind === 'macro' && e.macroPath === 'new_mock') {
    const target = galvanicTraitName(e);
    if (target) {
      const mock = galvanicMockOf(path, e.span, target, fnId);
      mocks.push(mock);
      if (e.binding) bindings.set(e.binding, mock);
    }
  }
  // `given! { <mock as Trait>::method(…) then_return …; … }` and
  // `expect_interactions! { <mock as Trait>::method(…) times 1; … }` — record the stubbed method
  // names for DRIFT-001 (the `<var as Trait>::method` shape ties each stub to its mock variable).
  if (e.kind === 'macro' && (e.macroPath === 'given' || e.macroPath === 'expect_interactions')) {
    const re = /<\s*([A-Za-z_]\w*)\s+as\s.+?>::\s*([A-Za-z_]\w*)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(e.text)) !== null) {
      const varName = m[1]!;
      const methodName = m[2]!;
      const mock = bindings.get(varName);
      if (mock && !mock.stubbedMembers.some((s) => s.name === methodName)) {
        mock.stubbedMembers.push({ name: methodName, span: spanOf(path, e.span), returnValues: [], api: 'unknown' });
      }
    }
  }
  // `mock.method(…)` — a real invocation marks the mock reached (no config methods exist on the
  // mock itself; `verify()` is a framework no-op that is harmless either way).
  if (e.kind === 'method-call' && e.receiver?.kind === 'path') {
    const mock = bindings.get(e.receiver.text);
    if (mock) markReached(mock, path, e.span);
  }

  if (e.receiver) scanGalvanicExpr(e.receiver, mocks, path, fnId, bindings);
  for (const a of e.args ?? []) scanGalvanicExpr(a, mocks, path, fnId, bindings);
  if (e.left) scanGalvanicExpr(e.left, mocks, path, fnId, bindings);
  if (e.right) scanGalvanicExpr(e.right, mocks, path, fnId, bindings);
  for (const s of e.stmts ?? []) scanGalvanicExpr(s, mocks, path, fnId, bindings);
}

/** Recover the mocked trait name from a `new_mock!(…)` invocation (last `::` path segment). */
function galvanicTraitName(e: RustExpr): string | null {
  let name: string | undefined;
  if (e.args?.[0]?.kind === 'path') name = e.args[0].text;
  else if (e.text)
    name = e.text
      .replace(/^new_mock\s*!\s*\(\s*/, '')
      .replace(/\s*\)\s*$/, '')
      .split(/\s+for\s+/)[0];
  if (!name) return null;
  // `new_mock!(EmptyTrait #[allow(dead_code)] #[allow(unused_variables)])` carries the mock's
  // own attributes after the trait name — strip them before taking the last path segment.
  name = name.replace(/#\s*\[[^\]]*\]/g, '');
  name = name.replace(/\s*<[^<>]*>\s*$/, '');
  const segs = name
    .split('::')
    .map((s) => s.trim())
    .filter(Boolean);
  return segs[segs.length - 1] ?? null;
}

function galvanicMockOf(path: string, span: RustSpan, target: string, fnId: string): MockIR {
  return {
    id: `${path}#mock:${span.line}:${span.column}`,
    span: spanOf(path, span),
    framework: 'galvanic',
    pattern: 'galvanic',
    target: { kind: 'class', exportName: target, span: spanOf(path, span) },
    stubbedMembers: [],
    configuredValues: [],
    invocationSites: [],
    isAutomock: false,
    fnId,
  };
}

function hasCallee(e: RustExpr, name: string): boolean {
  if (e.kind === 'call' && e.callee?.text === name) return true;
  if (e.receiver && hasCallee(e.receiver, name)) return true;
  for (const a of e.args ?? []) if (hasCallee(a, name)) return true;
  if (e.left && hasCallee(e.left, name)) return true;
  if (e.right && hasCallee(e.right, name)) return true;
  return false;
}

function findRoute(e: RustExpr): string | undefined {
  if (e.literal?.kind === 'string' && e.literal.value.startsWith('/')) return e.literal.value;
  if (e.receiver) {
    const r = findRoute(e.receiver);
    if (r) return r;
  }
  for (const a of e.args ?? []) {
    const r = findRoute(a);
    if (r) return r;
  }
  if (e.left) {
    const r = findRoute(e.left);
    if (r) return r;
  }
  if (e.right) {
    const r = findRoute(e.right);
    if (r) return r;
  }
  return undefined;
}

function mockOf(path: string, span: RustSpan, pattern: 'automock' | 'mock-macro', exportName: string | null): MockIR {
  return {
    id: `${path}#mock:${span.line}:${span.column}`,
    span: spanOf(path, span),
    framework: 'mockall',
    pattern,
    target: exportName
      ? { kind: 'class', exportName, span: spanOf(path, span) }
      : { kind: 'unknown', span: spanOf(path, span) },
    stubbedMembers: [],
    configuredValues: [],
    invocationSites: [],
    isAutomock: pattern === 'automock',
  };
}

function httpMock(
  path: string,
  span: RustSpan,
  pattern: 'mockito' | 'wiremock' | 'httpmock',
  route: string | undefined,
): MockIR {
  return {
    id: `${path}#mock:${span.line}:${span.column}`,
    span: spanOf(path, span),
    framework: pattern,
    pattern,
    target: route
      ? { kind: 'unknown', specifier: route, span: spanOf(path, span) }
      : { kind: 'unknown', span: spanOf(path, span) },
    stubbedMembers: [],
    configuredValues: [],
    invocationSites: [],
    isAutomock: false,
  };
}

function literalType(e: RustExpr): TypeIR {
  if (e.literal?.kind === 'int' || e.literal?.kind === 'float')
    return { kind: 'literal', value: Number(e.literal.value) };
  if (e.literal?.kind === 'bool') return { kind: 'literal', value: e.literal.value === 'true' };
  if (e.literal?.kind === 'string') return { kind: 'literal', value: e.literal.value };
  return { kind: 'unknown' };
}

/**
 * Extract a literal from a `return_result_of(|| <literal>)` closure. The syn-wasm serializer keeps a
 * bare closure as an `other` expr with its token text (`| | 10`, `move | | 20`); only a closure whose
 * *entire body* is a single scalar literal is comparable, so everything else (`move || { … }`,
 * `|| String::new()`, `move || x`) stays `unknown`.
 */
function closureLiteralType(e: RustExpr): TypeIR {
  if (e.kind !== 'other') return { kind: 'unknown' };
  const m =
    /^\s*(?:move\s*)?\|[^|]*\|\s*([0-9][0-9_]*(?:\.[0-9][0-9_]*)?|true|false|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*$/.exec(
      e.text,
    );
  if (!m) return { kind: 'unknown' };
  const body = m[1]!;
  if (body === 'true' || body === 'false') return { kind: 'literal', value: body === 'true' };
  if (body.startsWith('"') || body.startsWith("'")) return { kind: 'literal', value: body.slice(1, -1) };
  return { kind: 'literal', value: Number(body.replace(/_/g, '')) };
}

function spanOf(path: string, s: RustSpan): SourceSpan {
  return { file: path, startLine: s.line, startCol: s.column, endLine: s.line, endCol: s.column + 1 };
}
