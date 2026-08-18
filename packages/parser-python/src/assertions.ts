/** pytest/unittest assertions -> AssertionIR, with operand provenance and mock reachability. */
import type { AssertionIR, ConfiguredValueIR, ExprIR, ImportIR, MockIR, SourceSpan, TestFnIR } from '@momus/core';
import { span } from '@momus/core';
import { childField, end, start, textOf, walk, type SyntaxNode } from './tree.ts';
import { dottedPath, resolveMockName, type PythonMockState } from './mocks.ts';

const CALL_ASSERTIONS = new Set([
  'assertEqual',
  'assertNotEqual',
  'assertTrue',
  'assertFalse',
  'assertIs',
  'assertIsNot',
]);

/** Mock spy assertions (`m.assert_called*()`): the operand is the mock the call is made on. */
const SPY_ASSERTIONS = new Set([
  'assert_called',
  'assert_called_once',
  'assert_called_with',
  'assert_called_once_with',
  'assert_not_called',
]);

export function extractAssertions(root: SyntaxNode, file: string, state: PythonMockState): AssertionIR[] {
  const fnSpans = testFnSpans(root, file);
  const assertions: AssertionIR[] = [];

  walk(root, (node) => {
    if (!node.isNamed) return;
    if (node.type === 'assert_statement') {
      const a = assertionFromAssert(node, file, state, fnSpans);
      if (a) assertions.push(a);
    } else if (node.type === 'call') {
      const a = assertionFromCall(node, file, state, fnSpans);
      if (a) assertions.push(a);
    }
  });

  markReachableMocks(root, file, state);

  return assertions;
}

/**
 * Test-framework / mocking specifiers: names imported from these are helpers (assertions,
 * mock factories, fixtures), never production. Mirrors the TS `FRAMEWORK_SPECIFIERS` heuristic
 * in dataflow.ts (`vitest`/`jest`).
 */
function isFrameworkSpecifier(specifier: string): boolean {
  return (
    specifier === 'unittest' ||
    specifier.startsWith('unittest.') ||
    specifier === 'mock' ||
    specifier.startsWith('mock.') ||
    specifier === 'pytest' ||
    specifier.startsWith('pytest.') ||
    specifier.startsWith('pytest_') ||
    specifier.startsWith('_pytest') ||
    specifier === 'django.test' ||
    specifier.startsWith('django.test.')
  );
}

/**
 * A test function "touches production" when it calls a name imported from a non-framework
 * module (the SUT or a real/stdlib dependency) — the Python analogue of the TS `productionCalls`
 * pass. TAUT-004/006 consult `hasProductionCalls` to avoid flagging tests whose mock assertions
 * sit alongside a genuine production call (django dogfood: 25 false positives from
 * `call_command(...)` / `F(...)` / `feedgenerator.Stylesheet(...)` / `copy.copy(...)` misread
 * as mock-only/spy-without-a-call-path).
 */
export function extractTestFunctions(
  root: SyntaxNode,
  file: string,
  imports: ImportIR[],
  state: PythonMockState,
): TestFnIR[] {
  const productionRoots = new Set(imports.filter((i) => !isFrameworkSpecifier(i.specifier)).flatMap((i) => i.names));

  const fnSpans = testFnSpans(root, file);
  const counts = new Map<string, number>();
  walk(root, (node) => {
    if (!node.isNamed || node.type !== 'call') return;
    const rootName = dottedPath(childField(node, 'function'))[0];
    if (!rootName || !productionRoots.has(rootName)) return;
    // A mock binding (`m = Mock()` then `m.method()`) shadows an imported name — never production.
    if (resolveMockName(state, rootName, node)) return;
    const fnId = enclosingFn(fnSpans, nodeLine(node));
    if (!fnId) return;
    counts.set(fnId, (counts.get(fnId) ?? 0) + 1);
  });

  return fnSpans.map((f) => {
    const productionCallCount = counts.get(f.id) ?? 0;
    return {
      id: f.id,
      span: f.span,
      hasProductionCalls: productionCallCount > 0,
      productionCallCount,
      assertionCount: 0,
    };
  });
}

function assertionFromAssert(
  node: SyntaxNode,
  file: string,
  state: PythonMockState,
  fnSpans: Array<{ start: number; end: number; id: string }>,
): AssertionIR | null {
  const cmp = node.namedChildren.find((c) => c.type === 'comparison_operator' || c.type === 'binary_operator');
  if (!cmp) return null;
  // The operator (`==`, `is`, `in`, …) is an UNNAMED node, so namedChildren holds just the operands.
  const kids = cmp.namedChildren;
  if (kids.length < 2) return null;
  const left = kids[0]!;
  const right = kids[kids.length - 1]!;
  const op = textOf(childField(cmp, 'operators')) || textOf(childField(cmp, 'operator')) || '==';
  return {
    id: `${file}#assert:${nodeLine(node)}:${nodeColumn(node)}`,
    span: nodeSpan(file, node),
    api: op,
    operands: [exprIR(left, file, state), exprIR(right, file, state)],
    fnId: enclosingFn(fnSpans, nodeLine(node)),
  };
}

function assertionFromCall(
  node: SyntaxNode,
  file: string,
  state: PythonMockState,
  fnSpans: Array<{ start: number; end: number; id: string }>,
): AssertionIR | null {
  const fn = childField(node, 'function');
  if (fn?.type !== 'attribute') return null;
  const name = textOf(childField(fn, 'attribute'));
  const isSpy = SPY_ASSERTIONS.has(name);
  if (!isSpy && !CALL_ASSERTIONS.has(name)) return null;
  if (isSpy) {
    // `m.assert_called*()` / `m.assert_not_called()`: the operand is the mock the call is on.
    const base = childField(fn, 'object');
    const baseName = rootName(base);
    const mock = baseName ? resolveMockName(state, baseName, node) : undefined;
    return {
      id: `${file}#assert:${nodeLine(node)}:${nodeColumn(node)}`,
      span: nodeSpan(file, node),
      api: name,
      operands: [
        {
          kind: 'call',
          text: textOf(node),
          mockRefs: mock ? [mock.id] : [],
          provenance: mock ? 'mock-call' : 'unknown',
          constant: false,
        },
      ],
      fnId: enclosingFn(fnSpans, nodeLine(node)),
    };
  }
  const args = childField(node, 'arguments')?.namedChildren.filter((c) => c.type !== 'keyword_argument') ?? [];
  if (args.length === 0) return null;
  const operands = args.slice(0, 2).map((a) => exprIR(a, file, state));
  return {
    id: `${file}#assert:${nodeLine(node)}:${nodeColumn(node)}`,
    span: nodeSpan(file, node),
    api: name,
    operands,
    fnId: enclosingFn(fnSpans, nodeLine(node)),
  };
}

function exprIR(node: SyntaxNode, file: string, state: PythonMockState): ExprIR {
  const text = textOf(node);
  if (
    node.type === 'integer' ||
    node.type === 'float' ||
    node.type === 'string' ||
    node.type === 'true' ||
    node.type === 'false' ||
    node.type === 'none'
  ) {
    return { kind: 'literal', text, mockRefs: [], provenance: 'literal', constant: true };
  }
  const access = mockAccess(node, state);
  if (access.mock) {
    if (access.configured) {
      return {
        kind: exprKind(node),
        text,
        mockRefs: [access.mock.id],
        provenance: 'mock-config',
        configuredValue: configuredText(access.configured),
        constant: false,
      };
    }
    return { kind: exprKind(node), text, mockRefs: [access.mock.id], provenance: 'mock-call', constant: false };
  }
  return { kind: exprKind(node), text, mockRefs: [], provenance: 'unknown', constant: false };
}

function mockAccess(node: SyntaxNode, state: PythonMockState): { mock: MockIR | null; configured?: ConfiguredValueIR } {
  if (node.type === 'call') {
    const fn = childField(node, 'function');
    if (fn?.type === 'attribute') {
      const base = childField(fn, 'object');
      const member = textOf(childField(fn, 'attribute'));
      const baseName = rootName(base);
      const mock = baseName ? resolveMockName(state, baseName, node) : undefined;
      const stub = mock && member ? mock.stubbedMembers.find((s) => s.name === member) : undefined;
      return { mock: mock ?? null, configured: stub?.returnValues[0] };
    }
    // A direct `m()` call on a `Mock(return_value=42)` bound variable: the mock's own `__call__`
    // is configured, so the operand carries the configured value for TAUT-002 (echo).
    if (fn?.type === 'identifier') {
      const mock = resolveMockName(state, textOf(fn), node);
      return { mock: mock ?? null, configured: mock?.configuredValues[0] };
    }
    return { mock: null };
  }
  if (node.type === 'attribute') {
    const attr = textOf(childField(node, 'attribute'));
    if (attr === 'return_value' || attr === 'side_effect') {
      const base = childField(node, 'object');
      const baseName = rootName(base);
      const mock = baseName ? resolveMockName(state, baseName, node) : undefined;
      return { mock: mock ?? null, configured: mock?.configuredValues[0] };
    }
  }
  return { mock: null };
}

function markReachableMocks(root: SyntaxNode, file: string, state: PythonMockState): void {
  walk(root, (node) => {
    if (!node.isNamed || node.type !== 'call') return;
    const fn = childField(node, 'function');
    // A direct call on a bound mock variable (`m()`) invokes the mock's own `__call__` — mark it
    // reached so `m = Mock(return_value=42); result = m()` is not a zero-reach stub (TAUT-005).
    if (fn?.type === 'identifier') {
      const mock = resolveMockName(state, textOf(fn), node);
      if (mock) {
        const line = nodeLine(node);
        if (!mock.invocationSites.some((s) => s.startLine === line)) {
          mock.invocationSites.push(nodeSpan(file, node));
        }
        return; // direct mock call — no positional-arg hand-off
      }
      // A plain `run(m)` call (identifier callee, not a mock): fall through to positional hand-off.
    }
    const path = dottedPath(fn);
    // Skip mock-factory calls (Mock(...), patch(...)) and mock-member config calls (m.method()).
    if (
      path.length === 0 ||
      isMockFactory(path) ||
      path[path.length - 1] === 'return_value' ||
      path[path.length - 1] === 'side_effect'
    )
      return;
    const args = childField(node, 'arguments');
    for (const arg of args?.namedChildren ?? []) {
      if (arg.type === 'keyword_argument') continue;
      const name = rootName(arg);
      if (!name) continue;
      const mock = resolveMockName(state, name, arg);
      if (mock) {
        const line = nodeLine(node);
        if (!mock.invocationSites.some((s) => s.startLine === line)) {
          mock.invocationSites.push(nodeSpan(file, node));
        }
      }
    }
  });

  // A mock handed off via `return_value=m` / `side_effect=m` on a factory
  // (`patch.object(X, "m", return_value=cursor)`, `Mock(return_value=other)`) is injected into the
  // SUT's graph: production invokes it *indirectly*, which the positional-arg walk above can't
  // observe (django dogfood: `cursor` injected as a patch's `return_value` then exercised by
  // `compiler.execute_sql`). Mark it reached so TAUT-005 stays quiet.
  walk(root, (node) => {
    if (!node.isNamed || node.type !== 'call') return;
    if (!isMockFactory(dottedPath(childField(node, 'function')))) return;
    const args = childField(node, 'arguments');
    for (const kw of args?.namedChildren ?? []) {
      if (kw.type !== 'keyword_argument') continue;
      const kwName = textOf(childField(kw, 'name'));
      if (kwName !== 'return_value' && kwName !== 'side_effect') continue;
      const value = childField(kw, 'value');
      const name = value ? rootName(value) : null;
      if (!name || !value) continue;
      const mock = resolveMockName(state, name, value);
      if (mock) {
        const line = nodeLine(node);
        if (!mock.invocationSites.some((s) => s.startLine === line)) {
          mock.invocationSites.push(nodeSpan(file, node));
        }
      }
    }
  });
}

function isMockFactory(path: string[]): boolean {
  const last = path[path.length - 1] ?? '';
  if (last === 'Mock' || last === 'MagicMock' || last === 'AsyncMock' || last === 'create_autospec' || last === 'patch')
    return true;
  if (path[path.length - 2] === 'patch') return true; // patch.object / patch.multiple / patch.dict
  if (last === 'setattr' && path[path.length - 2] === 'monkeypatch') return true;
  return false;
}

/** Leftmost identifier of a dotted expression (`m.method()` -> 'm'). */
function rootName(node: SyntaxNode | null): string | null {
  return dottedPath(node)[0] ?? null;
}

function configuredText(c: ConfiguredValueIR): string | undefined {
  const v = c.value;
  if (!v) return undefined;
  if (v.kind === 'literal') return String(v.value);
  if (v.kind === 'named') return v.name;
  if (v.kind === 'null') return 'None';
  return undefined;
}

function exprKind(node: SyntaxNode): ExprIR['kind'] {
  switch (node.type) {
    case 'identifier':
      return 'identifier';
    case 'call':
      return 'call';
    case 'attribute':
      return 'member';
    case 'integer':
    case 'float':
    case 'string':
    case 'true':
    case 'false':
    case 'none':
      return 'literal';
    default:
      return 'unknown';
  }
}

function testFnSpans(
  root: SyntaxNode,
  file: string,
): Array<{ start: number; end: number; id: string; span: SourceSpan }> {
  const out: Array<{ start: number; end: number; id: string; span: SourceSpan }> = [];
  walk(root, (node) => {
    if (!node.isNamed || node.type !== 'function_definition') return;
    const name = textOf(childField(node, 'name'));
    if (!name || !(name.startsWith('test') || name.endsWith('_test'))) return;
    out.push({
      start: nodeLine(node),
      end: end(node).line + 1,
      id: `${file}#fn:${nodeLine(node)}`,
      span: nodeSpan(file, node),
    });
  });
  return out;
}

function enclosingFn(fnSpans: Array<{ start: number; end: number; id: string }>, line: number): string {
  for (const fn of fnSpans) {
    if (fn.start <= line && line <= fn.end) return fn.id;
  }
  return '';
}

function nodeLine(node: SyntaxNode): number {
  return start(node).line + 1;
}

function nodeColumn(node: SyntaxNode): number {
  return start(node).column + 1;
}

function nodeSpan(file: string, node: SyntaxNode): SourceSpan {
  return span(file, nodeLine(node), nodeColumn(node), end(node).line + 1, end(node).column + 1);
}
