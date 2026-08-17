/** unittest.mock / pytest-mock / monkeypatch test doubles -> MockIR (spec docs/02 §2.5, python catalog). */
import type {
  ConfiguredValueIR,
  MockFramework,
  MockIR,
  MockTarget,
  SourceSpan,
  StubbedMemberIR,
  SymbolIR,
  TypeIR,
} from '@momus/core';
import { span } from '@momus/core';
import { childField, end, start, textOf, walk, type SyntaxNode } from './tree.ts';

export interface PythonMockState {
  mocks: MockIR[];
  /** Binding entries per `scope:name` key, ordered by assignment line for shadowing semantics. */
  bindings: Map<string, Array<{ line: number; mock: MockIR }>>;
}

const FACTORY_NAMES = new Set(['Mock', 'MagicMock', 'AsyncMock', 'create_autospec']);

export function extractMocks(root: SyntaxNode, file: string, _symbols: SymbolIR[]): PythonMockState {
  const mocks: MockIR[] = [];
  const bindings = new Map<string, Array<{ line: number; mock: MockIR }>>();
  const byCall = new Map<string, MockIR>();

  const scopeOf = (node: SyntaxNode): number => enclosingFunctionStart(root, start(node).line + 1);
  const recordBinding = (scope: number, name: string, mock: MockIR): void => {
    const key = `${scope}:${name}`;
    const entries = bindings.get(key) ?? [];
    entries.push({ line: mock.span.startLine, mock });
    bindings.set(key, entries);
  };

  // Pass 1: mock-producing calls (assignments, with statements, bare calls).
  walk(root, (node) => {
    if (!node.isNamed) return;
    if (node.type === 'call') {
      const made = makeMock(file, node);
      if (!made) return;
      mocks.push(made.mock);
      byCall.set(posKey(node), made.mock);
      const binding = bindingNameFor(node);
      if (binding) recordBinding(scopeOf(node), binding, made.mock);
    }
  });

  // Pass 1b: `with patch.object(...) as m:` binds the mock to the `as` name.
  walk(root, (node) => {
    if (!node.isNamed || node.type !== 'with_item') return;
    const value = childField(node, 'value');
    const mock = value ? byCall.get(posKey(value)) : undefined;
    if (!mock) return;
    const alias = childField(node, 'alias');
    if (alias) recordBinding(scopeOf(node), textOf(alias), mock);
  });

  // Pass 2: configured values (`m.return_value = X`, `m.member.return_value = X`, side_effect).
  walk(root, (node) => {
    if (!node.isNamed || node.type !== 'assignment') return;
    const left = childField(node, 'left');
    const right = childField(node, 'right');
    if (!left || !right) return;
    const path = dottedPath(left);
    const last = path[path.length - 1];
    if (last !== 'return_value' && last !== 'side_effect') return;
    const baseName = path.slice(0, -1);
    const mock = resolveBinding(bindings, scopeOf(node), baseName[0] ?? '', nodeLine(node));
    if (!mock) return;
    const configured: ConfiguredValueIR = {
      span: nodeSpan(file, node),
      api: last,
      value: valueIR(right),
      once: false,
      assignable: 'unknown',
    };
    mock.configuredValues.push(configured);
    if (baseName.length > 1) {
      const memberName = baseName[baseName.length - 1]!;
      ensureStub(mock, memberName, file, node).returnValues.push(configured);
    }
  });

  return { mocks, bindings };
}

function makeMock(file: string, call: SyntaxNode): { mock: MockIR } | null {
  const fn = childField(call, 'function');
  if (!fn) return null;
  const path = dottedPath(fn);
  const last = path[path.length - 1] ?? '';
  const lastTwo = path.slice(-2).join('.');
  const framework: MockFramework = path[0] === 'mocker' || path[0] === 'monkeypatch' ? 'pytest' : 'unittest';
  const args = childField(call, 'arguments');

  if (lastTwo === 'patch.object') {
    const target = instanceMemberTarget(args, file);
    const mock = baseMock(file, call, 'patch-object', target, framework);
    attachKwargConfig(mock, args, file, stringArg(args, 1) ?? undefined);
    return { mock };
  }
  if (last === 'patch') {
    const spec = stringArg(args, 0);
    const mock = baseMock(
      file,
      call,
      'patch',
      spec ? { kind: 'module', specifier: spec, span: nodeSpan(file, args ?? call) } : undefined,
      framework,
    );
    return { mock };
  }
  if (FACTORY_NAMES.has(last)) {
    const specNode = kwargValue(args, 'spec');
    const target = specNode || last === 'create_autospec' ? classTarget(specNode ?? argAt(args, 0), file) : undefined;
    const mock = baseMock(file, call, 'autospec', target, framework);
    return { mock };
  }
  if (lastTwo === 'monkeypatch.setattr') {
    const obj = argAt(args, 0);
    const attr = stringArg(args, 1);
    const mock = baseMock(
      file,
      call,
      'monkeypatch',
      attr && obj ? { kind: 'instance-member', exportName: textOf(obj), memberName: attr, span: nodeSpan(file, obj) } : undefined,
      framework,
    );
    return { mock };
  }
  return null;
}

function baseMock(file: string, node: SyntaxNode, pattern: MockIR['pattern'], target: MockTarget | undefined, framework: MockFramework): MockIR {
  return {
    id: `${file}#mock:${nodeLine(node)}:${nodeColumn(node)}`,
    span: nodeSpan(file, node),
    framework,
    pattern,
    target,
    stubbedMembers: [],
    configuredValues: [],
    invocationSites: [],
    isAutomock: false,
  };
}

function instanceMemberTarget(args: SyntaxNode | null, file: string): MockTarget | undefined {
  const cls = argAt(args, 0);
  const member = stringArg(args, 1);
  if (!cls || !member) return undefined;
  return { kind: 'instance-member', exportName: textOf(cls), memberName: member, span: nodeSpan(file, cls) };
}

function classTarget(node: SyntaxNode | null, file: string): MockTarget | undefined {
  if (!node) return undefined;
  return { kind: 'class', exportName: textOf(node), span: nodeSpan(file, node) };
}

function attachKwargConfig(mock: MockIR, args: SyntaxNode | null, file: string, memberName?: string): void {
  for (const kw of keywordArgs(args)) {
    const name = textOf(childField(kw, 'name'));
    const value = childField(kw, 'value');
    if ((name === 'return_value' || name === 'side_effect') && value) {
      const configured: ConfiguredValueIR = {
        span: nodeSpan(file, kw),
        api: name,
        value: valueIR(value),
        once: false,
        assignable: 'unknown',
      };
      mock.configuredValues.push(configured);
      if (memberName) ensureStub(mock, memberName, file, kw).returnValues.push(configured);
    }
  }
}

function ensureStub(mock: MockIR, name: string, file: string, node: SyntaxNode): StubbedMemberIR {
  const existing = mock.stubbedMembers.find((s) => s.name === name);
  if (existing) return existing;
  const stub: StubbedMemberIR = { name, span: nodeSpan(file, node), returnValues: [], api: 'instance-member' };
  mock.stubbedMembers.push(stub);
  return stub;
}

// ---------------------------------------------------------------- helpers

/** The identifier path of an expression: `mocker.patch.object` -> ['mocker','patch','object']. */
export function dottedPath(node: SyntaxNode | null): string[] {
  if (!node) return [];
  if (node.type === 'identifier') return [textOf(node)];
  if (node.type === 'attribute') {
    return [...dottedPath(childField(node, 'object')), textOf(childField(node, 'attribute'))];
  }
  return [];
}

function bindingNameFor(call: SyntaxNode): string | null {
  const parent = call.parent;
  if (parent?.type === 'assignment' && childField(parent, 'right') === call) {
    const left = childField(parent, 'left');
    if (left?.type === 'identifier') return textOf(left);
  }
  return null;
}

function argAt(args: SyntaxNode | null, index: number): SyntaxNode | null {
  if (!args) return null;
  let seen = 0;
  for (const child of args.namedChildren) {
    if (child.type === 'keyword_argument') continue;
    if (seen === index) return child;
    seen++;
  }
  return null;
}

function keywordArgs(args: SyntaxNode | null): SyntaxNode[] {
  if (!args) return [];
  return args.namedChildren.filter((c) => c.type === 'keyword_argument');
}

function kwargValue(args: SyntaxNode | null, name: string): SyntaxNode | null {
  for (const kw of keywordArgs(args)) {
    if (textOf(childField(kw, 'name')) === name) return childField(kw, 'value');
  }
  return null;
}

function stringArg(args: SyntaxNode | null, index: number): string | null {
  return stringValue(argAt(args, index));
}

export function stringValue(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === 'string') {
    const content = node.namedChildren.find((c) => c.type === 'string_content');
    return content ? textOf(content) : textOf(node).replace(/^['"]|['"]$/g, '');
  }
  return null;
}

export function valueIR(node: SyntaxNode): TypeIR | undefined {
  switch (node.type) {
    case 'integer':
    case 'float':
      return { kind: 'literal', value: Number(textOf(node)) };
    case 'string':
      return { kind: 'literal', value: stringValue(node) ?? textOf(node) };
    case 'true':
      return { kind: 'literal', value: true };
    case 'false':
      return { kind: 'literal', value: false };
    case 'none':
      return { kind: 'null' };
    default:
      return undefined;
  }
}

/** Resolve a local variable name to the nearest mock bound at/above `node`'s line (scope-aware). */
export function resolveMockName(state: PythonMockState, root: SyntaxNode, name: string, node: SyntaxNode): MockIR | undefined {
  const line = nodeLine(node);
  const scope = enclosingFunctionStart(root, line);
  return resolveBinding(state.bindings, scope, name, line);
}

function resolveBinding(
  bindings: PythonMockState['bindings'],
  scope: number,
  name: string,
  line: number,
): MockIR | undefined {
  const entries = bindings.get(`${scope}:${name}`);
  if (!entries) return undefined;
  let best: MockIR | undefined;
  let bestLine = -1;
  for (const entry of entries) {
    if (entry.line <= line && entry.line > bestLine) {
      best = entry.mock;
      bestLine = entry.line;
    }
  }
  return best;
}

/** Start line of the innermost enclosing function, or 0 when top-level. */
function enclosingFunctionStart(root: SyntaxNode, line: number): number {
  let best = 0;
  let bestSize = Number.POSITIVE_INFINITY;
  walk(root, (node) => {
    if (!node.isNamed || node.type !== 'function_definition') return;
    const fnStart = start(node).line + 1;
    const fnEnd = end(node).line + 1;
    if (fnStart <= line && line <= fnEnd && fnEnd - fnStart < bestSize) {
      best = fnStart;
      bestSize = fnEnd - fnStart;
    }
  });
  return best;
}

function posKey(node: SyntaxNode): string {
  return `${nodeLine(node)}:${nodeColumn(node)}`;
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
