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
export function extractMocks(file: RustFile, path: string): MockIR[] {
  const mocks: MockIR[] = [];
  // mock! struct name -> implemented trait name (null = inherent methods only)
  const mockStructs = new Map<string, string | null>();
  collectMockStructs(file.items, mockStructs);
  collect(file.items, mocks, path, mockStructs);
  return mocks;
}

/** First pass: record the struct→trait mapping declared by every `mock! { … }` macro. */
function collectMockStructs(items: RustItem[], mockStructs: Map<string, string | null>): void {
  for (const item of items) {
    if (item.kind === 'macro' && (item.path === 'mock' || item.path === 'Mock')) {
      recordMockMacro(item, mockStructs);
    } else if (item.kind === 'mod') {
      collectMockStructs(item.items, mockStructs);
    }
  }
}

function recordMockMacro(m: RustMacroCall, mockStructs: Map<string, string | null>): void {
  const traitMatch = /impl\s+([A-Za-z_][\w:]*)\s+for\s+([A-Za-z_]\w*)/.exec(m.tokens);
  if (traitMatch) {
    const traitName = traitMatch[1]!.split('::').pop() ?? null;
    mockStructs.set(traitMatch[2]!, traitName);
    return;
  }
  const structMatch = /(?:pub\s+)?([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\{/.exec(m.tokens);
  if (structMatch) mockStructs.set(structMatch[1]!, null);
}

function collect(items: RustItem[], mocks: MockIR[], path: string, mockStructs: Map<string, string | null>): void {
  for (const item of items) {
    if (item.kind === 'fn' && item.attrs.some((a) => a.path === 'test')) {
      // variable name -> mock, so `m.foo()` invocations attach to the right mock
      const bindings = new Map<string, MockIR>();
      for (const expr of item.body) {
        walkExpr(expr, mocks, path, bindings, mockStructs);
        scanWiremock(expr, mocks, path);
      }
    } else if (item.kind === 'mod') {
      collect(item.items, mocks, path, mockStructs);
    }
  }
}

const WRAPPER_CONSTRUCTORS = new Set(['Box::new', 'Arc::new', 'Rc::new', 'Pin::new']);

/** The mock a path or wrapper constructor flows from, or undefined. */
function resolveMockRef(e: RustExpr | undefined, bindings: Map<string, MockIR>): MockIR | undefined {
  if (!e) return undefined;
  if (e.kind === 'path') return bindings.get(e.text);
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

function walkExpr(
  e: RustExpr,
  mocks: MockIR[],
  path: string,
  bindings: Map<string, MockIR>,
  mockStructs: Map<string, string | null>,
  pendingBinding?: string,
): void {
  // A `let NAME = <expr>;` binding applies to a `MockFoo::new()` anywhere in the initializer
  // (e.g. `let m = Box::new(MockFoo::new())`), so thread it down the expression tree.
  const boundName = e.binding ?? pendingBinding;
  if (e.kind === 'call' && e.callee?.text?.startsWith('Mock') && e.callee.text.endsWith('::new')) {
    // `MockRepo::new()` — strip the `Mock` prefix to recover the mocked type name.
    const typeName = e.callee.text.replace(/^Mock/, '').split('::')[0]!;
    const declared = mockStructs.get(typeName); // string (trait) | null (self-defined) | undefined (automock)
    const exportName = declared === undefined ? typeName : declared;
    const mock = mockOf(path, e.span, declared === undefined ? 'automock' : 'mock-macro', exportName);
    mocks.push(mock);
    if (boundName) bindings.set(boundName, mock);
  }

  if (e.kind === 'call' && e.callee?.text === 'mock') {
    const route = e.args?.map((a) => a.literal?.value).find((v) => v?.startsWith('/'));
    mocks.push(httpMock(path, e.span, 'mockito', route));
  }

  if (e.kind === 'method-call') {
    const mock = mocks[mocks.length - 1];
    if (
      e.method?.startsWith('expect_') &&
      mock &&
      !mock.stubbedMembers.some((s) => s.name === e.method!.slice('expect_'.length))
    ) {
      mock.stubbedMembers.push({
        name: e.method.slice('expect_'.length),
        span: spanOf(path, e.span),
        returnValues: [],
        api: 'unknown',
      });
    }
    if (e.method === 'returning' || e.method === 'return_const') {
      // Walk up a `.with(...)`/`.times(...)` chain to the `expect_X` call.
      let recv = e.receiver;
      while (recv?.kind === 'method-call' && !recv.method?.startsWith('expect_')) recv = recv.receiver;
      if (recv?.kind === 'method-call' && recv.method?.startsWith('expect_') && mock) {
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

  if (e.receiver) walkExpr(e.receiver, mocks, path, bindings, mockStructs, boundName);
  for (const a of e.args ?? []) walkExpr(a, mocks, path, bindings, mockStructs, boundName);
  if (e.left) walkExpr(e.left, mocks, path, bindings, mockStructs, boundName);
  if (e.right) walkExpr(e.right, mocks, path, bindings, mockStructs, boundName);
}

/** A `Mock::given(...).and(path("/x")).respond_with(...)` statement -> one wiremock mock. */
function scanWiremock(e: RustExpr, mocks: MockIR[], path: string): void {
  if (hasCallee(e, 'Mock::given')) {
    mocks.push(httpMock(path, e.span, 'wiremock', findRoute(e)));
  }
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

function httpMock(path: string, span: RustSpan, pattern: 'mockito' | 'wiremock', route: string | undefined): MockIR {
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

function spanOf(path: string, s: RustSpan): SourceSpan {
  return { file: path, startLine: s.line, startCol: s.column, endLine: s.line, endCol: s.column + 1 };
}
