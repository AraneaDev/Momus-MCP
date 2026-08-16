/** Phase 2 PHP parser plugin: php-parser AST -> language-neutral Momus IR. */
import * as phpParser from 'php-parser';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type {
  AssertionIR,
  ConfiguredValueIR,
  ExprIR,
  ImportIR,
  LanguageParser,
  MockFramework,
  MockIR,
  ModuleIR,
  ParamIR,
  ParseContext,
  RawComment,
  SignatureIR,
  SourceSpan,
  StubbedMemberIR,
  SymbolIR,
  TypeIR,
} from '@momus/core';
import { span } from '@momus/core';

type PhpNode = {
  kind?: string;
  [key: string]: any;
};

const MOCK_FACTORIES = new Set([
  'createMock',
  'createStub',
  'createConfiguredMock',
  'createPartialMock',
  'getMockForAbstractClass',
]);
const MOCKERY_FACTORIES = new Set(['mock', 'spy']);
const CONFIG_CALLS = new Set([
  'method',
  'shouldReceive',
  'willReturn',
  'andReturn',
  'willReturnCallback',
  'willThrowException',
]);

interface PhpMockState {
  mocks: MockIR[];
  /** Binding entries per `scope:name` key, ordered by assignment line for shadowing semantics. */
  bindings: Map<string, Array<{ line: number; mock: MockIR }>>;
  /** Mockery/Pest closure-form bindings: param name → mock, scoped by closure span. */
  closureBindings: Array<{ name: string; mock: MockIR; startLine: number; endLine: number }>;
}

export class PhpParser implements LanguageParser {
  readonly language = 'php' as const;
  private readonly engine = new phpParser.Engine({
    parser: { extractDoc: true, suppressErrors: false },
    ast: { withPositions: true, withSource: true },
  });

  canParse(path: string): boolean {
    return /\.php$/i.test(path);
  }

  resolveImport(specifier: string, fromFile: string): string | null {
    const className = specifier.replace(/^\\+/, '');
    let dir = dirname(fromFile);
    for (let depth = 0; depth < 8; depth++) {
      const composerPath = join(dir, 'composer.json');
      if (existsSync(composerPath)) {
        try {
          const composer = JSON.parse(readFileSync(composerPath, 'utf8')) as {
            autoload?: {
              'psr-4'?: Record<string, string | string[]>;
              classmap?: string[];
            };
          };
          const mappings = composer.autoload?.['psr-4'] ?? {};
          for (const [prefix, roots] of Object.entries(mappings)) {
            if (!className.startsWith(prefix)) continue;
            const relative = className.slice(prefix.length).replaceAll('\\\\', '/') + '.php';
            for (const root of Array.isArray(roots) ? roots : [roots]) {
              const candidate = resolve(dir, root, relative);
              if (existsSync(candidate)) return candidate;
            }
          }
          const shortName = className.split('\\').pop() ?? className;
          for (const root of composer.autoload?.classmap ?? []) {
            const classmapRoot = resolve(dir, root);
            const candidate = findClassmapFile(classmapRoot, shortName);
            if (candidate) return candidate;
          }
        } catch {
          return null;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  parseModule(path: string, source: string, _ctx: ParseContext): ModuleIR {
    const diagnostics: ModuleIR['diagnostics'] = [];
    let ast: PhpNode;
    try {
      ast = this.engine.parseCode(source, path) as unknown as PhpNode;
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        span: span(path, 1, 1, 1, 1),
        message: `SYS-001: PHP parse error: ${(error as Error).message}`.slice(0, 120),
      });
      return emptyModule(path, diagnostics);
    }

    const nodes: PhpNode[] = [];
    walk(ast, (node) => nodes.push(node));
    const classes = nodes.filter((node) => node.kind === 'class' && !node.isAnonymous);
    const imports = nodes
      .filter((node) => node.kind === 'usegroup')
      .flatMap(useToImports)
      .map((item) => ({ ...item, resolvedPath: this.resolveImport(item.specifier, path) ?? undefined }));
    const symbols = classes.map((node) => classToSymbol(path, node));
    const exports = symbols.map((symbol) => symbol.name);
    const isTest = /(?:^|[\\/])tests[\\/]/i.test(path) || classes.some(isTestClass);
    const framework: MockFramework | undefined = isTest ? 'phpunit' : undefined;
    const mockState = extractMocks(path, nodes, imports);
    const mocks = mockState.mocks;
    const functions = extractTestFunctions(path, classes);
    const assertions = extractAssertions(path, nodes, functions, mocks, mockState.bindings);

    return {
      path,
      language: 'php',
      kind: isTest ? 'test' : 'production',
      framework,
      imports,
      symbols,
      exports,
      mocks,
      assertions,
      functions,
      comments: extractComments(nodes),
      diagnostics,
      hash: '',
    };
  }
}

function findClassmapFile(root: string, className: string): string | null {
  if (!existsSync(root)) return null;
  let stats;
  try {
    stats = statSync(root);
  } catch {
    return null;
  }
  if (stats.isFile()) return root.endsWith(`${className}.php`) ? root : null;
  if (!stats.isDirectory()) return null;
  for (const entry of readdirSync(root)) {
    const candidate = findClassmapFile(join(root, entry), className);
    if (candidate) return candidate;
  }
  return null;
}

function emptyModule(path: string, diagnostics: ModuleIR['diagnostics']): ModuleIR {
  return {
    path,
    language: 'php',
    kind: 'production',
    imports: [],
    symbols: [],
    exports: [],
    mocks: [],
    assertions: [],
    functions: [],
    comments: [],
    diagnostics,
    hash: '',
  };
}

function classToSymbol(file: string, node: PhpNode): SymbolIR {
  const name = identifierText(node.name) ?? 'anonymous';
  const id = `${file}#${name}`;
  const members = (node.body ?? [])
    .filter((child: PhpNode) => child.kind === 'method')
    .map((method: PhpNode) => ({
      id: `${id}.${identifierText(method.name) ?? 'anonymous'}`,
      name: identifierText(method.name) ?? 'anonymous',
      kind: 'method' as const,
      span: nodeSpan(file, method),
      members: [],
      extendsIds: [],
      implementsIds: [],
      signature: methodSignature(method, parseDocblock(docblockOf(method))),
      visibility:
        method.visibility === 'private'
          ? ('private' as const)
          : method.visibility === 'protected'
            ? ('protected' as const)
            : ('public' as const),
      isStatic: method.isStatic === true,
      isAbstract: method.isAbstract === true,
    }));
  return {
    id,
    name,
    kind: node.isAbstract ? 'class' : 'class',
    span: nodeSpan(file, node),
    members,
    extendsIds: [],
    implementsIds: [],
  };
}

function methodSignature(node: PhpNode, doc?: DocblockTypes): SignatureIR {
  const parameters = (node.arguments ?? []).map((param: PhpNode) => {
    const ir = parameterToIR(param);
    if (!ir.type) {
      const docParam = doc?.params.get(ir.name);
      if (docParam) ir.type = docParam;
    }
    return ir;
  });
  return {
    parameters,
    returnType: phpType(node.type) ?? doc?.returns,
    typeParams: [],
  };
}

function parameterToIR(node: PhpNode): ParamIR {
  return {
    name: identifierText(node.name) ?? String(node.name ?? 'parameter'),
    type: phpType(node.type),
    optional: node.value !== null && node.value !== undefined,
    variadic: node.variadic === true,
    hasDefault: node.value !== null && node.value !== undefined,
  };
}

interface DocblockTypes {
  returns?: TypeIR;
  params: Map<string, TypeIR>;
}

/** The PHPDoc `/** ... *​/` block attached to a method (php-parser `extractDoc`). */
function docblockOf(node: PhpNode): string | undefined {
  const comment = (node.leadingComments ?? []).find((child: PhpNode) => child.kind === 'commentblock');
  return typeof comment?.value === 'string' ? comment.value : undefined;
}

/** Parse `@param` / `@return` annotations out of a PHPDoc block. */
function parseDocblock(doc: string | undefined): DocblockTypes {
  const result: DocblockTypes = { params: new Map() };
  if (!doc) return result;
  for (const line of doc.split(/\r?\n/)) {
    const match = /@(param|return|returns)\b/.exec(line);
    if (!match) continue;
    const rest = line.slice(match.index! + match[0].length).trim();
    const tag = match[1]!;
    if (tag === 'return' || tag === 'returns') {
      const typeText = rest.split(/\s+/, 1)[0] ?? '';
      const parsed = parseDocType(typeText);
      if (parsed) result.returns = parsed;
    } else {
      const [typeText, varName] = rest.split(/\s+/);
      const parsed = parseDocType(typeText ?? '');
      const name = varName?.replace(/^[&$.]+/, '');
      if (parsed && name) result.params.set(name, parsed);
    }
  }
  return result;
}

/** Parse a PHPDoc type expression (`int`, `Invoice|null`, `int[]`, `array<int, Invoice>`, …). */
function parseDocType(text: string): TypeIR | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const union = splitTopLevel(trimmed, '|');
  if (union.length > 1) return unionType(union.map(parseDocType));
  const intersection = splitTopLevel(trimmed, '&');
  if (intersection.length > 1) {
    const members = intersection.map((part) => parseDocType(part)).filter((t): t is TypeIR => !!t);
    return members.length ? { kind: 'intersection', members } : undefined;
  }
  return parseDocTypeAtom(trimmed);
}

function unionType(parts: Array<TypeIR | undefined>): TypeIR | undefined {
  const members: TypeIR[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (part.kind === 'union') members.push(...part.members);
    else members.push(part);
  }
  if (members.length === 0) return undefined;
  if (members.length === 1) return members[0];
  return { kind: 'union', members };
}

function parseDocTypeAtom(text: string): TypeIR | undefined {
  let value = text.trim();
  if (!value) return undefined;
  let nullable = false;
  if (value.startsWith('?')) {
    nullable = true;
    value = value.slice(1).trim();
  }
  let arrayDepth = 0;
  while (value.endsWith('[]')) {
    arrayDepth++;
    value = value.slice(0, -2).trim();
  }
  let result: TypeIR | undefined = parseGenericType(value) ?? docTypeForName(value);
  while (arrayDepth-- > 0) result = { kind: 'array', element: result };
  if (nullable) result = { kind: 'union', members: [result, { kind: 'null' }] };
  return result;
}

function parseGenericType(text: string): TypeIR | undefined {
  const open = text.indexOf('<');
  if (open <= 0 || !text.endsWith('>')) return undefined;
  const name = text.slice(0, open).trim();
  const argsText = text.slice(open + 1, -1).trim();
  const args = splitTopLevel(argsText, ',')
    .map((arg) => parseDocType(arg.trim()))
    .filter((t): t is TypeIR => !!t);
  const short = shortTypeName(name);
  const lower = short.toLowerCase();
  if (lower === 'array' || lower === 'list' || lower === 'non-empty-array' || lower === 'non-empty-list') {
    return { kind: 'array', element: args[args.length - 1] };
  }
  return { kind: 'named', name: short, typeArgs: args };
}

function docTypeForName(name: string): TypeIR {
  const short = shortTypeName(name);
  const lower = short.toLowerCase();
  if (lower === 'array') return { kind: 'array' };
  if (lower === 'void') return { kind: 'void' };
  if (lower === 'null' || lower === 'nulltype') return { kind: 'null' };
  if (lower === 'mixed' || lower === 'any' || lower === 'never') return { kind: 'unknown' };
  if (lower === 'int' || lower === 'integer') return { kind: 'named', name: 'int', typeArgs: [] };
  if (lower === 'float' || lower === 'double' || lower === 'real')
    return { kind: 'named', name: 'float', typeArgs: [] };
  if (lower === 'bool' || lower === 'boolean' || lower === 'true' || lower === 'false')
    return { kind: 'named', name: 'bool', typeArgs: [] };
  if (
    lower === 'string' ||
    lower === 'numeric-string' ||
    lower === 'literal-string' ||
    lower === 'class-string' ||
    lower === 'non-empty-string'
  )
    return { kind: 'named', name: 'string', typeArgs: [] };
  return { kind: 'named', name: short, typeArgs: [] };
}

function shortTypeName(name: string): string {
  const cleaned = name.replace(/^\\+/, '');
  return cleaned.split('\\').filter(Boolean).pop() ?? cleaned;
}

function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '<' || ch === '(' || ch === '{') depth++;
    else if (ch === '>' || ch === ')' || ch === '}') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

function phpType(node: PhpNode | null | undefined): TypeIR | undefined {
  if (!node) return undefined;
  const name = identifierText(node) ?? (typeof node.name === 'string' ? node.name : undefined);
  if (name) {
    if (name === 'array') return { kind: 'array' };
    if (name === 'void') return { kind: 'void' };
    if (name === 'null') return { kind: 'null' };
    if (name === 'mixed') return { kind: 'unknown' };
    return { kind: 'named', name, typeArgs: [] };
  }
  if (node.kind === 'uniontype' || node.kind === 'intersectiontype') {
    const members = (node.types ?? []).map((child: PhpNode) => phpType(child) ?? { kind: 'unknown' as const });
    return node.kind === 'uniontype' ? { kind: 'union', members } : { kind: 'intersection', members };
  }
  if (node.kind === 'nullable') {
    const inner = phpType(node.type) ?? { kind: 'unknown' as const };
    return { kind: 'union', members: [inner, { kind: 'null' }] };
  }
  return { kind: 'unknown' };
}

function useToImports(node: PhpNode): ImportIR[] {
  return (node.items ?? []).map((item: PhpNode) => {
    const specifier = typeof item.name === 'string' ? item.name : (identifierText(item.name) ?? '');
    const local = identifierText(item.alias) ?? specifier.split('\\').pop() ?? specifier;
    return { specifier, names: [local] };
  });
}

function extractMocks(file: string, nodes: PhpNode[], imports: ImportIR[]): PhpMockState {
  const assignments = new Map<PhpNode, string>();
  for (const node of nodes) {
    if (node.kind !== 'assign') continue;
    if (!(node.right && typeof node.right === 'object')) continue;
    const name = assignmentBindingName(node.left);
    if (name) assignments.set(node.right, name);
  }

  const mocks: MockIR[] = [];
  const byBinding = new Map<string, Array<{ line: number; mock: MockIR }>>();
  const closureBindings: PhpMockState['closureBindings'] = [];
  const methods = nodes.filter((node) => node.kind === 'method');
  const classes = nodes.filter((node) => node.kind === 'class' && !node.isAnonymous);
  for (const call of nodes.filter((node) => node.kind === 'call')) {
    const name = callName(call);
    const staticClass = staticCallClass(call);
    const isPestMock = name === 'mock' && !staticClass;
    const isMockery = !!staticClass && MOCKERY_FACTORIES.has(name ?? '');
    if (!name || (!MOCK_FACTORIES.has(name) && !isPestMock && !isMockery)) continue;
    const id = `${file}#mock:${nodeLine(call)}:${nodeColumn(call)}`;
    const targetName = resolveClassAlias(classNameFromArg(call.arguments?.[0]), imports);
    const pattern: MockIR['pattern'] = isPestMock ? 'pest-mock' : isMockery ? 'mockery' : (name as MockIR['pattern']);
    const mock: MockIR = {
      id,
      span: nodeSpan(file, call),
      framework: isPestMock ? 'pest' : 'phpunit',
      pattern,
      target: targetName
        ? { kind: 'class', exportName: targetName, span: nodeSpan(file, call.arguments?.[0] ?? call) }
        : undefined,
      stubbedMembers: [],
      configuredValues: [],
      invocationSites: [],
      isAutomock: name === 'createMock' || name === 'createStub',
    };
    if (name === 'createPartialMock') addPartialMembers(mock, call.arguments?.[1]);
    if (name === 'createConfiguredMock') addConfiguredMembers(mock, call.arguments?.[1], file);
    mocks.push(mock);
    const binding = assignments.get(call);
    if (binding)
      recordBinding(byBinding, scopedKey(bindingScope(binding, call, methods, classes), binding), mock, nodeLine(call));
    const closure = call.arguments?.[1];
    if ((isMockery || isPestMock) && closure && (closure.kind === 'closure' || closure.kind === 'arrowfunc')) {
      const param = closure.arguments?.[0];
      const paramName =
        param?.kind === 'variable'
          ? variableText(param)
          : param?.kind === 'parameter' && param.name
            ? variableText(param.name)
            : undefined;
      if (paramName) {
        closureBindings.push({
          name: paramName,
          mock,
          startLine: nodeLine(closure),
          endLine: closure.loc?.end?.line ?? nodeLine(closure),
        });
      }
    }
  }

  for (const call of nodes.filter((node) => node.kind === 'call')) {
    if (callName(call) !== 'getMock') continue;
    const builder = findCallInChain(call, 'getMockBuilder');
    if (!builder || !findCallInChain(call, 'enableOriginalConstructor')) continue;
    const targetName = resolveClassAlias(classNameFromArg(builder.arguments?.[0]), imports);
    const argsCall = findCallInChain(call, 'setConstructorArgs');
    const args = argsCall?.arguments?.[0];
    const mock: MockIR = {
      id: `${file}#mock:${nodeLine(call)}:${nodeColumn(call)}`,
      span: nodeSpan(file, call),
      framework: 'phpunit',
      pattern: 'getMockBuilder',
      target: targetName ? { kind: 'class', exportName: targetName, span: nodeSpan(file, builder) } : undefined,
      stubbedMembers: [],
      configuredValues: [],
      invocationSites: [],
      isAutomock: false,
      constructorArgs: {
        count: args?.kind === 'array' ? (args.items ?? []).length : 0,
        span: nodeSpan(file, argsCall ?? call),
      },
    };
    mocks.push(mock);
    const binding = assignments.get(call);
    if (binding)
      recordBinding(byBinding, scopedKey(bindingScope(binding, call, methods, classes), binding), mock, nodeLine(call));
  }

  // Anonymous-class doubles: `new class extends Foo { public function m() {...} }`.
  for (const node of nodes.filter((candidate) => candidate.kind === 'new')) {
    const cls = node.what;
    if (cls?.kind !== 'class' || !cls.isAnonymous || !cls.extends) continue;
    const rawName = identifierText(cls.extends);
    const targetName = rawName ? shortTypeName(resolveClassAlias(rawName, imports) ?? '') : undefined;
    const mock: MockIR = {
      id: `${file}#mock:${nodeLine(node)}:${nodeColumn(node)}`,
      span: nodeSpan(file, node),
      framework: 'phpunit',
      pattern: 'anonymous-class',
      target: targetName ? { kind: 'class', exportName: targetName, span: nodeSpan(file, cls.extends) } : undefined,
      stubbedMembers: (cls.body ?? [])
        .filter((child: PhpNode) => child.kind === 'method')
        .map((method: PhpNode) => ({
          name: identifierText(method.name) ?? 'anonymous',
          span: nodeSpan(file, method),
          signature: methodSignature(method, parseDocblock(docblockOf(method))),
          returnValues: [],
          api: 'instance-member' as const,
        })),
      configuredValues: [],
      invocationSites: [],
      isAutomock: false,
    };
    mocks.push(mock);
    const binding = assignments.get(node);
    if (binding)
      recordBinding(byBinding, scopedKey(bindingScope(binding, node, methods, classes), binding), mock, nodeLine(node));
  }

  for (const call of nodes.filter((node) => node.kind === 'call')) {
    const name = callName(call);
    if (!name || !CONFIG_CALLS.has(name)) continue;
    const binding = bindingName(call);
    const mock = binding
      ? resolveConfigBinding(
          binding,
          nodeLine(call),
          byBinding,
          closureBindings,
          bindingScope(binding, call, methods, classes),
        )
      : undefined;
    if (!mock) continue;
    const memberCall = findMemberCall(call.what);
    if (name === 'method' || name === 'shouldReceive') {
      const memberName = stringValue(call.arguments?.[0]);
      if (memberName) ensureStub(mock, memberName, file, call);
    } else if ((name === 'willReturn' || name === 'andReturn') && memberCall) {
      const memberName = stringValue(memberCall.arguments?.[0]);
      if (memberName) {
        const stub = ensureStub(mock, memberName, file, memberCall);
        const value = call.arguments?.[0];
        const configured: ConfiguredValueIR = {
          span: nodeSpan(file, call),
          api: name,
          value: phpValue(value),
          once: false,
          assignable: 'unknown',
        };
        stub.returnValues.push(configured);
        mock.configuredValues.push(configured);
      }
    }
    if (!CONFIG_CALLS.has(name) || name === 'willReturn' || name === 'andReturn') continue;
    if (name !== 'method' && name !== 'shouldReceive') mock.invocationSites.push(nodeSpan(file, call));
  }

  // Hand-off reachability: a mock passed to a constructor/call or returned from a closure is
  // handed off to production, so it must not be flagged as zero-reach (TAUT-005). This mirrors
  // the TS side's argument/object/array hand-off detection (e.g. `new ProjectWriterLease($pdo)`
  // and the inner `return $stmt;` inside a `willReturnCallback` closure).
  const markReachable = (mock: MockIR, node: PhpNode): void => {
    const line = nodeLine(node);
    if (!mock.invocationSites.some((s) => s.startLine === line)) {
      mock.invocationSites.push(nodeSpan(file, node));
    }
  };
  const mockAt = (expr: PhpNode | undefined, node: PhpNode): MockIR | undefined => {
    if (!expr) return undefined;
    const binding = bindingName(expr);
    if (!binding) return undefined;
    return resolveConfigBinding(
      binding,
      nodeLine(node),
      byBinding,
      closureBindings,
      bindingScope(binding, node, methods, classes),
    );
  };
  for (const node of nodes) {
    if (node.kind === 'return') {
      const mock = mockAt(node.expr, node);
      if (mock) markReachable(mock, node);
    } else if (node.kind === 'new') {
      for (const arg of node.arguments ?? []) {
        const mock = mockAt(arg, node);
        if (mock) markReachable(mock, node);
      }
    } else if (node.kind === 'call') {
      const name = callName(node);
      if (name && CONFIG_CALLS.has(name)) continue;
      for (const arg of node.arguments ?? []) {
        const mock = mockAt(arg, node);
        if (mock) markReachable(mock, node);
      }
    }
  }
  return { mocks, bindings: byBinding, closureBindings };
}

/** Binding-map keys are `scope:name` so same-named mocks in different test methods don't collide. */
function scopedKey(scope: number, name: string): string {
  return `${scope}:${name}`;
}

/** Append an assignment to a binding key (later assignments shadow earlier ones within a scope). */
function recordBinding(map: PhpMockState['bindings'], key: string, mock: MockIR, line: number): void {
  const entries = map.get(key) ?? [];
  entries.push({ line, mock });
  map.set(key, entries);
}

/** Resolve the binding active at `line` (the latest assignment at or before that line). */
function nearestBinding(entries: Array<{ line: number; mock: MockIR }> | undefined, line: number): MockIR | undefined {
  if (!entries || entries.length === 0) return undefined;
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

/** Start line of the innermost enclosing class method, or 0 when the node is top-level. */
function enclosingScope(methods: PhpNode[], node: PhpNode): number {
  const line = nodeLine(node);
  let best = 0;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const method of methods) {
    const start = nodeLine(method);
    const end = method.loc?.end?.line ?? start;
    if (start <= line && line <= end && end - start < bestSpan) {
      best = start;
      bestSpan = end - start;
    }
  }
  return best;
}

/** Start line of the innermost enclosing class, or 0 when the node is top-level. */
function enclosingClassScope(classes: PhpNode[], node: PhpNode): number {
  const line = nodeLine(node);
  let best = 0;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const cls of classes) {
    const start = nodeLine(cls);
    const end = cls.loc?.end?.line ?? start;
    if (start <= line && line <= end && end - start < bestSpan) {
      best = start;
      bestSpan = end - start;
    }
  }
  return best;
}

/** Property mocks (`$this->x`) live at class scope; local variables at enclosing-method scope. */
function bindingScope(name: string, node: PhpNode, methods: PhpNode[], classes: PhpNode[]): number {
  return name.startsWith('this:') ? enclosingClassScope(classes, node) : enclosingScope(methods, node);
}

function resolveConfigBinding(
  binding: string,
  line: number,
  byBinding: PhpMockState['bindings'],
  closureBindings: PhpMockState['closureBindings'],
  scope: number,
): MockIR | undefined {
  const assigned = nearestBinding(byBinding.get(scopedKey(scope, binding)), line);
  if (assigned) return assigned;
  // Same-named closure params can coexist (e.g. two Mockery::mock(..., fn ($m) => …));
  // pick the closure whose span contains the config call — nearest (smallest) on ties.
  const inside = closureBindings.filter((c) => c.name === binding && c.startLine <= line && line <= c.endLine);
  if (inside.length === 1) return inside[0]!.mock;
  if (inside.length > 1) return inside.sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0]!.mock;
  const fallback = closureBindings.find((c) => c.name === binding);
  return fallback?.mock;
}

function addPartialMembers(mock: MockIR, array: PhpNode | undefined): void {
  for (const item of array?.items ?? []) {
    const name = stringValue(item.value ?? item);
    if (name)
      mock.stubbedMembers.push({
        name,
        span: nodeSpan(mock.span.file, item.value ?? item),
        api: 'shouldReceive',
        returnValues: [],
      });
  }
}

function addConfiguredMembers(mock: MockIR, array: PhpNode | undefined, file: string): void {
  for (const item of array?.items ?? []) {
    const name = stringValue(item.key);
    if (!name) continue;
    const stub: StubbedMemberIR = {
      name,
      span: nodeSpan(file, item.key ?? item),
      api: 'shouldReceive',
      returnValues: [],
    };
    const configured: ConfiguredValueIR = {
      span: nodeSpan(file, item.value),
      api: 'literal',
      value: phpValue(item.value),
      once: false,
      assignable: 'unknown',
    };
    stub.returnValues.push(configured);
    mock.stubbedMembers.push(stub);
    mock.configuredValues.push(configured);
  }
}

function ensureStub(mock: MockIR, name: string, file: string, node: PhpNode): StubbedMemberIR {
  const existing = mock.stubbedMembers.find((stub) => stub.name === name);
  if (existing) return existing;
  const stub: StubbedMemberIR = {
    name,
    span: nodeSpan(file, node.arguments?.[0] ?? node),
    api: 'shouldReceive',
    returnValues: [],
  };
  mock.stubbedMembers.push(stub);
  return stub;
}

function extractTestFunctions(file: string, classes: PhpNode[]): ModuleIR['functions'] {
  return classes.flatMap((cls) =>
    (cls.body ?? [])
      .filter((method: PhpNode) => identifierText(method.name)?.startsWith('test'))
      .map((method: PhpNode) => ({
        id: `${file}#fn:${nodeLine(method)}`,
        span: nodeSpan(file, method),
        hasProductionCalls: false,
        productionCallCount: 0,
        assertionCount: 0,
      })),
  );
}

function extractAssertions(
  file: string,
  nodes: PhpNode[],
  functions: ModuleIR['functions'],
  mocks: MockIR[],
  bindings: PhpMockState['bindings'],
): AssertionIR[] {
  const assertions: AssertionIR[] = [];
  const methods = nodes.filter((node) => node.kind === 'method');
  const classes = nodes.filter((node) => node.kind === 'class' && !node.isAnonymous);
  for (const call of nodes.filter((node) =>
    ['assertSame', 'assertEquals', 'assertNotSame'].includes(callName(node) ?? ''),
  )) {
    const fn = functions.find(
      (candidate) => candidate.span.startLine <= nodeLine(call) && nodeLine(call) <= candidate.span.endLine,
    );
    const operands = (call.arguments ?? [])
      .slice(0, 2)
      .map((value: PhpNode) => phpExpr(value, file, mocks, bindings, methods, classes));
    assertions.push({
      id: `${file}#assert:${nodeLine(call)}:${nodeColumn(call)}`,
      span: nodeSpan(file, call),
      api: callName(call) ?? 'assertSame',
      operands,
      fnId: fn?.id ?? '',
    });
    if (fn) fn.assertionCount++;
  }
  return assertions;
}

function phpExpr(
  node: PhpNode,
  file: string,
  mocks: MockIR[],
  bindings: PhpMockState['bindings'],
  methods: PhpNode[],
  classes: PhpNode[],
): ExprIR {
  const literal = phpValue(node);
  if (literal) return { kind: 'literal', text: valueText(node), mockRefs: [], provenance: 'literal', constant: true };
  const root = bindingName(node);
  const mock = root
    ? nearestBinding(bindings.get(scopedKey(bindingScope(root, node, methods, classes), root)), nodeLine(node))
    : undefined;
  const member = callName(node);
  const configured =
    mock && member ? mock.stubbedMembers.find((stub) => stub.name === member)?.returnValues[0] : undefined;
  if (mock && configured) {
    return {
      kind: 'call',
      text: valueText(node),
      mockRefs: [mock.id],
      provenance: 'mock-config',
      configuredValue: configuredValueText(configured.value),
      constant: false,
    };
  }
  return {
    kind: exprKind(node),
    text: valueText(node),
    mockRefs: mock ? [mock.id] : [],
    provenance: mock ? 'mock-call' : 'unknown',
    constant: false,
  };
}

/** Classify a php-parser node into an `ExprIR.kind` so cross-language rules can tell
 *  re-evaluating expressions (calls / `new`) apart from stable reads (variables, literals). */
function exprKind(node: PhpNode): ExprIR['kind'] {
  switch (node.kind) {
    case 'variable':
      return 'identifier';
    case 'call':
      return 'call';
    case 'propertylookup':
    case 'staticlookup':
      return 'member';
    case 'new':
      return 'new';
    default:
      return 'unknown';
  }
}

function configuredValueText(value: TypeIR | undefined): string | undefined {
  if (!value) return undefined;
  if (value.kind === 'literal') return String(value.value);
  if (value.kind === 'named') return value.name;
  return undefined;
}

function phpValue(node: PhpNode | undefined): TypeIR | undefined {
  if (!node) return undefined;
  if (node.kind === 'number') return { kind: 'literal', value: Number(node.value) };
  if (node.kind === 'string') return { kind: 'literal', value: String(node.value) };
  if (node.kind === 'boolean') return { kind: 'literal', value: Boolean(node.value) };
  if (node.kind === 'nullkeyword') return { kind: 'null' };
  if (node.kind === 'array') return { kind: 'array' };
  if (node.kind === 'new') return { kind: 'named', name: identifierText(node.what) ?? 'unknown', typeArgs: [] };
  return undefined;
}

function extractComments(nodes: PhpNode[]): RawComment[] {
  return nodes.flatMap((node) =>
    (node.leadingComments ?? []).map((comment: PhpNode) => ({
      text: comment.value ?? '',
      line: comment.loc?.start?.line ?? 1,
      kind: 'docblock' as const,
    })),
  );
}

function isTestClass(node: PhpNode): boolean {
  return identifierText(node.extends) === 'TestCase' || identifierText(node.name)?.endsWith('Test') === true;
}

function resolveClassAlias(name: string | undefined, imports: ImportIR[]): string | undefined {
  if (!name) return undefined;
  const imported = imports.find((item) => item.names.includes(name) || item.specifier === name);
  if (!imported) return name;
  return imported.specifier.split('\\').pop() ?? name;
}

function classNameFromArg(node: PhpNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.kind === 'staticlookup') return identifierText(node.what);
  if (node.kind === 'string') return String(node.value);
  return identifierText(node) ?? (typeof node.name === 'string' ? node.name : undefined);
}

function staticCallClass(node: PhpNode): string | undefined {
  return node?.what?.kind === 'staticlookup' ? identifierText(node.what.what) : undefined;
}

function callName(node: PhpNode): string | undefined {
  if (node?.kind !== 'call') return undefined;
  if (node.what?.kind === 'propertylookup' || node.what?.kind === 'staticlookup')
    return identifierText(node.what.offset);
  return identifierText(node.what);
}

/** Binding name of the object a config/assertion chain is called on (`$mock` → `$mock`, `$this->repo` → `this:repo`). */
function bindingName(node: PhpNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.kind === 'variable') return variableText(node);
  if (node.kind === 'propertylookup') {
    const owner = bindingName(node.what);
    if (owner === '$this' || owner === 'self') return `this:${identifierText(node.offset)}`;
    return owner;
  }
  if (node.kind === 'staticlookup') return bindingName(node.what);
  if (node.kind === 'call') return bindingName(node.what);
  return undefined;
}

/** Assignment LHS → binding name: `$mock` or `this:repo` (property mocks only; other LHS ignored). */
function assignmentBindingName(left: PhpNode | undefined): string | undefined {
  if (!left) return undefined;
  if (left.kind === 'variable') return variableText(left);
  if (left.kind === 'propertylookup') {
    const owner = left.what;
    const ownerName = owner?.kind === 'variable' ? variableText(owner) : undefined;
    if (ownerName === '$this' || ownerName === 'self') return `this:${identifierText(left.offset)}`;
  }
  return undefined;
}

function findCallInChain(node: PhpNode | undefined, name: string): PhpNode | undefined {
  if (!node) return undefined;
  if (node.kind === 'call' && callName(node) === name) return node;
  if (node.kind === 'propertylookup' || node.kind === 'staticlookup' || node.kind === 'call')
    return findCallInChain(node.what, name);
  return undefined;
}

function findMemberCall(node: PhpNode | undefined): PhpNode | undefined {
  if (!node) return undefined;
  if (
    (node.kind === 'call' && callName(node) === 'method') ||
    (node.kind === 'call' && callName(node) === 'shouldReceive')
  )
    return node;
  if (node.kind === 'propertylookup' || node.kind === 'call') return findMemberCall(node.what);
  return undefined;
}

function stringValue(node: PhpNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.kind === 'string') return String(node.value);
  return typeof node.value === 'string' ? node.value : undefined;
}

function identifierText(node: PhpNode | string | null | undefined): string | undefined {
  if (!node) return undefined;
  return typeof node === 'string' ? node : typeof node.name === 'string' ? node.name : undefined;
}

function variableText(node: PhpNode): string {
  const name = identifierText(node);
  return name?.startsWith('$') ? name : `$${name ?? 'unknown'}`;
}

function valueText(node: PhpNode | undefined): string {
  if (!node) return '';
  // `loc.source` is the exact source slice (engine runs with `withSource: true`) — the only
  // faithful identity for TAUT-001 self-comparison. Falling back to `kind` here made every
  // same-kind operand (`$a` vs `$b`) look identical and produced false self-comparisons.
  if (node.loc?.source) return String(node.loc.source);
  if (node.raw !== undefined) return String(node.raw);
  if (node.value !== undefined && typeof node.value !== 'object') return String(node.value);
  return node.kind ?? '';
}

function nodeLine(node: PhpNode | undefined): number {
  return node?.loc?.start?.line ?? 1;
}

function nodeColumn(node: PhpNode | undefined): number {
  return (node?.loc?.start?.column ?? 0) + 1;
}

function nodeSpan(file: string, node: PhpNode | undefined): SourceSpan {
  return span(
    file,
    nodeLine(node),
    nodeColumn(node),
    node?.loc?.end?.line ?? nodeLine(node),
    (node?.loc?.end?.column ?? nodeColumn(node) - 1) + 1,
  );
}

function walk(root: PhpNode, visit: (node: PhpNode) => void): void {
  const seen = new Set<object>();
  const visitNode = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    const candidate = node as PhpNode;
    if (typeof candidate.kind === 'string') visit(candidate);
    for (const [key, value] of Object.entries(candidate)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'comments') continue;
      if (Array.isArray(value)) value.forEach(visitNode);
      else visitNode(value);
    }
  };
  visitNode(root);
}
