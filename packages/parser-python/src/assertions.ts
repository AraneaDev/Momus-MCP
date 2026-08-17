/** pytest/unittest assertions -> AssertionIR, with operand provenance and mock reachability. */
import type { AssertionIR, ConfiguredValueIR, ExprIR, MockIR, SourceSpan, TestFnIR } from '@momus/core';
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

export function extractTestFunctions(root: SyntaxNode, file: string): TestFnIR[] {
  const out: TestFnIR[] = [];
  walk(root, (node) => {
    if (!node.isNamed || node.type !== 'function_definition') return;
    const name = textOf(childField(node, 'name'));
    if (!name || !(name.startsWith('test') || name.endsWith('_test'))) return;
    out.push({
      id: `${file}#fn:${nodeLine(node)}`,
      span: nodeSpan(file, node),
      hasProductionCalls: false,
      productionCallCount: 0,
      assertionCount: 0,
    });
  });
  return out;
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
  if (!CALL_ASSERTIONS.has(name)) return null;
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
      const mock = baseName ? resolveMockName(state, rootOf(node), baseName, node) : undefined;
      const stub = mock && member ? mock.stubbedMembers.find((s) => s.name === member) : undefined;
      return { mock: mock ?? null, configured: stub?.returnValues[0] };
    }
    return { mock: null };
  }
  if (node.type === 'attribute') {
    const attr = textOf(childField(node, 'attribute'));
    if (attr === 'return_value' || attr === 'side_effect') {
      const base = childField(node, 'object');
      const baseName = rootName(base);
      const mock = baseName ? resolveMockName(state, rootOf(node), baseName, node) : undefined;
      return { mock: mock ?? null, configured: mock?.configuredValues[0] };
    }
  }
  return { mock: null };
}

function markReachableMocks(root: SyntaxNode, file: string, state: PythonMockState): void {
  walk(root, (node) => {
    if (!node.isNamed || node.type !== 'call') return;
    const path = dottedPath(childField(node, 'function'));
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
      const mock = resolveMockName(state, root, name, arg);
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
  if (last === 'object' && path[path.length - 2] === 'patch') return true;
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

function testFnSpans(root: SyntaxNode, file: string): Array<{ start: number; end: number; id: string }> {
  const out: Array<{ start: number; end: number; id: string }> = [];
  walk(root, (node) => {
    if (!node.isNamed || node.type !== 'function_definition') return;
    const name = textOf(childField(node, 'name'));
    if (!name || !(name.startsWith('test') || name.endsWith('_test'))) return;
    out.push({ start: nodeLine(node), end: end(node).line + 1, id: `${file}#fn:${nodeLine(node)}` });
  });
  return out;
}

function enclosingFn(fnSpans: Array<{ start: number; end: number; id: string }>, line: number): string {
  for (const fn of fnSpans) {
    if (fn.start <= line && line <= fn.end) return fn.id;
  }
  return '';
}

/** Walk up to the tree root (for scope resolution). */
function rootOf(node: SyntaxNode): SyntaxNode {
  let cur = node;
  while (cur.parent) cur = cur.parent;
  return cur;
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
