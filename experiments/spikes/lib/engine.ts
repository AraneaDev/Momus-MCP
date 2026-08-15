// Mini engine: validates the feasibility of the Momus analysis pipeline.
// Implements a deliberately small subset of docs/02 + docs/03 for TypeScript:
//   - mock detection (vi.mock / vi.fn / vi.spyOn / vi.mocked)
//   - TAUT-001/002/006 via intra-procedural provenance
//   - DRIFT-001 via TypeChecker member lookup
//   - DRIFT-005 via factory-key vs module-exports comparison
//   - DRIFT-003 via assignability of configured values to production return types
import * as ts from 'typescript';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

export interface Issue {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  file: string;
  line: number;
  col: number;
  message: string;
}

const callName = (n: ts.Expression): string | null => {
  if (ts.isIdentifier(n)) return n.text;
  if (ts.isPropertyAccessExpression(n)) return callName(n.expression) + '.' + n.name.text;
  return null;
};

const unwrap = (e: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e;

// ---------------------------------------------------------------- mock detection
export interface MockInfo {
  pattern: 'vi.mock' | 'vi.fn' | 'vi.spyOn' | 'vi.mocked';
  line: number;
  specifier?: string;
  factoryKeys?: string[];
  chained: string[]; // mockReturnValue | mockResolvedValue | ...
  spyTargetName?: string;
}

export function detectMocks(sf: ts.SourceFile): MockInfo[] {
  const out: MockInfo[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      if (name === 'vi.mock' || name === 'jest.mock') {
        const specifier = node.arguments[0] && ts.isStringLiteral(node.arguments[0])
          ? node.arguments[0].text : undefined;
        const factory = node.arguments[1] ? unwrap(node.arguments[1]) : undefined;
        const keys: string[] = [];
        if (factory && ts.isArrowFunction(factory) && factory.body && ts.isObjectLiteralExpression(unwrap(factory.body))) {
          for (const p of (unwrap(factory.body) as ts.ObjectLiteralExpression).properties) {
            if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) keys.push(p.name.text);
          }
        }
        out.push({ pattern: name, line, specifier, factoryKeys: keys, chained: [] });
      } else if (name === 'vi.fn' || name === 'jest.fn') {
        const chained: string[] = [];
        let parent = node.parent;
        while (parent && (ts.isPropertyAccessExpression(parent) || ts.isCallExpression(parent))) {
          if (ts.isPropertyAccessExpression(parent)) {
            const last = parent.name.text;
            if (/^mock/.test(last)) chained.push(last);
          }
          parent = parent.parent;
        }
        out.push({ pattern: name, line, chained });
      } else if (name === 'vi.spyOn' || name === 'jest.spyOn') {
        const target = node.arguments[1] && ts.isStringLiteral(node.arguments[1])
          ? node.arguments[1].text : undefined;
        out.push({ pattern: name, line, spyTargetName: target, chained: [] });
      } else if (name === 'vi.mocked') {
        out.push({ pattern: 'vi.mocked', line, chained: [] });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

// ---------------------------------------------------------------- tautology rules
type Prov =
  | { kind: 'literal'; value: string }
  | { kind: 'mock-config'; key: string; value: string }
  | { kind: 'mock-call'; key: string }
  | { kind: 'unknown' };

interface Scope {
  mocks: Map<string, string[]>;          // instance name -> member names (object-literal vi.fn mocks)
  configs: Map<string, string>;          // 'mocked.getTotal' -> literal value text
  bindings: Map<string, ts.Expression>;  // identifier -> defining expression
  spies: Set<string>;                    // identifiers bound to vi.spyOn results
}

export function buildScope(body: ts.Block | ts.ConciseBody, sf: ts.SourceFile): Scope {
  const scope: Scope = { mocks: new Map(), configs: new Map(), bindings: new Map(), spies: new Set() };
  const stmts = ts.isBlock(body) ? body.statements : [body];
  for (const st of stmts) {
    if (!ts.isVariableStatement(st)) continue;
    for (const decl of st.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      const init = decl.initializer;
      scope.bindings.set(decl.name.text, init);
      if (ts.isObjectLiteralExpression(init)) {
        const members: string[] = [];
        for (const p of init.properties) {
          if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && ts.isCallExpression(p.initializer)
              && callName(p.initializer.expression) === 'vi.fn') {
            members.push(p.name.text);
          }
        }
        if (members.length) scope.mocks.set(decl.name.text, members);
      }
      if (ts.isCallExpression(init) && callName(init.expression) === 'vi.spyOn') {
        scope.spies.add(decl.name.text);
      }
    }
  }
  // mock config registrations: <expr>.mockReturnValue(<lit>) anywhere in the body
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const name = callName(n.expression);
      if (name && /\.mock(ReturnValue|ResolvedValue|ReturnValueOnce)$/.test(name)) {
        const keyExpr = (n.expression as ts.PropertyAccessExpression).expression;
        const val = n.arguments[0];
        if (val && (ts.isNumericLiteral(val) || ts.isStringLiteral(val) || ts.isIdentifier(val))) {
          scope.configs.set(keyExpr.getText(sf), val.getText(sf));
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return scope;
}

export function provenance(expr: ts.Expression, scope: Scope, sf: ts.SourceFile): Prov {
  if (ts.isNumericLiteral(expr) || ts.isStringLiteral(expr)) {
    return { kind: 'literal', value: expr.getText(sf) };
  }
  if (ts.isIdentifier(expr)) {
    const bound = scope.bindings.get(expr.text);
    if (bound) return provenance(bound, scope, sf);
    return { kind: 'unknown' };
  }
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression.getText(sf);
    if (scope.configs.has(callee)) return { kind: 'mock-config', key: callee, value: scope.configs.get(callee)! };
    if (ts.isPropertyAccessExpression(expr.expression)) {
      const obj = expr.expression.expression.getText(sf);
      const member = expr.expression.name.text;
      const mockMembers = scope.mocks.get(obj);
      if (mockMembers?.includes(member)) return { kind: 'mock-call', key: callee };
    }
    return { kind: 'unknown' };
  }
  if (ts.isPropertyAccessExpression(expr)) {
    const obj = expr.expression.getText(sf);
    const bound = scope.bindings.get(obj);
    if (bound && ts.isPropertyAccessExpression(bound)) return provenance(bound, scope, sf);
    return { kind: 'unknown' };
  }
  return { kind: 'unknown' };
}

export function tautologyIssues(sf: ts.SourceFile, file: string): Issue[] {
  const issues: Issue[] = [];
  const check = (assertExpr: ts.CallExpression, matcher: string, scope: Scope) => {
    // expect(A).toBe(B): A = expect(...) arg, B = matcher call arg
    let expectCall: ts.Node = assertExpr.expression;
    while (ts.isPropertyAccessExpression(expectCall)) expectCall = expectCall.expression;
    if (!ts.isCallExpression(expectCall)) return;
    const [left, right] = [expectCall.arguments[0], assertExpr.arguments[0]] as ts.Expression[];
    if (!left || !right) return;
    const line = sf.getLineAndCharacterOfPosition(assertExpr.getStart()).line + 1;
    const col = sf.getLineAndCharacterOfPosition(assertExpr.getStart()).character + 1;
    const lText = left.getText(sf);
    const rText = right.getText(sf);
    // TAUT-001: self comparison
    if (lText === rText) {
      issues.push({ rule: 'TAUT-001', severity: 'error', file, line, col, message: `self-comparison: ${lText} compared with itself` });
    }
    const pL = provenance(left, scope, sf);
    const pR = provenance(right, scope, sf);
    // TAUT-002: mock echo
    const echo =
      (pL.kind === 'mock-config' && pR.kind === 'literal' && pL.value === rText) ||
      (pR.kind === 'mock-config' && pL.kind === 'literal' && pR.value === lText) ||
      (pL.kind === 'mock-config' && pR.kind === 'mock-config' && pL.key === pR.key);
    if (echo) {
      issues.push({ rule: 'TAUT-002', severity: 'error', file, line, col, message: `mock-echo: asserts stubbed value (${pL.kind === 'mock-config' ? pL.value : pR.value}) against itself` });
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      if (name === 'expect' || name === 'vi.expect') {
        // walk up the property-access chain: expect(A).resolves.toBe(B)
        let assert: ts.Node | undefined = node.parent;
        while (assert && ts.isPropertyAccessExpression(assert)) assert = assert.parent;
        if (!assert || !ts.isCallExpression(assert)) return;
        const matcherCall = assert as ts.CallExpression;
        const matcher = ts.isPropertyAccessExpression(matcherCall.expression)
          ? matcherCall.expression.name.text : null;
        if (!matcher) return;
        // find enclosing function body
        let fn: ts.Node | undefined = node.parent;
        while (fn && !ts.isBlock(fn)) fn = fn.parent;
        if (!fn) return;
        const scope = buildScope(fn as ts.Block, sf);
        if (['toBe', 'toEqual', 'toStrictEqual'].includes(matcher)) {
          check(matcherCall, matcher, scope);
        }
        // TAUT-006: unconfigured spy assertion
        if (matcher.startsWith('toHaveBeenCalled')) {
          let operand: ts.Node = matcherCall.expression;
          while (ts.isPropertyAccessExpression(operand)) operand = operand.expression;
          if (!ts.isCallExpression(operand)) return;
          const arg = operand.arguments[0];
          if (arg && ts.isIdentifier(arg) && scope.spies.has(arg.text)) {
            const conf = [...scope.configs.keys()].some((k) => k.startsWith(arg.text + '.'));
            const invoked = [...scope.bindings.entries()].some(([id, e]) =>
              id !== arg.text && e.getText(sf).includes(arg.text + '.'));
            if (!conf && !invoked) {
              const line2 = sf.getLineAndCharacterOfPosition(matcherCall.getStart()).line + 1;
              const col2 = sf.getLineAndCharacterOfPosition(matcherCall.getStart()).character + 1;
              issues.push({ rule: 'TAUT-006', severity: 'warning', file, line: line2, col: col2, message: `unconfigured-spy-assert: '${arg.text}' has no stub and no production call path` });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return issues;
}

// ---------------------------------------------------------------- drift rules (type-aware)
export function makeProgram(rootDir: string): ts.Program {
  const files: string[] = [];
  const collect = (dir: string) => {
    for (const f of ts.sys.readDirectory(dir, ['.ts', '.tsx'], undefined, undefined)) files.push(f);
  };
  collect(resolve(rootDir, 'src'));
  collect(resolve(rootDir, 'tests'));
  const configPath = ts.findConfigFile(rootDir, ts.sys.fileExists, 'tsconfig.json');
  const options = configPath
    ? ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })!.options
    : { strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };

  // CRITICAL: ts.createProgram's default host parses files WITHOUT parent pointers,
  // so node.parent walks (scope analysis) return nothing. Pre-parse every file with
  // setParentNodes=true and hand the instances to the program via a custom host
  // (the typescript-eslint pattern). The checker then works on the same instances.
  const parsed = new Map<string, ts.SourceFile>();
  const host = ts.createCompilerHost(options, true);
  const orig = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const key = ts.sys.resolvePath ? ts.sys.resolvePath(fileName) : fileName;
    const hit = parsed.get(key);
    if (hit) return hit;
    const text = ts.sys.readFile(key);
    const sf = text !== undefined
      ? ts.createSourceFile(key, text, languageVersion as ts.ScriptTarget, true, true)
      : orig(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    if (sf) parsed.set(key, sf);
    return sf;
  };
  return ts.createProgram(files, options, host);
}

export function driftIssues(
  sf: ts.SourceFile,
  file: string,
  program: ts.Program,
  log: (s: string) => void = () => {},   // MCP servers MUST NOT write to stdout — transport channel
): Issue[] {
  const checker = program.getTypeChecker();
  const issues: Issue[] = [];
  const pos = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart());

  // DRIFT-001: vi.spyOn(obj, 'member') — member must exist on obj's type
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && callName(node.expression) === 'vi.spyOn') {
      const [objExpr, memberExpr] = node.arguments;
      const line = pos(node).line + 1;
      const col = pos(node).character + 1;
      if (!objExpr || !memberExpr || !ts.isStringLiteral(memberExpr)) return;
      const type = checker.getTypeAtLocation(objExpr);
      const prop = type.getProperty(memberExpr.text);
      if (!prop) {
        issues.push({ rule: 'DRIFT-001', severity: 'error', file, line, col, message: `missing-member: '${memberExpr.text}' does not exist on ${checker.typeToString(type)}` });
      } else {
        log(`    [drift] ok: ${checker.typeToString(type)}.${memberExpr.text} exists (${ts.SymbolFlags[prop.flags]})`);
      }
    }
    // DRIFT-005: vi.mock('mod', factory) — factory keys must be exports of the real module
    if (ts.isCallExpression(node) && callName(node.expression) === 'vi.mock') {
      const [specExpr, factory] = node.arguments;
      if (!specExpr || !ts.isStringLiteral(specExpr)) return;
      const resolved = ts.resolveModuleName(specExpr.text, sf.fileName, program.getCompilerOptions(), ts.sys).resolvedModule;
      if (!resolved) {
        log(`    [drift] unresolvable module: '${specExpr.text}' (expected for node_modules: vitest)`);
        return;
      }
      const modFile = program.getSourceFile(resolved.resolvedFileName);
      const modSym = modFile ? checker.getSymbolAtLocation(modFile) : undefined;
      const exports = modSym ? checker.getExportsOfModule(modSym).map((e) => e.name) : [];
      const line = pos(node).line + 1;
      if (factory && ts.isArrowFunction(factory) && factory.body && ts.isObjectLiteralExpression(unwrap(factory.body))) {
        for (const p of (unwrap(factory.body) as ts.ObjectLiteralExpression).properties) {
          if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
            const key = p.name.text;
            if (exports.length && !exports.includes(key)) {
              issues.push({ rule: 'DRIFT-005', severity: 'error', file, line, col: pos(node).character + 1, message: `missing-export: factory key '${key}' is not exported by '${specExpr.text}'` });
            } else {
              log(`    [drift] ok: '${key}' is an export of '${specExpr.text}' (${exports.length} exports)`);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return issues;
}

// DRIFT-003: is a configured value assignable to the production return type?
export function checkReturnAssignability(
  sf: ts.SourceFile,
  program: ts.Program,
  log: (s: string) => void,
): void {
  const checker = program.getTypeChecker();
  const prodFile = program.getSourceFiles().find((f) => f.fileName.endsWith('src/services/ledger.ts'))!;
  const cls = prodFile.statements.find((s) => ts.isClassDeclaration(s) && s.name?.text === 'LedgerService') as ts.ClassDeclaration;
  const method = cls.members.find((m) => ts.isMethodDeclaration(m) && m.name.getText(prodFile) === 'totalFor') as ts.MethodDeclaration;
  const sig = checker.getSignatureFromDeclaration(method);
  const declaredRet = checker.getReturnTypeOfSignature(sig!);
  // async methods return Promise<T>: DRIFT-003 compares against the resolved type
  const retType = checker.getPromisedTypeOfPromise(declaredRet) ?? declaredRet;
  log(`    [drift] LedgerService.totalFor return type: ${checker.typeToString(declaredRet)} (resolved: ${checker.typeToString(retType)})`);

  // Real checker types from a fixture file that is part of the program
  const shapesFile = program.getSourceFiles().find((f) => f.fileName.endsWith('tests/shapes.helper.ts'))!;
  const shapeType = (name: string) => {
    const decl = shapesFile.statements
      .filter((s): s is ts.VariableStatement => ts.isVariableStatement(s))
      .find((s) => s.declarationList.declarations[0].name.getText(shapesFile) === name)!;
    return checker.getTypeAtLocation(decl.declarationList.declarations[0].name);
  };
  const cases: Array<[string, string, boolean]> = [
    ['goodShape', 'full shape {id,totalCents,status}', true],
    ['partialShape', 'missing required props {id}', false],
    ['wrongStatus', 'status outside union', false],
    ['numericCents', 'totalCents wrong type', false],
  ];
  for (const [name, desc, want] of cases) {
    const got = checker.isTypeAssignableTo(shapeType(name), retType);
    log(`    [drift] assignable ${desc} -> Invoice? ${got} (want ${want})`);
  }
}

// ---------------------------------------------------------------- issue helpers
export const rel = (p: string) => p.replace(/^.*?\/fixtures\//, 'fixtures/');
