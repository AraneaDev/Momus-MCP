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
  ConfiguredValueIR,
  MockFramework,
  MockIR,
  MockTarget,
  SignatureIR,
  SourceSpan,
  StubbedMemberIR,
  TypeIR,
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
  if (ts.isPropertyAccessExpression(n))
    return callName(n.expression) ? callName(n.expression) + '.' + n.name.text : null;
  return null;
};

const rootOfCall = (e: ts.Expression): string | undefined => {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return rootOfCall(e.expression);
  if (ts.isCallExpression(e)) return rootOfCall(e.expression);
  return undefined;
};

const unwrap = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e);

/**
 * Find the object literal returned from a block-bodied mock factory, e.g.
 * `async (importOriginal) => { const actual = await importOriginal(); return { ...actual, key: vi.fn() }; }`.
 * Scans top-level return statements; a `...actual` spread is preserved as a non-stub property.
 */
function findReturnedObjectLiteral(body: ts.Node): ts.ObjectLiteralExpression | undefined {
  let found: ts.ObjectLiteralExpression | undefined;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isReturnStatement(n) && n.expression) {
      const expr = unwrap(n.expression);
      if (ts.isObjectLiteralExpression(expr)) found = expr;
      return; // do not descend into other returns' subtrees; first return wins
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(body, visit);
  return found;
}

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
  // `instanceIds` (name -> most-recent mock id) is kept for the dataflow caller, but
  // resolution here must be position-aware: the same name (`mockRun`) is reused across
  // many test scopes, and a flat map would resolve every use to the last binding.
  const instanceIds = new Map<string, string>();
  const instanceBindingLines = new Map<string, Array<{ line: number; id: string }>>();
  const bindInstance = (name: string, id: string): void => {
    instanceIds.set(name, id);
    const entries = instanceBindingLines.get(name) ?? [];
    entries.push({ line: mockLineOfId(id), id });
    instanceBindingLines.set(name, entries);
  };
  const resolveInstance = (name: string, line: number): string | undefined => {
    const entries = instanceBindingLines.get(name);
    if (!entries) return undefined;
    let best: string | undefined;
    let bestLine = -1;
    for (const entry of entries) {
      if (entry.line <= line && entry.line > bestLine) {
        best = entry.id;
        bestLine = entry.line;
      }
    }
    return best;
  };
  // Spied-on object source text → spy mock ids. When the spied object itself is handed to
  // the SUT (`createTestSession(..., controller.signal)`), the spy member may be invoked inside
  // the SUT, so TAUT-006 must not treat it as having no production call path.
  const spiedObjects = new Map<string, string[]>();
  const pos = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart());
  const endPos = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getEnd());
  const mkSpan = (n: ts.Node): SourceSpan =>
    span(file, pos(n).line + 1, pos(n).character + 1, endPos(n).line + 1, endPos(n).character + 1);
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
    if (!ts.isCallExpression(node)) {
      ts.forEachChild(node, visit);
      return;
    }
    const name = callName(node.expression);

    // ---- vi.mock('mod', factory)
    if (name === 'vi.mock' || name === 'jest.mock') {
      const specifier = node.arguments[0] && ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : undefined;
      const resolvedPath = specifier ? ctx.resolveImport(specifier) : undefined;
      const factory = node.arguments[1] ? unwrap(node.arguments[1]) : undefined;
      const members: StubbedMemberIR[] = [];
      // Factory shapes: `() => ({ key: vi.fn() })` (expression body) and the partial-mock
      // form `async (importOriginal) => { const actual = await importOriginal();
      // return { ...actual, key: vi.fn() }; }` (block body returning an object literal).
      // In both, the object literal's explicit keys are the mock's stubbed exports; a
      // `...actual` spread just re-exports the real module and is not a stub.
      let factoryBody: ts.ObjectLiteralExpression | undefined =
        factory && ts.isArrowFunction(factory) && factory.body && !ts.isBlock(factory.body)
          ? (unwrap(factory.body) as ts.ObjectLiteralExpression)
          : undefined;
      if (
        !factoryBody &&
        factory &&
        (ts.isArrowFunction(factory) || ts.isFunctionExpression(factory)) &&
        factory.body
      ) {
        const returned = findReturnedObjectLiteral(factory.body);
        if (returned) factoryBody = returned;
      }
      if (factoryBody) {
        for (const p of factoryBody.properties) {
          if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
            members.push({
              name: p.name.text,
              span: mkSpan(p.name),
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

    // ---- module automocks loaded through helper APIs
    if (name === 'vi.importMock' || name === 'jest.requireMock' || name === 'jest.createMockFromModule') {
      const specifier = node.arguments[0] && ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : undefined;
      const resolvedPath = specifier ? ctx.resolveImport(specifier) : undefined;
      const id = mockId(node);
      mocks.push({
        id,
        span: mkSpan(node),
        framework: ctx.framework,
        pattern: name,
        target: resolvedPath
          ? { kind: 'module', modulePath: resolvedPath, specifier, span: mkSpan(node.arguments[0] ?? node) }
          : { kind: 'unknown', specifier, span: mkSpan(node.arguments[0] ?? node) },
        stubbedMembers: [],
        configuredValues: [],
        invocationSites: [],
        isAutomock: true,
      });
      const binding = findBinding(node, sf);
      if (binding) bindInstance(binding, id);
    }

    // ---- vi.stubGlobal('name', value)
    if (name === 'vi.stubGlobal' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      const value = node.arguments[1];
      mocks.push({
        id: mockId(node),
        span: mkSpan(node),
        framework: ctx.framework,
        pattern: 'vi.stubGlobal',
        target: { kind: 'global', exportName: node.arguments[0].text, span: mkSpan(node.arguments[0]) },
        stubbedMembers: [],
        configuredValues: value
          ? [
              {
                span: mkSpan(node),
                api: 'literal',
                value: literalShape(value, sf),
                once: false,
                assignable: 'unknown',
              },
            ]
          : [],
        invocationSites: [],
        isAutomock: false,
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
        const syntacticName = targetTypeName(objExpr, sf);
        const target: MockTarget = symbolId
          ? { kind: 'instance-member', symbolId, memberName: memberExpr.text, span: mkSpan(node) }
          : { kind: 'instance-member', exportName: syntacticName, memberName: memberExpr.text, span: mkSpan(node) };
        const id = mockId(node);
        const returnValues = collectMemberConfigs(node, sf, mkSpan);
        const signature = collectImplementationSignature(node);
        mocks.push({
          id,
          span: mkSpan(node),
          framework: ctx.framework,
          pattern: name,
          target,
          stubbedMembers: [
            {
              name: memberExpr.text,
              span: mkSpan(memberExpr),
              api: 'spyOn',
              signature,
              returnValues,
            },
          ],
          configuredValues: [],
          invocationSites: [],
          isAutomock: false,
        });
        // spy result bound to an identifier
        const binding = findBinding(node, sf);
        if (binding) bindInstance(binding, id);
        // remember the spied-on object so a hand-off of that object marks the spy reachable
        const spiedText = objExpr.getText(sf);
        spiedObjects.set(spiedText, [...(spiedObjects.get(spiedText) ?? []), id]);
      }
    }

    // ---- vi.mocked(new X()) — typed instance mock
    if (name === 'vi.mocked' || name === 'jest.mocked') {
      const inner = unwrap(node.arguments[0] ?? node);
      if (ts.isNewExpression(inner) || ts.isIdentifier(inner)) {
        const type = ctx.typeAware ? checker.getTypeAtLocation(inner) : undefined;
        const symbolId = type ? symbolIdOfType(checker, type) : undefined;
        const syntacticName = targetTypeName(inner, sf);
        const id = mockId(node);
        if (symbolId || syntacticName) {
          mocks.push({
            id,
            span: mkSpan(node),
            framework: ctx.framework,
            pattern: 'vi.mocked-instance',
            target: { kind: 'class', symbolId, exportName: syntacticName, span: mkSpan(node) },
            stubbedMembers: [],
            configuredValues: [],
            invocationSites: [],
            isAutomock: false,
          });
          explicitMockIds.add(id);
          const binding = findBinding(node, sf);
          if (binding) bindInstance(binding, id);
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
      if (
        ts.isNewExpression(init) &&
        ts.isIdentifier(init.expression) &&
        init.expression.text === 'Proxy' &&
        isProxyDouble(init)
      ) {
        const castType = castTypeName(node.initializer);
        let symbolId: string | undefined;
        if (castType && ctx.typeAware) {
          symbolId = symbolIdOfType(checker, checker.getTypeAtLocation(node.initializer));
        }
        const id = mockId(node);
        mocks.push({
          id,
          span: mkSpan(node),
          framework: ctx.framework,
          pattern: 'proxy',
          target: symbolId
            ? { kind: 'class', symbolId, exportName: castType, span: mkSpan(node) }
            : { kind: 'class', exportName: castType, span: mkSpan(node) },
          stubbedMembers: [],
          configuredValues: [],
          invocationSites: [],
          isAutomock: false,
        });

        bindInstance(node.name.text, id);
      } else if (ts.isObjectLiteralExpression(init)) {
        const members: StubbedMemberIR[] = [];
        for (const p of init.properties) {
          if (
            ts.isPropertyAssignment(p) &&
            ts.isIdentifier(p.name) &&
            ts.isCallExpression(p.initializer) &&
            (callName(p.initializer.expression) === 'vi.fn' || callName(p.initializer.expression) === 'jest.fn')
          ) {
            members.push({
              name: p.name.text,
              span: mkSpan(p.name),
              api: 'objectLiteralKey',
              signature: functionSignature(p.initializer.arguments[0]),
              returnValues: [],
            });
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
            target: symbolId
              ? { kind: 'class', symbolId, exportName: castType, span: mkSpan(node) }
              : { kind: 'class', exportName: castType, span: mkSpan(node) },
            stubbedMembers: members,
            configuredValues: [],
            invocationSites: [],
            isAutomock: false,
          });
          bindInstance(node.name.text, id);
        }
      } else if (ts.isCallExpression(init) && findMockFactoryCall(init)) {
        // direct const f = vi.fn() / vi.fn().mockReturnValue(...) — bind the
        // visitor's mock to the name so later hand-offs and configs resolve it.
        const factory = findMockFactoryCall(init)!;
        const id = mockId(factory);
        if (!mocks.some((m) => m.id === id)) {
          mocks.push({
            id,
            span: mkSpan(factory),
            framework: ctx.framework,
            pattern: (callName(factory.expression) ?? 'vi.fn') as 'vi.fn' | 'jest.fn',
            stubbedMembers: [],
            configuredValues: [],
            invocationSites: [],
            isAutomock: false,
          });
        }
        bindInstance(node.name.text, id);
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
          bindInstance(node.name.text, id);
        }
      }
    }
    ts.forEachChild(node, visitStmt);
  };

  visit(sf);
  visitStmt(sf);

  // ---- configs applied after assignment: fn.mockImplementation(...),
  // mocked.member.mockReturnValue(...), and their Jest equivalents.
  const collectAssignedConfigs = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const api = configApi(callName(n.expression) ?? '');
      if (api && ts.isPropertyAccessExpression(n.expression)) {
        const base = n.expression.expression;
        const owner = rootOfCall(base);
        // position-aware: the flat `instanceIds` map resolves every use of a name to its last
        // binding; the same `spy`/`mock` name is reused across test scopes, so resolve against
        // the nearest binding at or before this config site.
        const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
        const id = owner ? resolveInstance(owner, line) : undefined;
        const mock = id ? mocks.find((m) => m.id === id) : undefined;
        if (mock && mock.pattern !== 'vi.mocked-instance' && owner) {
          const value = n.arguments[0];
          const configured: ConfiguredValueIR = {
            span: mkSpan(n),
            api,
            value: value ? literalShape(value, sf) : undefined,
            once: /Once$/.test(api),
            assignable: 'unknown',
          };
          if (ts.isIdentifier(base)) {
            mock.configuredValues.push(configured);
            // `const spy = vi.spyOn(x, 'm'); spy.mockReturnValue(v)` — the config targets the
            // single spied member, so attach it there too. Otherwise the type-aware pass below
            // rebuilds `configuredValues` from member returnValues only and this value is
            // dropped — DRIFT-003's assignability check would never see it.
            const isSpy = mock.pattern === 'vi.spyOn' || mock.pattern === 'jest.spyOn';
            const spyMember = isSpy ? mock.stubbedMembers[0] : undefined;
            if (
              spyMember &&
              !spyMember.returnValues.some(
                (v) => v.span.startLine === configured.span.startLine && v.span.startCol === configured.span.startCol,
              )
            ) {
              spyMember.returnValues.push(configured);
            }
          } else if (ts.isPropertyAccessExpression(base)) {
            const member = mock.stubbedMembers.find((s) => s.name === base.name.text);
            if (
              member &&
              !member.returnValues.some(
                (v) => v.span.startLine === configured.span.startLine && v.span.startCol === configured.span.startCol,
              )
            ) {
              member.returnValues.push(configured);
              mock.configuredValues.push(configured);
            }
          }
        }
      }
    }
    ts.forEachChild(n, collectAssignedConfigs);
  };
  collectAssignedConfigs(sf);

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
              name: memberName,
              span: mkSpan(base),
              api: 'instance-member' as const,
              returnValues: [],
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
    computeReturnAssignability(handle, sf, mock.target.symbolId, [...members.values()], ctx.typeAware);
    mock.stubbedMembers = [...members.values()];
    mock.configuredValues = [...members.values()].flatMap((s) => s.returnValues);
  }

  // ---- DRIFT-003 assignability for vi.spyOn/jest.spyOn mocks with chained configs.
  // Configs bound through a const (`const spy = vi.spyOn(x, 'm'); spy.mockReturnValue(v)`)
  // were previously attached at mock level only and dropped when the instance-mock pass above
  // rebuilt `configuredValues` from member return values — the assigned value never reached the
  // checker, so return-type mismatches on spies were invisible.
  for (const mock of mocks) {
    if (mock.pattern !== 'vi.spyOn' && mock.pattern !== 'jest.spyOn') continue;
    if (!mock.target?.symbolId) continue;
    computeReturnAssignability(handle, sf, mock.target.symbolId, mock.stubbedMembers, ctx.typeAware);
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
  const CALLER_HELPER =
    /^(expect|vi|jest|it|test|describe|beforeEach|afterEach|beforeAll|afterAll|xit|xtest|fit|fdescribe|it\.|test\.|describe\.)/;
  const reachable = (n: ts.Node) => {
    // Mark every mock this expression hands off to production code: a bound identifier, an
    // inline vi.fn()/jest.fn() factory, or a spied-on object (whose member the SUT may call).
    const markReachable = (expr: ts.Expression | undefined) => {
      if (!expr) return;
      const a = stripCast(expr);
      const ids: string[] = [];
      if (ts.isIdentifier(a)) {
        const id = resolveInstance(a.text, pos(a).line + 1);
        if (id) ids.push(id);
      }
      const factory = findMockFactoryCall(a);
      if (factory) ids.push(mockId(factory));
      const spies = spiedObjects.get(a.getText(sf));
      if (spies) ids.push(...spies);
      for (const id of ids) {
        const mock = mocks.find((m) => m.id === id);
        if (mock && !mock.invocationSites.some((s) => s.startLine === pos(n).line + 1)) {
          mock.invocationSites.push(mkSpan(n));
        }
      }
    };

    if (ts.isCallExpression(n)) {
      const calleeText = n.expression.getText(sf);
      const isConfigCall =
        /^[\w$.]+\.mock(ReturnValue|ResolvedValue|ReturnValueOnce|ResolvedValueOnce|RejectedValue|RejectedValueOnce|Implementation|ImplementationOnce)$/.test(
          calleeText,
        );
      const calleeRoot = rootOfCall(n.expression);
      const isHelperCall = calleeRoot !== undefined && CALLER_HELPER.test(calleeRoot);
      if (!isConfigCall && !isHelperCall) {
        for (const arg of n.arguments) markReachable(arg);
      }
      if (!isConfigCall) {
        const base = ts.isPropertyAccessExpression(n.expression) ? n.expression.expression : n.expression;
        const owner = findInstanceOwner(base.getText(sf), sf);
        const oid = owner ? resolveInstance(owner, pos(n).line + 1) : undefined;
        if (oid) {
          const mock = mocks.find((m) => m.id === oid);
          if (mock && !mock.invocationSites.some((s) => s.startLine === pos(n).line + 1)) {
            mock.invocationSites.push(mkSpan(n));
          }
        }
        // A member call on a spied-on object runs the spy: `svc.totalCents()` invokes the
        // spy configured via `vi.spyOn(svc, 'totalCents')`. The callee base is not an
        // argument, so mark the spy reached here (mirrors the spiedObjects hand-off logic).
        if (ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(base)) {
          const memberName = n.expression.name.text;
          const spies = spiedObjects.get(base.text);
          for (const id of spies ?? []) {
            const spy = mocks.find((m) => m.id === id);
            // only the spy on this exact member is invoked (`service.totalFor()` does not
            // reach a spy on `totalForX`)
            if (
              spy &&
              spy.target?.kind === 'instance-member' &&
              spy.target.memberName === memberName &&
              !spy.invocationSites.some((s) => s.startLine === pos(n).line + 1)
            ) {
              spy.invocationSites.push(mkSpan(n));
            }
          }
        }
      }
    }
    if (ts.isNewExpression(n)) {
      for (const arg of n.arguments ?? []) markReachable(arg);
    }
    // A mock embedded as an object-literal value / array element is handed off to the SUT
    // (`{ run: mockRun }`, `{ deadline }`, `{ run: vi.fn().mockResolvedValue(x) }`). Treat it
    // as reachable even though it is never directly invoked in-file — otherwise TAUT-005
    // flags these as zero-reach stubs.
    if (ts.isObjectLiteralExpression(n)) {
      for (const prop of n.properties) {
        if (ts.isPropertyAssignment(prop)) markReachable(prop.initializer);
        else if (ts.isShorthandPropertyAssignment(prop)) markReachable(prop.name);
      }
    } else if (ts.isArrayLiteralExpression(n)) {
      for (const el of n.elements) markReachable(el);
    }
    ts.forEachChild(n, reachable);
  };
  reachable(sf);

  return { mocks, instanceIds };
}

/** Find an implementation callback chained on a spyOn result. */
function collectImplementationSignature(spyCall: ts.CallExpression): SignatureIR | undefined {
  let parent: ts.Node | undefined = spyCall.parent;
  while (parent && ts.isPropertyAccessExpression(parent)) {
    const call = parent.parent;
    if (call && ts.isCallExpression(call) && /^mockImplementation(Once)?$/.test(parent.name.text)) {
      return functionSignature(call.arguments[0]);
    }
    parent = parent.parent;
  }
  return undefined;
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
function findBinding(node: ts.Node, _sf: ts.SourceFile): string | undefined {
  let p = node.parent;
  while (p && !ts.isSourceFile(p)) {
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    p = p.parent;
  }
  return undefined;
}

/** Extract the 1-based source line from a `mockId` (`file#mock:LINE:COL`). */
function mockLineOfId(id: string): number {
  const m = id.match(/#mock:(\d+):\d+$/);
  return m ? Number(m[1]) : 0;
}

/**
 * Walk a call/property-access chain down to the `vi.fn()` / `jest.fn()` factory call.
 * Handles both bare `vi.fn()` and chained forms like `vi.fn().mockReturnValue(1)`.
 */
function findMockFactoryCall(expr: ts.Expression): ts.CallExpression | undefined {
  let cur: ts.Expression = unwrap(stripCast(expr));
  for (;;) {
    if (ts.isCallExpression(cur)) {
      const name = callName(cur.expression);
      if (name === 'vi.fn' || name === 'jest.fn') return cur;
      cur = cur.expression;
    } else if (ts.isPropertyAccessExpression(cur)) {
      cur = cur.expression;
    } else {
      return undefined;
    }
  }
}

function isProductionClass(init: ts.NewExpression, checker: ts.TypeChecker, _sf: ts.SourceFile): boolean {
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

function targetTypeName(expr: ts.Expression, sf: ts.SourceFile): string | undefined {
  if (ts.isParenthesizedExpression(expr)) return targetTypeName(expr.expression, sf);
  if (ts.isAsExpression(expr)) {
    if (ts.isTypeReferenceNode(expr.type)) return expr.type.typeName.getText(sf);
    return targetTypeName(expr.expression, sf);
  }
  if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression)) return expr.expression.text;
  if (ts.isIdentifier(expr)) {
    let result: string | undefined;
    const visit = (n: ts.Node) => {
      if (
        result ||
        !ts.isVariableDeclaration(n) ||
        !ts.isIdentifier(n.name) ||
        n.name.text !== expr.text ||
        !n.initializer
      )
        return;
      result = targetTypeName(n.initializer, sf);
    };
    const walk = (n: ts.Node) => {
      if (result) return;
      visit(n);
      ts.forEachChild(n, walk);
    };
    walk(sf);
    return result;
  }
  return undefined;
}

function isProxyDouble(init: ts.NewExpression): boolean {
  const handler = init.arguments?.[1];
  if (!handler || !ts.isObjectLiteralExpression(handler)) return false;
  const get = handler.properties.find(
    (p) =>
      (ts.isMethodDeclaration(p) || ts.isPropertyAssignment(p)) && ts.isIdentifier(p.name) && p.name.text === 'get',
  );
  if (!get) return false;
  let hasMockFactory = false;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && (callName(n.expression) === 'vi.fn' || callName(n.expression) === 'jest.fn')) {
      hasMockFactory = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(get);
  return hasMockFactory;
}

function functionSignature(expr: ts.Expression | undefined): SignatureIR | undefined {
  if (!expr) return undefined;
  const fn = unwrap(expr);
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return undefined;
  return {
    parameters: fn.parameters.map((p) => ({
      name: p.name.getText(),
      type: typeNodeToIR(p.type),
      optional: !!p.questionToken,
      variadic: !!p.dotDotDotToken,
      hasDefault: p.initializer !== undefined,
    })),
    returnType: typeNodeToIR(fn.type),
    typeParams: (fn.typeParameters ?? []).map((p) => p.name.text),
  };
}

function findInstanceOwner(baseText: string, _sf: ts.SourceFile): string | undefined {
  const m = baseText.match(/^([A-Za-z_$][\w$]*)/);
  return m?.[1];
}

/** Best-effort static shape of a configured value (for reporting). */
function literalShape(n: ts.Expression, sf: ts.SourceFile): TypeIR | undefined {
  // unwrap casts/parens: `'nope' as unknown as number` should still yield the string literal
  if (ts.isAsExpression(n) || ts.isParenthesizedExpression(n)) return literalShape(n.expression, sf);
  if (ts.isStringLiteral(n)) return { kind: 'literal', value: n.text };
  if (ts.isNumericLiteral(n)) return { kind: 'literal', value: Number(n.text) };
  if (n.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'literal', value: true };
  if (n.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'literal', value: false };
  if (ts.isArrayLiteralExpression(n))
    return { kind: 'array', element: n.elements[0] ? literalShape(n.elements[0]!, sf) : undefined };
  if (ts.isObjectLiteralExpression(n)) return { kind: 'unknown' };
  if (ts.isNewExpression(n) && ts.isIdentifier(n.expression))
    return { kind: 'named', name: n.expression.text, typeArgs: [] };
  return undefined;
}

/**
 * The configured-value expression for a config span: climb from the deepest node to the
 * enclosing call (`spy.mockReturnValue(<value>)`) and take its first argument. Spanning the
 * whole config call — and thus resolving the callee identifier (`spy`) — would type-check the
 * mock function itself against the production return type and fire on every spy.
 */
function configuredValueNode(sf: ts.SourceFile, s: SourceSpan): ts.Expression | undefined {
  const pos = sf.getPositionOfLineAndCharacter(s.startLine - 1, s.startCol - 1);
  let node: ts.Node | undefined = findDeepest(sf, pos);
  while (node && !ts.isCallExpression(node)) node = node.parent;
  const arg = node?.arguments[0];
  return arg && ts.isExpression(arg) ? arg : undefined;
}

/** Compute DRIFT-003 assignability for stub return values against the production signature. */
function computeReturnAssignability(
  handle: ReturnType<typeof getProgram>,
  sf: ts.SourceFile,
  targetSymbolId: string,
  stubs: StubbedMemberIR[],
  typeAware: boolean,
): void {
  if (!typeAware) return;
  for (const stub of stubs) {
    const sig = classMethodSignature(handle, targetSymbolId, stub.name);
    for (const v of stub.returnValues) {
      // mockRejectedValue configures a rejection *reason*, not a resolved value — the
      // production return type never applies to it (checked against the promise's rejection).
      if (v.api === 'mockRejectedValue' || v.api === 'mockRejectedValueOnce') continue;
      const isImplementation = v.api === 'mockImplementation' || v.api === 'mockImplementationOnce';
      if (!isImplementation && v.value === undefined) continue;
      if (!sig) {
        v.assignable = 'unknown';
        continue;
      }
      const retType = unwrapPromise(sig.checker, sig.returnType);
      // generic type parameters (e.g. query<T>(): Promise<T[]>) are not statically checkable
      if (containsTypeParameter(sig.checker, retType)) {
        v.assignable = 'unknown';
        continue;
      }
      const valNode = configuredValueNode(sf, v.span);
      if (!valNode) {
        v.assignable = 'unknown';
        continue;
      }
      try {
        if (isImplementation) {
          // the configured value is a callback; compare its body's return type to production
          const implType = sig.checker.getTypeAtLocation(valNode);
          const implReturn = implType.getCallSignatures()[0]?.getReturnType();
          v.assignable = implReturn ? sig.checker.isTypeAssignableTo(implReturn, retType) : 'unknown';
        } else {
          const valType = sig.checker.getTypeAtLocation(valNode);
          v.assignable = sig.checker.isTypeAssignableTo(valType, retType);
        }
      } catch {
        v.assignable = 'unknown';
      }
    }
  }
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
