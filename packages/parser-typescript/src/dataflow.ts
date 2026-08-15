/**
 * Assertion extraction + intra-procedural provenance (spec docs/03 §3.2).
 * Provenance model validated in the spike (E3): mock-config / mock-call /
 * production / literal / unknown, with configured-value echo detection.
 */
import * as ts from 'typescript';
import type {
  AssertionIR, ExprIR, ModuleIR, RawComment, SourceKind, SourceSpan, TestFnIR,
} from '@momus/core';
import { span } from '@momus/core';
import { extractComments } from './comments.ts';

const HELPER_ROOTS = new Set([
  'expect', 'vi', 'jest', 'it', 'test', 'describe', 'beforeEach', 'afterEach',
  'beforeAll', 'afterAll', 'xit', 'xtest', 'fit', 'fdescribe', 'it.skip', 'it.only',
]);

interface Scope {
  /** name -> initializer; mutable (let) bindings are not constant-provable. */
  bindings: Map<string, { expr: ts.Expression; mutable: boolean }>;
  mockInstanceIds: Map<string, string>;   // identifier -> mock id
  configs: Map<string, { valueText: string; mockId: string }>;  // 'mocked.getTotal' -> value
}

export interface DataflowResult {
  assertions: AssertionIR[];
  functions: TestFnIR[];
}

export function analyzeAssertions(
  sf: ts.SourceFile,
  imports: ModuleIR['imports'],
  instanceIds: Map<string, string>,
  framework: string | undefined,
): DataflowResult {
  const file = sf.fileName;
  const assertions: AssertionIR[] = [];
  const functions: TestFnIR[] = [];
  const pos = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart());
  const endPos = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getEnd());
  const mkSpan = (n: ts.Node): SourceSpan =>
    span(file, pos(n).line + 1, pos(n).character + 1, endPos(n).line + 1, endPos(n).character + 1);

  // names imported from test frameworks are helpers, never production roots
  const FRAMEWORK_SPECIFIERS = /^(vitest|@vitest\/.*|jest|@jest\/.*)$/;
  const importedNames = new Set(
    imports.filter((i) => !FRAMEWORK_SPECIFIERS.test(i.specifier)).flatMap((i) => i.names),
  );

  const isProductionRoot = (name: string): boolean => importedNames.has(name);

  function buildScope(body: ts.Block): Scope {
    const scope: Scope = { bindings: new Map(), mockInstanceIds: new Map(instanceIds), configs: new Map() };
    for (const st of body.statements) {
      if (!ts.isVariableStatement(st)) continue;
      const mutable = (st.declarationList.flags & ts.NodeFlags.Const) === 0;
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        const init = stripAwait(d.initializer);
        scope.bindings.set(d.name.text, { expr: init, mutable });
      }
    }
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const name = callName(n.expression);
        const m = name?.match(/^(.*)\.mock(ReturnValue|ResolvedValue|ReturnValueOnce|ResolvedValueOnce|RejectedValue|RejectedValueOnce)$/);
        if (m) {
          const keyExpr = (n.expression as ts.PropertyAccessExpression).expression;
          const key = keyExpr.getText(sf);
          const val = n.arguments[0];
          const valText = val ? val.getText(sf) : '';
          const owner = ownerOf(keyExpr, sf);
          const mockId = owner ? scope.mockInstanceIds.get(owner) : undefined;
          scope.configs.set(key, { valueText: valText, mockId: mockId ?? '' });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
    return scope;
  }

  function provenance(expr: ts.Expression, scope: Scope): { kind: SourceKind; mockRefs: string[]; configuredValue?: string; constant: boolean } {
    if (ts.isNumericLiteral(expr) || ts.isStringLiteral(expr) || expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword || expr.kind === ts.SyntaxKind.NullKeyword) {
      return { kind: 'literal', mockRefs: [], constant: true };
    }
    if (ts.isIdentifier(expr)) {
      if (scope.mockInstanceIds.has(expr.text)) {
        return { kind: 'mock-call', mockRefs: [scope.mockInstanceIds.get(expr.text)!], constant: false };
      }
      const bound = scope.bindings.get(expr.text);
      if (bound) {
        // let/var bindings can be reassigned: never constant-provable
        if (bound.mutable) return { kind: 'unknown', mockRefs: [], constant: false };
        return provenance(bound.expr, scope);
      }
      return { kind: 'unknown', mockRefs: [], constant: false };
    }
    if (ts.isCallExpression(expr)) {
      const callee = expr.expression.getText(sf);
      const cfg = scope.configs.get(callee);
      if (cfg) {
        return { kind: 'mock-config', mockRefs: cfg.mockId ? [cfg.mockId] : [], configuredValue: cfg.valueText, constant: false };
      }
      if (ts.isPropertyAccessExpression(expr.expression)) {
        const owner = ownerOf(expr.expression.expression, sf);
        if (owner && scope.mockInstanceIds.has(owner)) {
          return { kind: 'mock-call', mockRefs: [scope.mockInstanceIds.get(owner)!], constant: false };
        }
      }
      const root = rootOf(expr.expression);
      if (root && isProductionRoot(root)) return { kind: 'production', mockRefs: [], constant: false };
      if (root && scope.bindings.has(root)) {
        const b = scope.bindings.get(root)!;
        if (ts.isNewExpression(stripCast(b.expr)) || isProductionRoot(root)) {
          return { kind: 'production', mockRefs: [], constant: false };
        }
      }
      return { kind: 'unknown', mockRefs: [], constant: false };
    }
    if (ts.isPropertyAccessExpression(expr)) {
      const base = expr.expression.getText(sf);
      if (ts.isIdentifier(expr.expression)) {
        const bound = scope.bindings.get(expr.expression.text);
        if (bound) return provenance(bound.expr, scope);
      }
      if (scope.mockInstanceIds.has(base)) {
        return { kind: 'mock-call', mockRefs: [scope.mockInstanceIds.get(base)!], constant: false };
      }
      return { kind: 'unknown', mockRefs: [], constant: false };
    }
    if (ts.isNewExpression(expr)) {
      return { kind: 'production', mockRefs: [], constant: false };
    }
    return { kind: 'unknown', mockRefs: [], constant: false };
  }

  function productionCalls(body: ts.Block, scope: Scope): number {
    let count = 0;
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const root = rootOf(n.expression);
        if (!root || HELPER_ROOTS.has(root)) { ts.forEachChild(n, visit); return; }
        if (scope.mockInstanceIds.has(root)) { ts.forEachChild(n, visit); return; }
        const bound = scope.bindings.get(root);
        if (bound && ts.isNewExpression(stripCast(bound.expr))) { count++; }
        else if (isProductionRoot(root)) { count++; }
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
    return count;
  }

  // ---- collect test functions (it/test callbacks + describe for stats)
  const testFns: TestFnIR[] = [];
  const collectFns = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const name = callName(n.expression);
      if ((name === 'it' || name === 'test') && n.arguments[1] && (ts.isArrowFunction(n.arguments[1]) || ts.isFunctionExpression(n.arguments[1]))) {
        const fn = n.arguments[1];
        const body = (fn as ts.ArrowFunction).body;
        if (ts.isBlock(body)) {
          const id = `${file}#fn:${pos(n).line + 1}`;
          const scope = buildScope(body);
          testFns.push({
            id,
            span: mkSpan(body),
            hasProductionCalls: productionCalls(body, scope) > 0,
            productionCallCount: productionCalls(body, scope),
            assertionCount: 0, // filled below
          });
        }
      }
    }
    ts.forEachChild(n, collectFns);
  };
  collectFns(sf);

  // ---- assertions
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      if (name === 'expect' || name === 'vi.expect') {
        let matcherCall: ts.CallExpression | undefined;
        let p: ts.Node | undefined = node.parent;
        while (p && ts.isPropertyAccessExpression(p)) p = p.parent;
        if (p && ts.isCallExpression(p)) matcherCall = p;
        if (matcherCall) {
          const matcher = ts.isPropertyAccessExpression(matcherCall.expression) ? matcherCall.expression.name.text : undefined;
          if (matcher) {
            let expectCall: ts.Node = matcherCall.expression;
            while (ts.isPropertyAccessExpression(expectCall)) expectCall = expectCall.expression;
            const left = ts.isCallExpression(expectCall) ? expectCall.arguments[0] : undefined;
            const right = matcherCall.arguments[0];
            const fnBody = enclosingBlock(node);
            const scope = fnBody ? buildScope(fnBody) : { bindings: new Map(), mockInstanceIds: new Map(instanceIds), configs: new Map() };
            const operands: ExprIR[] = [];
            if (left) operands.push(toExpr(left, scope));
            if (right) operands.push(toExpr(right, scope));
            const fnId = testFns.find((f) => f.span.startLine <= pos(node).line + 1 && pos(node).line + 1 <= f.span.endLine)?.id ?? '';
            assertions.push({
              id: `${file}#assert:${pos(node).line + 1}:${pos(node).character + 1}`,
              span: mkSpan(matcherCall),
              api: matcher,
              operands,
              fnId,
            });
            const fn = testFns.find((f) => f.id === fnId);
            if (fn) fn.assertionCount++;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { assertions, functions: testFns };

  function toExpr(e: ts.Expression, scope: Scope): ExprIR {
    const p = provenance(e, scope);
    return {
      kind: ts.isLiteralExpression(e) ? 'literal' : ts.isCallExpression(e) ? 'call' : ts.isPropertyAccessExpression(e) ? 'member' : ts.isIdentifier(e) ? 'identifier' : ts.isNewExpression(e) ? 'new' : 'unknown',
      text: e.getText(sf),
      mockRefs: p.mockRefs,
      provenance: p.kind,
      configuredValue: p.configuredValue,
      constant: p.constant,
    };
  }
}

function enclosingBlock(n: ts.Node): ts.Block | undefined {
  let p: ts.Node | undefined = n.parent;
  while (p) {
    if (ts.isBlock(p)) return p;
    p = p.parent;
  }
  return undefined;
}

function stripAwait(e: ts.Expression): ts.Expression {
  return ts.isAwaitExpression(e) ? e.expression : e;
}

const stripCast = (e: ts.Expression): ts.Expression =>
  ts.isAsExpression(e) ? stripCast(e.expression) : ts.isParenthesizedExpression(e) ? stripCast(e.expression) : e;

const callName = (n: ts.Expression): string | null => {
  if (ts.isIdentifier(n)) return n.text;
  if (ts.isPropertyAccessExpression(n)) {
    const base = callName(n.expression);
    return base ? base + '.' + n.name.text : null;
  }
  return null;
};

function rootOf(e: ts.Expression): string | undefined {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return rootOf(e.expression);
  if (ts.isCallExpression(e)) return rootOf(e.expression);
  return undefined;
}

function ownerOf(e: ts.Expression, sf: ts.SourceFile): string | undefined {
  const text = e.getText(sf);
  return text.match(/^([A-Za-z_$][\w$]*)/)?.[1];
}

export function extractCommentsForModule(sf: ts.SourceFile, source: string): RawComment[] {
  void sf;
  return extractComments(source);
}
