/**
 * Assertion extraction + intra-procedural provenance (spec docs/03 §3.2).
 * Provenance model validated in the spike (E3): mock-config / mock-call /
 * production / literal / unknown, with configured-value echo detection.
 */
import * as ts from 'typescript';
import type { AssertionIR, ExprIR, ModuleIR, SourceKind, SourceSpan, TestFnIR } from '@momus/core';
import { span } from '@momus/core';

const HELPER_ROOTS = new Set([
  'expect',
  'vi',
  'jest',
  'it',
  'test',
  'describe',
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
  'xit',
  'xtest',
  'fit',
  'fdescribe',
  'it.skip',
  'it.only',
]);

interface Scope {
  /** name -> initializer; mutable (let) bindings are not constant-provable. */
  bindings: Map<string, { expr: ts.Expression; mutable: boolean }>;
  mockInstanceIds: Map<string, string>; // identifier -> mock id
  configs: Map<string, { valueText: string; mockId: string }>; // 'mocked.getTotal' -> value
}

export interface DataflowResult {
  assertions: AssertionIR[];
  functions: TestFnIR[];
}

export function analyzeAssertions(
  sf: ts.SourceFile,
  imports: ModuleIR['imports'],
  instanceIds: Map<string, string>,
  _framework: string | undefined,
): DataflowResult {
  const file = sf.fileName;
  const assertions: AssertionIR[] = [];
  const pos = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart());
  const endPos = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getEnd());
  const mkSpan = (n: ts.Node): SourceSpan =>
    span(file, pos(n).line + 1, pos(n).character + 1, endPos(n).line + 1, endPos(n).character + 1);

  // names imported from test frameworks are helpers, never production roots
  const FRAMEWORK_SPECIFIERS = /^(vitest|@vitest\/.*|jest|@jest\/.*)$/;
  const importedNames = new Set(imports.filter((i) => !FRAMEWORK_SPECIFIERS.test(i.specifier)).flatMap((i) => i.names));

  // A test that must register `vi.mock` factories before the subject loads imports the subject
  // dynamically (`const { resolveTargets } = await import('../triage/discover-targets.js')`).
  // Those names are production roots exactly like a static import's — without them the SUT's
  // return value reads as `unknown` and MOCK-001 reports "0 production-provenance assertions"
  // for a test that asserts nothing else (Chaos-MCP dogfood, docs/11).
  const collectDynamicImportNames = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const init = stripAwait(n.initializer);
      if (
        ts.isCallExpression(init) &&
        init.expression.kind === ts.SyntaxKind.ImportKeyword &&
        ts.isStringLiteral(init.arguments[0] ?? ({} as ts.Node)) &&
        !FRAMEWORK_SPECIFIERS.test((init.arguments[0] as ts.StringLiteral).text)
      ) {
        if (ts.isIdentifier(n.name)) importedNames.add(n.name.text);
        else if (ts.isObjectBindingPattern(n.name)) {
          for (const el of n.name.elements) if (ts.isIdentifier(el.name)) importedNames.add(el.name.text);
        }
      }
    }
    ts.forEachChild(n, collectDynamicImportNames);
  };
  collectDynamicImportNames(sf);

  const isProductionRoot = (name: string): boolean => importedNames.has(name);

  interface SetupBlock {
    body: ts.Node;
    kind: 'beforeEach' | 'beforeAll';
    container?: ts.CallExpression;
  }

  /** Setup callbacks contribute mock configurations to each applicable test scope. */
  function buildScope(body: ts.Block, setupBlocks: SetupBlock[] = []): Scope {
    const scope: Scope = { bindings: new Map(), mockInstanceIds: new Map(instanceIds), configs: new Map() };
    // Bindings come from the test body AND its setup hooks. A SUT instance created in a
    // `beforeEach` (`engine = new PythonEngine()`) must count as production when the test
    // calls `engine.run(...)` — otherwise TAUT-004 falsely reports a mock-only test.
    const collectBindings = (node: ts.Node) => {
      if (ts.isVariableStatement(node)) {
        const mutable = (node.declarationList.flags & ts.NodeFlags.Const) === 0;
        for (const d of node.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || !d.initializer) continue;
          scope.bindings.set(d.name.text, { expr: stripAwait(d.initializer), mutable });
        }
        return;
      }
      if (
        ts.isExpressionStatement(node) &&
        ts.isBinaryExpression(node.expression) &&
        node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const left = node.expression.left;
        if (ts.isIdentifier(left)) scope.bindings.set(left.text, { expr: node.expression.right, mutable: true });
        return;
      }
      ts.forEachChild(node, collectBindings);
    };
    // Setup runs before the test body, so a test-local binding wins over a setup binding.
    for (const setup of setupBlocks) collectBindings(setup.body);
    for (const st of body.statements) collectBindings(st);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const name = callName(n.expression);
        const m = name?.match(
          /^(.*)\.mock(ReturnValue|ResolvedValue|ReturnValueOnce|ResolvedValueOnce|RejectedValue|RejectedValueOnce|Implementation|ImplementationOnce)$/,
        );
        if (m) {
          const keyExpr = (n.expression as ts.PropertyAccessExpression).expression;
          const key = keyExpr.getText(sf);
          const val = n.arguments[0];
          const valText = val ? configuredValueText(val, sf, m[2] ?? '') : '';
          const owner = ownerOf(keyExpr, sf);
          const mockId = owner ? scope.mockInstanceIds.get(owner) : undefined;
          scope.configs.set(key, { valueText: valText, mockId: mockId ?? '' });
        }
      }
      ts.forEachChild(n, visit);
    };
    // Setup runs before the test body, so a test-local configuration wins.
    for (const setup of setupBlocks) visit(setup.body);
    visit(body);
    return scope;
  }

  // beforeEach/beforeAll callbacks contribute only to tests in their enclosing
  // describe scope. A module-level hook applies to every test in the module.
  const setupBlocks: SetupBlock[] = [];
  const enclosingDescribe = (n: ts.Node): ts.CallExpression | undefined => {
    let p: ts.Node | undefined = n.parent;
    while (p) {
      if (ts.isCallExpression(p) && callName(p.expression) === 'describe') return p;
      p = p.parent;
    }
    return undefined;
  };
  const describeAncestors = (n: ts.Node): Set<ts.CallExpression> => {
    const out = new Set<ts.CallExpression>();
    let p: ts.Node | undefined = n.parent;
    while (p) {
      if (ts.isCallExpression(p) && callName(p.expression) === 'describe') out.add(p);
      p = p.parent;
    }
    return out;
  };
  const describeDepth = (n: ts.Node): number => {
    let depth = 0;
    let p: ts.Node | undefined = n.parent;
    while (p) {
      if (ts.isCallExpression(p) && callName(p.expression) === 'describe') depth++;
      p = p.parent;
    }
    return depth;
  };
  const collectSetupBlocks = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const name = callName(n.expression);
      const callback = n.arguments[0];
      if (
        (name === 'beforeEach' || name === 'beforeAll') &&
        callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
      ) {
        setupBlocks.push({
          body: callback.body,
          kind: name,
          container: enclosingDescribe(n),
        });
      }
    }
    ts.forEachChild(n, collectSetupBlocks);
  };
  collectSetupBlocks(sf);

  const setupsForTest = (testCall: ts.CallExpression): SetupBlock[] => {
    const ancestors = describeAncestors(testCall);
    return (
      setupBlocks
        .filter((setup) => !setup.container || ancestors.has(setup.container))
        .slice()
        // Jest/Vitest run all beforeAll hooks before beforeEach hooks; within a
        // hook kind, outer describe scopes run before inner scopes.
        .sort((a, b) => {
          const phase = (x: SetupBlock) => (x.kind === 'beforeAll' ? 0 : 1);
          return (
            phase(a) - phase(b) ||
            describeDepth(a.container ?? sf) - describeDepth(b.container ?? sf) ||
            pos(a.body).line - pos(b.body).line
          );
        })
    );
  };

  /** Guards against a local helper that (directly or mutually) calls itself. */
  const seenLocalFns = new Set<string>();

  function provenance(
    expr: ts.Expression,
    scope: Scope,
  ): { kind: SourceKind; mockRefs: string[]; configuredValue?: string; constant: boolean } {
    if (ts.isAwaitExpression(expr)) return provenance(expr.expression, scope);
    if (
      ts.isNumericLiteral(expr) ||
      ts.isStringLiteral(expr) ||
      expr.kind === ts.SyntaxKind.TrueKeyword ||
      expr.kind === ts.SyntaxKind.FalseKeyword ||
      expr.kind === ts.SyntaxKind.NullKeyword
    ) {
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
        return {
          kind: 'mock-config',
          mockRefs: cfg.mockId ? [cfg.mockId] : [],
          configuredValue: cfg.valueText,
          constant: false,
        };
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
      // A local helper that wraps the SUT (`const run = (over) => resolveTargets({...})`) is what
      // the assertion's value actually came from, so provenance has to look through it the same way
      // `productionCalls` already does — otherwise every assertion on the helper's result reads as
      // `unknown` and the test looks mock-only (Chaos-MCP dogfood, docs/11).
      //
      // Only the source *kind* carries through, never `constant`/`literal`: a helper whose single
      // return is `null` (`const firstError = (a) => { …; return null; }`) hands back a literal
      // from ONE path, and inheriting its constant-ness made every `expect(firstError(x)).toContain(
      // 'msg')` read as a constant tautology. Constant-ness is a property of the expression at the
      // assertion site, not of a value some branch of a helper can return.
      if (root && !seenLocalFns.has(root)) {
        const returned = returnExpression(localFns.get(root));
        if (returned) {
          seenLocalFns.add(root);
          try {
            const inner = provenance(returned, scope);
            if (inner.kind !== 'literal' && inner.kind !== 'unknown') {
              return { kind: inner.kind, mockRefs: inner.mockRefs, constant: false };
            }
          } finally {
            seenLocalFns.delete(root);
          }
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

  // Local helper functions can wrap the SUT (e.g. a `run(flags)` helper that calls
  // `runCli(...)`). Tracing through them lets `productionCalls` see that the test exercises
  // production instead of misreporting it as mock-only (TAUT-004).
  const localFns = new Map<string, ts.Node>();
  const collectLocalFns = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) {
      localFns.set(n.name.text, n.body);
    } else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = stripCast(n.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) localFns.set(n.name.text, init.body);
    }
    ts.forEachChild(n, collectLocalFns);
  };
  collectLocalFns(sf);

  function productionCalls(body: ts.Block, scope: Scope): number {
    let count = 0;
    const seen = new Set<ts.Node>();
    const visit = (n: ts.Node) => {
      if (seen.has(n)) return;
      seen.add(n);
      if (ts.isCallExpression(n)) {
        // Dynamic `import('./mod')` (and `vi.resetModules()` + re-import) executes real module
        // code, so it counts as exercising production — otherwise a test that registers and
        // invokes a production signal handler via a re-import reads as mock-only (TAUT-004).
        if (n.expression.kind === ts.SyntaxKind.ImportKeyword) {
          count++;
          return;
        }
        const root = rootOf(n.expression);
        if (!root || HELPER_ROOTS.has(root)) {
          ts.forEachChild(n, visit);
          return;
        }
        if (scope.mockInstanceIds.has(root)) {
          ts.forEachChild(n, visit);
          return;
        }
        const bound = scope.bindings.get(root);
        if (bound && ts.isNewExpression(stripCast(bound.expr))) {
          count++;
        } else if (isProductionRoot(root)) {
          count++;
        } else {
          const local = localFns.get(root);
          if (local) visit(local);
        }
      } else if (ts.isNewExpression(n)) {
        const root = rootOf(n.expression);
        if (root && isProductionRoot(root)) {
          count++;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
    return count;
  }

  // ---- collect test functions (it/test callbacks + describe for stats)
  const testFns: TestFnIR[] = [];
  const setupBlocksByFnId = new Map<string, SetupBlock[]>();
  /** Name of a test-defining call: `it`/`test`, or their parameterized `it.each`/`test.each` forms. */
  const testCallName = (n: ts.CallExpression): string | undefined => {
    const direct = callName(n.expression);
    if (direct === 'it' || direct === 'test') return direct;
    if (ts.isCallExpression(n.expression)) {
      const each = callName(n.expression.expression);
      if (each === 'it.each' || each === 'test.each') return each;
    }
    return undefined;
  };
  const collectFns = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const name = testCallName(n);
      if (name && n.arguments[1] && (ts.isArrowFunction(n.arguments[1]) || ts.isFunctionExpression(n.arguments[1]))) {
        const fn = n.arguments[1];
        const body = (fn as ts.ArrowFunction).body;
        if (ts.isBlock(body)) {
          const id = `${file}#fn:${pos(n).line + 1}`;
          const applicableSetups = setupsForTest(n);
          const scope = buildScope(body, applicableSetups);
          setupBlocksByFnId.set(id, applicableSetups);
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
          const matcher = ts.isPropertyAccessExpression(matcherCall.expression)
            ? matcherCall.expression.name.text
            : undefined;
          if (matcher) {
            let expectCall: ts.Node = matcherCall.expression;
            while (ts.isPropertyAccessExpression(expectCall)) expectCall = expectCall.expression;
            const left = ts.isCallExpression(expectCall) ? expectCall.arguments[0] : undefined;
            const right = matcherCall.arguments[0];
            const fnBody = enclosingBlock(node);
            const fnId =
              testFns.find((f) => f.span.startLine <= pos(node).line + 1 && pos(node).line + 1 <= f.span.endLine)?.id ??
              '';
            const setupForFn = setupBlocksByFnId.get(fnId) ?? [];
            const scope = fnBody
              ? buildScope(fnBody, setupForFn)
              : { bindings: new Map(), mockInstanceIds: new Map(instanceIds), configs: new Map() };
            const operands: ExprIR[] = [];
            if (left) operands.push(toExpr(left, scope));
            if (right) operands.push(toExpr(right, scope));
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
      kind: ts.isLiteralExpression(e)
        ? 'literal'
        : ts.isCallExpression(e)
          ? 'call'
          : ts.isPropertyAccessExpression(e)
            ? 'member'
            : ts.isIdentifier(e)
              ? 'identifier'
              : ts.isNewExpression(e)
                ? 'new'
                : 'unknown',
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

/**
 * The single expression a collected local helper hands back: a concise arrow IS its return
 * expression; a block body qualifies only when exactly one `return` in it carries a value.
 * A helper with several value-returning paths has no single provenance — returning one of them
 * would attribute the assertion to whichever branch happened to be written last.
 */
function returnExpression(body: ts.Node | undefined): ts.Expression | undefined {
  if (!body) return undefined;
  if (!ts.isBlock(body)) return body as ts.Expression;
  const returns: ts.Expression[] = [];
  const walk = (n: ts.Node): void => {
    // A nested function's `return` belongs to that function, not to this helper.
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return;
    if (ts.isReturnStatement(n) && n.expression) returns.push(n.expression);
    ts.forEachChild(n, walk);
  };
  walk(body);
  return returns.length === 1 ? returns[0] : undefined;
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

function configuredValueText(value: ts.Expression, sf: ts.SourceFile, api: string): string {
  if (api !== 'Implementation' && api !== 'ImplementationOnce') return value.getText(sf);
  const callback = ts.isParenthesizedExpression(value) ? value.expression : value;
  if (ts.isArrowFunction(callback) && !ts.isBlock(callback.body)) return callback.body.getText(sf);
  if (ts.isFunctionExpression(callback) || ts.isArrowFunction(callback)) {
    let result: string | undefined;
    const visit = (n: ts.Node) => {
      if (result) return;
      if (
        ts.isReturnStatement(n) &&
        n.expression &&
        (ts.isLiteralExpression(n.expression) ||
          n.expression.kind === ts.SyntaxKind.TrueKeyword ||
          n.expression.kind === ts.SyntaxKind.FalseKeyword ||
          n.expression.kind === ts.SyntaxKind.NullKeyword)
      ) {
        result = n.expression.getText(sf);
        return;
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(callback.body, visit);
    if (result) return result;
  }
  return value.getText(sf);
}

function ownerOf(e: ts.Expression, sf: ts.SourceFile): string | undefined {
  const text = e.getText(sf);
  return text.match(/^([A-Za-z_$][\w$]*)/)?.[1];
}
