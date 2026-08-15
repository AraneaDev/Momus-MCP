/**
 * Mock identification (spec docs/02 §2.5.1) + type-aware enrichment:
 *  - vi.mock / jest.mock factory keys + automock
 *  - vi.spyOn / jest.spyOn member targets (resolved via checker)
 *  - vi.fn / jest.fn with mock* chains
 *  - vi.mocked(new X()) instance mocks with configured members
 *  - object-literal doubles (`{ m: vi.fn() } as unknown as T`)
 */
import * as ts from 'typescript';
import type {
  ConfiguredValueIR, MockFramework, MockIR, MockTarget, SourceSpan, StubbedMemberIR, TypeIR,
} from '@momus/core';
import { span } from '@momus/core';
import { getProgram, symbolIdOfType, classMethodSignature, unwrapPromise } from './program.ts';
import { typeNodeToIR } from './types.ts';

export interface MockDetectionContext {
  framework: MockFramework;
  typeAware: boolean;
  resolveImport(specifier: string): string | null;
}

const callName = (n: ts.Expression): string | null => {
  if (ts.isIdentifier(n)) return n.text;
  if (ts.isPropertyAccessExpression(n)) return callName(n.expression) ? callName(n.expression) + '.' + n.name.text : null;
  return null;
};

const rootOfCall = (e: ts.Expression): string | undefined => {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return rootOfCall(e.expression);
  if (ts.isCallExpression(e)) return rootOfCall(e.expression);
  return undefined;
};

const unwrap = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e);

export interface MockDetectionResult {
  mocks: MockIR[];
  /** identifier name -> mock id, for dataflow (instance mocks and spy results). */
  instanceIds: Map<string, string>;
}

export function detectMocks(sf: ts.SourceFile, ctx: MockDetectionContext): MockDetectionResult {
  const file = sf.fileName;
  const handle = getProgram(file);
  const checker = handle.program.getTypeChecker();
  const mocks: MockIR[] = [];
  const instanceIds = new Map<string, string>();
  const pos = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart());
  const endPos = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getEnd());
  const mkSpan = (n: ts.Node): SourceSpan => span(file, pos(n).line + 1, pos(n).character + 1, endPos(n).line + 1, endPos(n).character + 1);
  const mockId = (n: ts.Node) => `${file}#mock:${pos(n).line + 1}:${pos(n).character + 1}`;

  const configApi = (name: string): ConfiguredValueIR['api'] | null => {
    if (/\.mockReturnValueOnce$/.test(name)) return 'mockReturnValueOnce';
    if (/\.mockResolvedValue(Once)?$/.test(name)) return 'mockResolvedValue';
    if (/\.mockRejectedValue(Once)?$/.test(name)) return 'mockRejectedValue';
    if (/\.mockReturnValue$/.test(name)) return 'mockReturnValue';
    if (/\.mockImplementation(Once)?$/.test(name)) return 'mockImplementation';
    return null;
  };

  const visit = (node: ts.Node) => {
    if (!ts.isCallExpression(node)) { ts.forEachChild(node, visit); return; }
    const name = callName(node.expression);
    const line = pos(node).line + 1;

    // ---- vi.mock('mod', factory)
    if (name === 'vi.mock' || name === 'jest.mock') {
      const specifier = node.arguments[0] && ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : undefined;
      const resolvedPath = specifier ? ctx.resolveImport(specifier) : undefined;
      const factory = node.arguments[1] ? unwrap(node.arguments[1]) : undefined;
      const members: StubbedMemberIR[] = [];
      const factoryBody = factory && ts.isArrowFunction(factory) && factory.body && !ts.isBlock(factory.body)
        ? (unwrap(factory.body) as ts.ObjectLiteralExpression)
        : undefined;
      if (factoryBody) {
        for (const p of factoryBody.properties) {
          if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
            members.push({
              name: p.name.text,
              span: mkSpan(p),
              api: 'mockFactoryKey',
              returnValues: [],
            });
          }
        }
      }
      const target: MockTarget = resolvedPath
        ? { kind: 'module', modulePath: resolvedPath, specifier, span: mkSpan(node.arguments[0] ?? node) }
        : { kind: 'unknown', specifier, span: mkSpan(node.arguments[0] ?? node) };
      mocks.push({
        id: mockId(node),
        span: mkSpan(node),
        framework: ctx.framework,
        pattern: name,
        target,
        stubbedMembers: members,
        configuredValues: [],
        invocationSites: [],
        isAutomock: !factory,
      });
    }

    // ---- vi.fn() with direct mock* chains
    if (name === 'vi.fn' || name === 'jest.fn') {
      const id = mockId(node);
      const chain: ConfiguredValueIR[] = [];
      let parent: ts.Node | undefined = node.parent;
      while (parent && ts.isPropertyAccessExpression(parent)) {
        const api = configApi(parent.getText(sf));
        if (api) {
          const call = parent.parent;
          if (call && ts.isCallExpression(call)) {
            const value = call.arguments[0];
            chain.push({
              span: mkSpan(call),
              api,
              value: value ? literalShape(value, sf) : undefined,
              once: /Once$/.test(api),
              assignable: 'unknown',
            });
          }
        }
        parent = parent.parent;
      }
      mocks.push({
        id,
        span: mkSpan(node),
        framework: ctx.framework,
        pattern: name,
        configuredValues: chain,
        stubbedMembers: [],
        invocationSites: [],
        isAutomock: false,
      });
    }

    // ---- vi.spyOn(obj, 'member') — resolve target class via checker
    if (name === 'vi.spyOn' || name === 'jest.spyOn') {
      const [objExpr, memberExpr] = node.arguments;
      if (objExpr && memberExpr && ts.isStringLiteral(memberExpr)) {
        const type = ctx.typeAware ? checker.getTypeAtLocation(objExpr) : undefined;
        const symbolId = type ? symbolIdOfType(checker, type) : undefined;
        const target: MockTarget = symbolId
          ? { kind: 'instance-member', symbolId, memberName: memberExpr.text, span: mkSpan(node) }
          : { kind: 'instance-member', memberName: memberExpr.text, span: mkSpan(node) };
        const id = mockId(node);
        mocks.push({
          id,
          span: mkSpan(node),
          framework: ctx.framework,
          pattern: name,
          target,
          stubbedMembers: [{
            name: memberExpr.text,
            span: mkSpan(memberExpr),
            api: 'spyOn',
            returnValues: collectMemberConfigs(node, sf, mkSpan),
          }],
          configuredValues: [],
          invocationSites: [],
          isAutomock: false,
        });
        // spy result bound to an identifier
        const binding = findBinding(node, sf);
        if (binding) instanceIds.set(binding, id);
      }
    }

    // ---- vi.mocked(new X()) — typed instance mock
    if (name === 'vi.mocked' || name === 'jest.mocked') {
      const inner = unwrap(node.arguments[0] ?? node);
      if (ts.isNewExpression(inner) || ts.isIdentifier(inner)) {
        const type = ctx.typeAware ? checker.getTypeAtLocation(inner) : undefined;
        const symbolId = type ? symbolIdOfType(checker, type) : undefined;
        const id = mockId(node);
        if (symbolId) {
          mocks.push({
            id,
            span: mkSpan(node),
            framework: ctx.framework,
            pattern: 'vi.mocked-instance',
            target: { kind: 'class', symbolId, span: mkSpan(node) },
            stubbedMembers: [],
            configuredValues: [],
            invocationSites: [],
            isAutomock: false,
          });
          explicitMockIds.add(id);
          const binding = findBinding(node, sf);
          if (binding) instanceIds.set(binding, id);
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  const explicitMockIds = new Set<string>();

  // object-literal + new-expression + cast bindings at statement level
  const visitStmt = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = stripCast(node.initializer);
      if (ts.isObjectLiteralExpression(init)) {
        const members: StubbedMemberIR[] = [];
        for (const p of init.properties) {
          if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && ts.isCallExpression(p.initializer) && callName(p.initializer.expression) === 'vi.fn') {
            members.push({ name: p.name.text, span: mkSpan(p), api: 'objectLiteralKey', returnValues: [] });
          }
        }
        if (members.length > 0) {
          const castType = castTypeName(node.initializer);
          const id = mockId(node);
          let symbolId: string | undefined;
          if (castType && ctx.typeAware) {
            const type = checker.getTypeAtLocation(node.initializer);
            symbolId = symbolIdOfType(checker, type);
          }
          mocks.push({
            id,
            span: mkSpan(node),
            framework: ctx.framework,
            pattern: 'object-literal',
            target: symbolId ? { kind: 'class', symbolId, span: mkSpan(node) } : undefined,
            stubbedMembers: members,
            configuredValues: [],
            invocationSites: [],
            isAutomock: false,
          });
          instanceIds.set(node.name.text, id);
        }
      } else if (ts.isCallExpression(init) && callName(init.expression) === 'vi.fn') {
        // direct const f = vi.fn() — a mock instance without members
        const id = mockId(node);
        mocks.push({
          id,
          span: mkSpan(node),
          framework: ctx.framework,
          pattern: 'vi.fn',
          stubbedMembers: [],
          configuredValues: [],
          invocationSites: [],
          isAutomock: false,
        });
        instanceIds.set(node.name.text, id);
      } else if (ts.isNewExpression(init) && ctx.typeAware && isProductionClass(init, checker, sf)) {
        // const svc = new LedgerService(...) — production instance; mock members via later configs
        const type = checker.getTypeAtLocation(init);
        const symbolId = symbolIdOfType(checker, type);
        if (symbolId) {
          const id = mockId(node);
          mocks.push({
            id,
            span: mkSpan(node),
            framework: ctx.framework,
            pattern: 'vi.mocked-instance',
            target: { kind: 'class', symbolId, span: mkSpan(node) },
            stubbedMembers: [],
            configuredValues: [],
            invocationSites: [],
            isAutomock: false,
          });
          instanceIds.set(node.name.text, id);
        }
      }
    }
    ts.forEachChild(node, visitStmt);
  };

  visit(sf);
  visitStmt(sf);

  // ---- member configs on instance mocks: dbMock.query.mockResolvedValue([...])
  // Only configs whose owner identifier binds to THIS mock are collected.
  for (const mock of mocks) {
    if (mock.pattern !== 'vi.mocked-instance' || !mock.target?.symbolId) continue;
    if (!explicitMockIds.has(mock.id)) {
      // plain `new X()` SUT instances only become mocks when members are configured
      mock.stubbedMembers = [];
    }
    const binding = [...instanceIds.entries()].find(([, v]) => v === mock.id)?.[0];
    if (!binding) continue;
    const members = new Map<string, StubbedMemberIR>();
    const collect = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const api = configApi(callName(n.expression) ?? '');
        if (api) {
          const callee = n.expression as ts.PropertyAccessExpression;
          const base = callee.expression;
          const memberName = ts.isPropertyAccessExpression(base) ? base.name.text : undefined;
          const owner = findInstanceOwner(base.getText(sf), sf);
          if (owner === binding && instanceIds.has(owner) && memberName) {
            const stub = members.get(memberName) ?? {
              name: memberName, span: mkSpan(base), api: 'instance-member' as const, returnValues: [],
            };
            const valueNode = n.arguments[0];
            stub.returnValues.push({
              span: mkSpan(n),
              api,
              value: valueNode ? literalShape(valueNode, sf) : undefined,
              once: /Once$/.test(api),
              assignable: 'unknown',
            });
            members.set(memberName, stub);
          }
        }
      }
      ts.forEachChild(n, collect);
    };
    collect(sf);
    // assignability via checker
    for (const stub of members.values()) {
      const sig = ctx.typeAware ? classMethodSignature(handle, mock.target.symbolId, stub.name) : undefined;
      for (const v of stub.returnValues) {
        if (v.value === undefined) continue;
        if (!sig) { v.assignable = 'unknown'; continue; }
        const retType = unwrapPromise(sig.checker, sig.returnType);
        // generic type parameters (e.g. query<T>(): Promise<T[]>) are not statically checkable
        if (containsTypeParameter(sig.checker, retType)) { v.assignable = 'unknown'; continue; }
        const valNode = findNodeForSpan(sf, v.span);
        if (!valNode) { v.assignable = 'unknown'; continue; }
        const valType = sig.checker.getTypeAtLocation(valNode);
        try {
          v.assignable = sig.checker.isTypeAssignableTo(valType, retType);
        } catch {
          v.assignable = 'unknown';
        }
      }
    }
    mock.stubbedMembers = [...members.values()];
    mock.configuredValues = [...members.values()].flatMap((s) => s.returnValues);
  }
  // drop SUT instances that ended up with no configured members (and unregister them
  // so dataflow treats them as production, not mocks)
  for (let i = mocks.length - 1; i >= 0; i--) {
    const m = mocks[i]!;
    if (m.pattern === 'vi.mocked-instance' && !explicitMockIds.has(m.id) && m.stubbedMembers.length === 0) {
      mocks.splice(i, 1);
      for (const [name, id] of [...instanceIds]) if (id === m.id) instanceIds.delete(name);
    }
  }

  // ---- invocation sites: calls on mock instances / spies, plus instances handed to
  // production code (new LedgerService(dbMock) — reachable even if never called in-file)
  // Exclusions: test-framework wrappers (expect(spy), vi.mocked(x)) and config calls
  // (mocked.getTotal.mockReturnValue(42)) are NOT invocations.
  const CALLER_HELPER = /^(expect|vi|jest|it|test|describe|beforeEach|afterEach|beforeAll|afterAll|xit|xtest|fit|fdescribe|it\.|test\.|describe\.)/;
  const reachable = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const calleeText = n.expression.getText(sf);
      const isConfigCall = /^[\w$.]+\.mock(ReturnValue|ResolvedValue|ReturnValueOnce|ResolvedValueOnce|RejectedValue|RejectedValueOnce|Implementation|ImplementationOnce)$/.test(calleeText);
      const calleeRoot = rootOfCall(n.expression);
      const isHelperCall = calleeRoot !== undefined && CALLER_HELPER.test(calleeRoot);
      if (!isConfigCall && !isHelperCall) {
        for (const arg of n.arguments) {
          const a = stripCast(arg);
          if (ts.isIdentifier(a) && instanceIds.has(a.text)) {
            const mock = mocks.find((m) => m.id === instanceIds.get(a.text));
            if (mock && !mock.invocationSites.some((s) => s.startLine === pos(n).line + 1)) {
              mock.invocationSites.push(mkSpan(n));
            }
          }
        }
      }
      if (!isConfigCall) {
        const base = ts.isPropertyAccessExpression(n.expression) ? n.expression.expression : n.expression;
        const owner = findInstanceOwner(base.getText(sf), sf);
        if (owner && instanceIds.has(owner)) {
          const id = instanceIds.get(owner)!;
          const mock = mocks.find((m) => m.id === id);
          if (mock && !mock.invocationSites.some((s) => s.startLine === pos(n).line + 1)) {
            mock.invocationSites.push(mkSpan(n));
          }
        }
      }
    }
    if (ts.isNewExpression(n)) {
      for (const arg of n.arguments ?? []) {
        const a = stripCast(arg);
        if (ts.isIdentifier(a) && instanceIds.has(a.text)) {
          const mock = mocks.find((m) => m.id === instanceIds.get(a.text));
          if (mock && !mock.invocationSites.some((s) => s.startLine === pos(n).line + 1)) {
            mock.invocationSites.push(mkSpan(n));
          }
        }
      }
    }
    ts.forEachChild(n, reachable);
  };
  reachable(sf);

  return { mocks, instanceIds };
}

/** Configs chained on a spyOn result: vi.spyOn(x, 'm').mockReturnValue(42) */
function collectMemberConfigs(
  spyCall: ts.CallExpression,
  sf: ts.SourceFile,
  mkSpan: (n: ts.Node) => SourceSpan,
): ConfiguredValueIR[] {
  const out: ConfiguredValueIR[] = [];
  let parent: ts.Node | undefined = spyCall.parent;
  while (parent && ts.isPropertyAccessExpression(parent)) {
    const call = parent.parent;
    if (call && ts.isCallExpression(call) && /\.mock/.test(parent.name.text)) {
      const value = call.arguments[0];
      out.push({
        span: mkSpan(call),
        api: parent.name.text as ConfiguredValueIR['api'],
        value: value ? literalShape(value, sf) : undefined,
        once: /Once$/.test(parent.name.text),
        assignable: 'unknown',
      });
    }
    parent = parent.parent;
  }
  return out;
}

const stripCast = (e: ts.Expression): ts.Expression =>
  ts.isAsExpression(e) ? stripCast(e.expression) : ts.isParenthesizedExpression(e) ? stripCast(e.expression) : e;

function castTypeName(e: ts.Expression): string | undefined {
  if (ts.isAsExpression(e)) {
    if (ts.isTypeReferenceNode(e.type)) return e.type.typeName.getText();
  }
  return undefined;
}

/** Find the variable binding of a call expression (its nearest VariableDeclaration parent). */
function findBinding(node: ts.Node, sf: ts.SourceFile): string | undefined {
  let p = node.parent;
  while (p && !ts.isSourceFile(p)) {
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    p = p.parent;
  }
  return undefined;
}

function isProductionClass(init: ts.NewExpression, checker: ts.TypeChecker, sf: ts.SourceFile): boolean {
  const type = checker.getTypeAtLocation(init);
  const id = symbolIdOfType(checker, type);
  return id !== undefined;
}

/** Resolve 'dbMock.query' / 'mocked.getTotal' → owner identifier. */
/** True when the type (or its element/member types) mentions an unresolved type parameter.
 *  getTypeArguments covers TypeReference (Array<T>, Promise<T>) and ArrayType alike. */
function containsTypeParameter(checker: ts.TypeChecker, type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) return true;
  if (type.isUnion()) return type.types.some((t) => containsTypeParameter(checker, t));
  if (type.isIntersection()) return type.types.some((t) => containsTypeParameter(checker, t));
  const args = checker.getTypeArguments(type as ts.TypeReference);
  if (args.length > 0) return args.some((t) => containsTypeParameter(checker, t));
  return false;
}

function findInstanceOwner(baseText: string, sf: ts.SourceFile): string | undefined {
  const m = baseText.match(/^([A-Za-z_$][\w$]*)/);
  return m?.[1];
}

/** Best-effort static shape of a configured value (for reporting). */
function literalShape(n: ts.Expression, sf: ts.SourceFile): TypeIR | undefined {
  if (ts.isStringLiteral(n)) return { kind: 'literal', value: n.text };
  if (ts.isNumericLiteral(n)) return { kind: 'literal', value: Number(n.text) };
  if (n.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'literal', value: true };
  if (n.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'literal', value: false };
  if (ts.isArrayLiteralExpression(n)) return { kind: 'array', element: n.elements[0] ? literalShape(n.elements[0]!, sf) : undefined };
  if (ts.isObjectLiteralExpression(n)) return { kind: 'unknown' };
  if (ts.isNewExpression(n) && ts.isIdentifier(n.expression)) return { kind: 'named', name: n.expression.text, typeArgs: [] };
  return undefined;
}

function findNodeForSpan(sf: ts.SourceFile, s: SourceSpan): ts.Expression | undefined {
  const pos = sf.getPositionOfLineAndCharacter(s.startLine - 1, s.startCol - 1);
  const node = findDeepest(sf, pos);
  return node && ts.isExpression(node) ? node : undefined;
}

function findDeepest(n: ts.Node, pos: number): ts.Node | undefined {
  let best: ts.Node | undefined;
  const walk = (node: ts.Node) => {
    if (node.getStart() <= pos && pos < node.getEnd()) {
      best = node;
      ts.forEachChild(node, walk);
    }
  };
  walk(n);
  return best;
}
