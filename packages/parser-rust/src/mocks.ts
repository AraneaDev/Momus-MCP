import type { MockIR, SourceSpan, TypeIR } from '@momus/core';
import type { RustExpr, RustFile, RustItem, RustMacroCall, RustSpan } from './ast.ts';
import { extractImports } from './imports.ts';
import type { RustCrateIndex } from './crateIndex.ts';

export function extractMocks(file: RustFile, path: string, index: RustCrateIndex): MockIR[] {
  // local name -> use specifier, so MockRepo::new() resolves "Repo" to its trait path.
  const imports = new Map<string, string>();
  for (const imp of extractImports(file)) {
    const local = imp.names[0] ?? imp.specifier.split('::').pop() ?? imp.specifier;
    imports.set(local, imp.specifier);
  }
  const mocks: MockIR[] = [];
  collect(file.items, mocks, path, index, imports);
  return mocks;
}

function collect(
  items: RustItem[],
  mocks: MockIR[],
  path: string,
  index: RustCrateIndex,
  imports: Map<string, string>,
): void {
  for (const item of items) {
    if (item.kind === 'macro' && (item.path === 'mock' || item.path === 'Mock')) {
      mocks.push(fromMockMacro(item, path, index));
    } else if (item.kind === 'fn' && item.attrs.some((a) => a.path === 'test')) {
      for (const expr of item.body) {
        walkExpr(expr, mocks, path, index, imports);
        scanWiremock(expr, mocks, path);
      }
    } else if (item.kind === 'mod') {
      collect(item.items, mocks, path, index, imports);
    }
  }
}

function walkExpr(
  e: RustExpr,
  mocks: MockIR[],
  path: string,
  index: RustCrateIndex,
  imports: Map<string, string>,
): void {
  if (e.kind === 'call' && e.callee?.text?.endsWith('::new') && e.callee.text.startsWith('Mock')) {
    const typeName = e.callee.text.replace(/^Mock/, '').replace(/::new$/, '');
    const spec = imports.get(typeName);
    const symbolId = spec ? index.resolveSymbolId(spec) : null;
    mocks.push(mockOf(path, e.span, 'automock', symbolId));
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
  }

  if (e.receiver) walkExpr(e.receiver, mocks, path, index, imports);
  for (const a of e.args ?? []) walkExpr(a, mocks, path, index, imports);
  if (e.left) walkExpr(e.left, mocks, path, index, imports);
  if (e.right) walkExpr(e.right, mocks, path, index, imports);
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

function fromMockMacro(m: RustMacroCall, path: string, index: RustCrateIndex): MockIR {
  const traitMatch = /impl\s+([A-Za-z0-9_:]+)\s+for\s+([A-Za-z0-9_]+)/.exec(m.tokens);
  const members = [...m.tokens.matchAll(/fn\s+(\w+)\s*\(/g)].map((x) => x[1]!);
  const symbolId = traitMatch ? index.resolveSymbolId(traitMatch[1]!) : null;
  return mockOf(path, m.span, 'mock-macro', symbolId, members);
}

function mockOf(
  path: string,
  span: RustSpan,
  pattern: 'automock' | 'mock-macro',
  symbolId: string | null,
  members: string[] = [],
): MockIR {
  return {
    id: `${path}#mock:${span.line}:${span.column}`,
    span: spanOf(path, span),
    framework: 'mockall',
    pattern,
    target: symbolId
      ? { kind: 'class', symbolId, span: spanOf(path, span) }
      : { kind: 'unknown', span: spanOf(path, span) },
    stubbedMembers: members.map((name) => ({ name, span: spanOf(path, span), returnValues: [], api: 'unknown' })),
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
