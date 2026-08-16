# 2. Architecture & Engine Design

> Normative. Defines the parsing strategy, the normalized intermediate representation (IR),
> the symbol index, mock identification logic, module resolution, and configuration.

## 2.1 Pipeline overview

```
 workspace files
      │
      ▼
 ┌─────────────┐   ┌───────────────────┐   ┌─────────────────┐   ┌──────────────┐
 │ File        │──▶│ LanguageParser    │──▶│ ModuleIR        │──▶│ SymbolIndex  │
 │ discovery   │   │ (typescript/php)  │   │ (language-      │   │ (graph)      │
 │ (.gitignore)│   │ AST → IR          │   │  neutral)       │   │              │
 └─────────────┘   └───────────────────┘   └─────────────────┘   └──────┬───────┘
                                                                       │
                          ┌────────────────────────────────────────────┘
                          ▼
                 ┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
                 │ Rule engine     │────▶│ Issue[]      │────▶│ Formatter       │
                 │ (pure functions │     │ (stable,     │     │ (Markdown/JSON, │
                 │  over index+IR) │     │  sorted)     │     │  token-budgeted)│
                 └─────────────────┘     └──────────────┘     └─────────────────┘
```

1. **Discovery** — walk the workspace honoring `.gitignore`, `testFilePatterns`, size caps (§2.7).
2. **Parse** — each file goes through the `LanguageParser` for its extension; the result is a
   language-neutral `ModuleIR` (§2.3).
3. **Index** — production symbols are merged into the `SymbolIndex`; test mocks/assertions are
   resolved against it (§2.4).
4. **Analyze** — rules run as pure functions over (index, test module, config) → `Issue[]` (§3).
5. **Render** — issues are sorted (severity, file, line) and formatted under a strict token budget (§5).

## 2.2 AST parsing strategy

### 2.2.1 Decision: parser per language, unified IR

Momus does **not** use a single universal parser. Each language gets a purpose-built parser
plugin behind one interface (`LanguageParser`), because mock-contract analysis needs **type
information**, which syntax-only parsers (e.g. tree-sitter) do not provide.

### 2.2.2 TypeScript/JavaScript — TypeScript compiler API (Phase 1)

| Choice | Rationale |
|---|---|
| `typescript@^5.9` compiler API (via `ts.createSourceFile` + `ts.TypeChecker`) | Zero extra dependencies; first-class type resolution; already the ecosystem's canonical AST for TS; supports JS/JSX/TSX through the same API. Pin `^5.9`: the `typescript@7` native compiler does not yet expose the programmatic API from ESM (validated — see `09-validation-report.md` F1); migrating to TS7 is a tracked risk. |
| Rejected: tree-sitter + tree-sitter-typescript | Excellent for syntax highlighting and fast pre-filtering, but **no type graph** — impossible to verify "does this stub return a shape assignable to the production return type?" without reimplementing type resolution. |
| Rejected: `@babel/parser` | Great fidelity on JS, but type-aware analysis requires `@babel/plugin-transform-typescript` and still lacks a full type checker. |

**Type-aware mode:** when `tsconfig.json` is present, Momus creates a `ts.Program` over the
workspace's TS files (incremental, `ts.createIncrementalProgram`) and uses `TypeChecker` for
`resolvedId` resolution and assignability questions. When no `tsconfig.json` exists, Momus
degrades gracefully to **syntax-only mode**: `resolvedId` resolution uses textual import
resolution (§2.5), and type-based checks (DRIFT-002/003) are downgraded to arity/name checks
with `severity: "warning"` and a note in the report (`SYS-003`).

**Performance:** the incremental program is kept alive across tool calls within a server
session; per-file `createSourceFile` is used for single-file audits to avoid program rebuilds
(measured: `createSourceFile` for a 1 MB file < 50 ms).

**Implementation constraints (validated by spike — `09-validation-report.md` F5/F6):**

1. **Parent pointers.** The program's default host parses files with `setParentNodes: false`;
   `node.parent` walks (scope/assertion analysis) silently return nothing. The program MUST be
   built over a custom `CompilerHost` whose `getSourceFile` returns pre-parsed files created
   with `ts.createSourceFile(path, text, target, true, /*setParentNodes*/ true)` (the
   typescript-eslint pattern).
2. **Single source-file instance.** `checker.getTypeAtLocation()` on a node from a *different*
   `createSourceFile` instance (same text/path) silently degrades to `any`. Parse once per
   file; use that instance for both syntax analysis and checker queries.

### 2.2.3 PHP — `php-parser` (Phase 2)

| Choice | Rationale |
|---|---|
| `php-parser` (glayzzle) npm package | Pure-JS parser, no PHP runtime dependency — preserves "zero framework boot" and runs anywhere Node runs. Produces a full AST with comments, spans, and namespaced class resolution. |
| Upgrade path: nikic/php-parser via sidecar | If type-fidelity needs outgrow the JS port (e.g. full docblock/attribute typing), a bundled PHP helper invoked over a JSON-lines subprocess protocol is the documented upgrade path. The `LanguageParser` interface makes this a drop-in swap. |

**Validated node shapes (`php-parser@3.7.0`, see `09-validation-report.md` F9):** there is no
`methodcall` kind — `$obj->method()` parses as `call { what: propertylookup { what, offset: identifier } }`
(method name = `call.what.offset.name`); `Foo::class` is `staticlookup { what: name, offset: identifier(class) }`;
names (classes, methods, parameters) are `identifier` nodes, not strings; parameter types are
`typereference`, return types are kind `name` on `method.type`; method bodies are `block` nodes
with `children`; docblocks attach via `node.leadingComments` with `parser.extractDoc: true`.

### 2.2.4 Extension & future languages

New languages are added by implementing `LanguageParser` (§2.3.1) — no core changes. Candidate
ordering (Phase 3+): Rust (`syn` via WASM), Python (`tree-sitter-python` + stubs for types),
Go (`go/ast` via subprocess). Language support is advertised in `serverInfo` and `tools/list`
descriptions, never assumed.

## 2.3 Normalized intermediate representation (IR)

The IR is the contract between parsers and rules. It lives in `packages/core/src/ir.ts`.
All spans are 1-based lines, 1-based columns (UTF-16 code units, matching the MCP convention).

### 2.3.1 Parser plugin interface

```ts
// packages/core/src/parser.ts
export interface LanguageParser {
  readonly language: 'typescript' | 'php';
  /** True if this parser claims the file (by extension and content sniffing). */
  canParse(path: string, source: string): boolean;
  /** Parse a single file into a language-neutral ModuleIR. Never throws for bad code;
   *  syntax errors are captured in `diagnostics`. */
  parseModule(path: string, source: string, ctx: ParseContext): ModuleIR;
  /** Resolve an import/use specifier to an absolute path, or null if unresolvable.
   *  Honors tsconfig paths / composer autoload via ParseContext.resolver. */
  resolveImport(specifier: string, fromFile: string, ctx: ParseContext): string | null;
}

export interface ParseContext {
  config: MomusConfig;
  resolver: ModuleResolver;      // tsconfig paths, node_modules, composer autoload
  typeInfo?: TypeInfoProvider;   // optional type-aware services (TS program)
  cache: ParseCache;             // content-hash keyed
}

export interface ParseDiagnostic {
  severity: 'error' | 'warning';
  span: SourceSpan;
  message: string;
}
```

### 2.3.2 Core IR types

```ts
// packages/core/src/ir.ts
export type Language = 'typescript' | 'php';

export interface SourceSpan {
  file: string;        // absolute path
  startLine: number; startCol: number;   // 1-based
  endLine: number;   endCol: number;     // exclusive
}

export interface ModuleIR {
  path: string;
  language: Language;
  kind: 'test' | 'production';
  framework?: 'vitest' | 'jest' | 'phpunit' | 'pest';
  imports: ImportIR[];
  symbols: SymbolIR[];          // classes, interfaces, functions, consts, types declared here
  mocks: MockIR[];              // test doubles declared/configured here
  assertions: AssertionIR[];    // assertions in this file
  diagnostics: ParseDiagnostic[];
  hash: string;                 // sha256 of file bytes
}

export interface ImportIR {
  specifier: string;            // './invoice-service' | 'InvoiceService' | '\App\Invoice'
  resolvedPath?: string;        // absolute, after resolution
  names: string[];              // imported/aliased local names
  kind: 'value' | 'type' | 'use-class' | 'unknown';
}

export type SymbolKind =
  | 'class' | 'interface' | 'function' | 'method' | 'property'
  | 'type-alias' | 'enum' | 'const' | 'abstract-class';

export interface SymbolIR {
  id: string;                   // `${modulePath}#${name}` (methods: `${parentId}.${name}`)
  name: string;
  kind: SymbolKind;
  span: SourceSpan;
  fqcn?: string;                // PHP fully-qualified name
  members: SymbolIR[];          // for class/interface: methods + properties
  extendsIds: string[];         // resolved symbol ids
  implementsIds: string[];
  signature?: SignatureIR;      // functions and methods
  visibility?: 'public' | 'protected' | 'private';
  isStatic?: boolean;
  isAbstract?: boolean;
  isReadonly?: boolean;
}

export interface SignatureIR {
  parameters: ParamIR[];
  returnType?: TypeIR;
  typeParams: string[];
}

export interface ParamIR {
  name: string;
  type?: TypeIR;
  optional: boolean;
  variadic: boolean;
  hasDefault: boolean;
  defaultLiteral?: string | number | boolean | null;  // when statically known
  byRef?: boolean;             // PHP
  promoted?: boolean;          // PHP constructor promotion
}

export type TypeIR =
  | { kind: 'named'; name: string; resolvedId?: string; typeArgs: TypeIR[] }
  | { kind: 'union'; members: TypeIR[] }
  | { kind: 'intersection'; members: TypeIR[] }
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'array'; element?: TypeIR }
  | { kind: 'tuple'; elements: TypeIR[] }
  | { kind: 'function'; params: ParamIR[]; returnType?: TypeIR }
  | { kind: 'unknown' }        // any | mixed | untyped
  | { kind: 'void' | 'never' | 'null' | 'undefined' };
```

### 2.3.3 Mocks & assertions IR

```ts
export type MockFramework = 'vitest' | 'jest' | 'phpunit' | 'pest' | 'manual';

export type MockPattern =
  | 'vi.mock' | 'jest.mock' | 'vi.spyOn' | 'jest.spyOn' | 'vi.fn' | 'jest.fn'
  | 'vi.mocked' | 'vi.importMock' | 'jest.requireMock' | 'jest.createMockFromModule'
  | 'vi.stubGlobal' | 'createMock' | 'createStub' | 'createConfiguredMock'
  | 'createPartialMock' | 'getMockBuilder' | 'getMockForAbstractClass'
  | 'mockery' | 'pest-mock' | 'proxy' | 'object-literal' | 'anonymous-class' | 'unknown';

export interface MockIR {
  id: string;                   // `${file}#mock:${startLine}:${startCol}`
  span: SourceSpan;
  framework: MockFramework;
  pattern: MockPattern;
  /** Resolved production target, when statically resolvable (§2.4.2). */
  target?: MockTarget;
  /** Member-level stubs declared on this mock (spyOn targets, shouldReceive chains, …). */
  stubbedMembers: StubbedMemberIR[];
  /** Value registrations (mockReturnValue / willReturn / configured factory returns). */
  configuredValues: ConfiguredValueIR[];
  /** Call sites of the mock/spy inside the same test file. */
  invocationSites: SourceSpan[];
  isAutomock: boolean;          // vi.mock('x') with no factory
}

export interface MockTarget {
  kind: 'module' | 'class' | 'instance-member' | 'global' | 'unknown';
  modulePath?: string;          // resolved module being mocked (vi.mock('./x'))
  exportName?: string;          // named export (vi.mock factory keys, spyOn target)
  symbolId?: string;            // resolved class/interface (createMock(InvoiceService::class))
  memberName?: string;          // for instance-member (spyOn(service, 'save'))
  specifier?: string;           // raw text as written
  span: SourceSpan;
}

export interface StubbedMemberIR {
  name: string;
  span: SourceSpan;
  signature?: SignatureIR;      // arity/types as declared on the stub (when derivable)
  returnValues: ConfiguredValueIR[];
  api: 'spyOn' | 'shouldReceive' | 'mockFactoryKey' | 'objectLiteralKey' | 'overrideMethod' | 'unknown';
}

export interface ConfiguredValueIR {
  span: SourceSpan;
  api:
    | 'mockReturnValue' | 'mockResolvedValue' | 'mockRejectedValue'
    | 'mockImplementation' | 'mockReturnValueOnce' | 'mockResolvedValueOnce'
    | 'willReturn' | 'willReturnCallback' | 'andReturn' | 'andReturnUsing'
    | 'andThrow' | 'andThrowException' | 'shouldReceive'
    | 'factory-return'            // vi.mock factory object member
    | 'literal';                  // createConfiguredMock / plain object value
  value?: TypeIR;                 // statically-derived shape of configured value
  once: boolean;
  throws?: boolean;
}

export interface AssertionIR {
  id: string;                   // `${file}#assert:${startLine}:${startCol}`
  span: SourceSpan;
  api: string;                  // 'toBe' | 'toEqual' | 'assertSame' | 'toHaveBeenCalledWith' | …
  operands: ExprIR[];           // both sides of the assertion, left first
  dataFlow: DataFlowIR;         // provenance of each operand (§3.2)
}

export interface ExprIR {
  kind: 'identifier' | 'call' | 'member' | 'new' | 'literal' | 'template' | 'unknown';
  name?: string;                // identifier / member name
  callee?: ExprIR;
  args?: ExprIR[];
  resolvesTo: string[];         // resolved symbol ids (empty when unresolvable)
  mockRefs: string[];           // mock ids this expression provably flows from
  constant: boolean;            // statically constant (literals, pure literals)
}

export interface DataFlowIR {
  /** Per operand index: the provenance sources it flows from. */
  perOperand: { sources: SourceKind[]; constant: boolean }[];
}

export type SourceKind =
  | 'mock-config'     // flows from a mockReturnValue/willReturn registration
  | 'mock-call'       // flows from invoking a mock (unconfigured or dynamically)
  | 'production'      // flows from production code (imported SUT calls)
  | 'literal'         // compile-time constant
  | 'parameter'       // test parameter / fixture input
  | 'unknown';
```

**IR invariants:**

1. `SourceSpan.file` is always absolute; all paths in output are workspace-relative (§5).
2. Every `ExprIR.mockRefs` entry references a `MockIR.id` that exists in the same module's
   `mocks` array.
3. Rules never see raw parser ASTs — only IR. Adding a language never changes rule code.
4. `ModuleIR.hash` is the sha256 of raw file bytes; the parse cache is keyed on it.

### 2.3.4 Concrete AST traversal examples

**Example A — Vitest module mock (TypeScript):**

```ts
// src/services/ledger.ts                          (production)
export interface Invoice { id: string; totalCents: number }
export class LedgerService {
  constructor(private db: Db) {}
  async totalFor(invoiceId: string): Promise<Invoice> { /* … */ }
}

// tests/ledger.test.ts                            (test)
import { LedgerService } from '../src/services/ledger';
vi.mock('../src/services/db', () => ({ Db: vi.fn(() => ({ query: vi.fn() })) }));
const dbMock = vi.mocked(new Db());
const service = new LedgerService(dbMock as unknown as Db);
await expect(service.totalFor('inv-1')).resolves.toEqual({ id: 'inv-1', totalCents: 4200 });
```

Traversal (TS API → IR) for the `vi.mock` call:

```
CallExpression(vi.mock)
├─ args[0]: StringLiteral "../src/services/db"
│    → ImportIR.specifier → resolveImport → MockIR.target = { kind:'module', modulePath:'/abs/src/services/db.ts' }
├─ args[1]: ArrowFunction (factory)
│    └─ ObjectLiteral → per key:
│         'Db' → StubbedMemberIR{ name:'Db', api:'mockFactoryKey',
│                    signature:{ parameters:[], returnType: TypeIR('function', params:[], returnType:'unknown') } }
│         value: CallExpression(vi.fn) → new MockIR{ pattern:'vi.fn', target:{kind:'instance-member'} }
```

The factory keys `{ Db, … }` are compared against the *resolved* exports of
`/abs/src/services/db.ts` by DRIFT-005. Because the factory's `Db` returns an object whose
`query` is itself a `vi.fn`, DRIFT-001 checks `query` against the real `Db.query` signature.

**Example B — PHPUnit configured mock (PHP):**

```php
// src/InvoiceRepository.php
class InvoiceRepository {
    public function findById(int $id): Invoice { /* … */ }
}

// tests/InvoiceTest.php
final class InvoiceTest extends TestCase {
    public function testTotal(): void {
        $repo = $this->createMock(InvoiceRepository::class);
        $repo->method('findById')->willReturn(new Invoice(1, 4200));
        $invoice = (new InvoiceService($repo))->total(1);
        self::assertSame(4200, $invoice->totalCents);
    }
}
```

Traversal (`php-parser` → IR):

```
MethodCall(createMock)
├─ arg: ClassConstFetch(InvoiceRepository::class)
│    → fqcn 'InvoiceRepository' → SymbolIndex lookup → MockIR.target = { kind:'class', symbolId:'/abs/src/InvoiceRepository.php#InvoiceRepository' }
├─ chained: MethodCall(method) arg 'findById' → StubbedMemberIR{ name:'findById', api:'shouldReceive' }
│    └─ chained: MethodCall(willReturn) arg New(Invoice, [1, 4200])
│         → ConfiguredValueIR{ api:'willReturn', value: TypeIR('named','Invoice', typeArgs:[]) }
```

DRIFT-001 checks `findById` exists on the resolved class; DRIFT-002 compares arity (1 int param);
DRIFT-003 checks `new Invoice(1, 4200)` is assignable to the production `findById` return type
`Invoice`. TAUT-002 flags `assertSame(4200, $invoice->totalCents)` **only if** `totalCents`
flows from the configured mock — here it does not (it flows through `InvoiceService`), so no
finding: this is a *healthy* test and must stay quiet (clean-corpus guarantee).

## 2.4 Symbol index & graph

### 2.4.1 Node & edge model

The `SymbolIndex` is an in-memory directed graph:

```
Node kinds:  ModuleNode, SymbolNode (per SymbolIR), MockNode (per MockIR, test files only)
Edge kinds:  IMPORTS(module→module)   EXTENDS(symbol→symbol)   IMPLEMENTS(symbol→symbol)
             MOCKS(mock→module|symbol)  CALLS(module→module)   DECLARES(module→symbol)
             INSTANTIATES(test→symbol)  ASSERTS(test→symbol)
```

```ts
// packages/core/src/index.ts
export interface SymbolIndex {
  modules: Map<string, ModuleNode>;          // key: absolute path
  symbols: Map<string, SymbolNode>;          // key: symbol id
  mocks: Map<string, MockNode>;              // key: mock id
  resolveSymbol(name: string, fromModule: string): SymbolNode | undefined;
  resolveModule(specifier: string, fromFile: string): ModuleNode | undefined;
  /** Symbols whose definitions changed since `baseRef` (git-diff mode). */
  changedSince(baseRef: string): Set<string>;
  /** Incremental update for one file; returns the set of affected symbol ids. */
  updateFile(path: string, module: ModuleIR): Set<string>;
}
```

### 2.4.2 Resolution rules (normative)

1. **Module resolution (TS):** try, in order — relative specifier against `fromFile` with
   extensions `[.ts, .tsx, .js, .jsx, .mjs, .cts, .mts, .d.ts]` and `/index.*`; `tsconfig.json`
   `paths` + `baseUrl`; `node_modules` via standard resolution. Unresolved ⇒ `target` keeps
   `specifier` and `kind: 'unknown'`; rules emit `info`-level notes only (never `error`).
2. **Class resolution (PHP):** `use` statements map short names → FQCN; same-namespace classes
   resolve without `use`; `Foo::class` strings are matched against the index's `fqcn`.
3. **Member resolution:** `spyOn(obj, 'save')` resolves the type of `obj`'s expression
   (type-aware: TS checker; syntax-only: textual constructor/assignment back-reference).
   Unresolvable ⇒ DRIFT-001/002/003 are skipped for that stub with an `info` note (`DRIFT-000`).
4. **Resolution failures never crash** — they degrade the analysis and are reported via
   `SYS-001` (parse error) / `SYS-003` (unresolved import) diagnostics.

### 2.4.3 Persistence & incremental updates

- **In-memory** is the source of truth for a session (server or one CLI invocation).
- **Persistent cache** (`.momus/cache/`): SQLite via `better-sqlite3`, keyed by file content
  hash **plus a workspace digest** (over every source file + tsconfig/composer); stores
  `ModuleIR` serialized as JSON. Warm start of an unchanged workspace reads IR from cache
  instead of re-parsing (measured target: 100k LOC warm < 1 s). Any source/config change flips
  the digest and forces a reparse, so the cache is advisory-only and never breaks determinism.
- **Watcher** (`chokidar`, shipped) in server mode (`momus serve --watch`) invalidates the
  memoized `ts.Program` cache on save/delete, so the next tool call reflects on-disk edits
  without a restart.
- **Determinism contract:** results must be identical whether computed cold or warm; cache is
  never the source of truth for correctness, only for speed.

## 2.5 Mock identification logic

### 2.5.1 Detection catalog (Phase 1 — TS/JS)

| Pattern | AST trigger | Produces |
|---|---|---|
| `vi.mock('mod', factory)` | CallExpression `vi.mock` | `MockIR{pattern:'vi.mock', target:module}` + per-factory-key `StubbedMemberIR` + nested `vi.fn` mocks |
| `vi.mock('mod')` | same, no factory | `MockIR{isAutomock:true}` |
| `jest.mock('mod'[, factory])` | `jest.mock` / destructured `mock()` | as above |
| `vi.spyOn(obj,'m')` / `jest.spyOn` | `vi.spyOn`/`jest.spyOn` | `MockIR{pattern:'vi.spyOn', target:{kind:'instance-member'}}` + `StubbedMemberIR{m}'` |
| `vi.fn(impl?)` / `jest.fn(impl?)` | `vi.fn` / `jest.fn` call | `MockIR{pattern:'vi.fn'}`; chained `.mockReturnValue*`/`.mockImplementation` become `ConfiguredValueIR` |
| `vi.mocked(x)` | `vi.mocked` | **not** a mock — a typing cast; attaches resolved type to `x` for member checks |
| `vi.importMock('mod')` / `jest.requireMock` | call | `MockIR{isAutomock:true, target:module}` |
| `vi.stubGlobal('name', v)` | `vi.stubGlobal` | `MockIR{pattern:'vi.stubGlobal', target:{kind:'global'}}` |
| `jest.createMockFromModule('mod')` | call | automock module mock |
| Object-literal double: `{ save: vi.fn() } as unknown as T` | object literal cast whose key values include `vi.fn` | `MockIR{pattern:'object-literal'}` + member stubs |
| `Proxy`-based double: `new Proxy({...}, handler) as T` | `new Proxy` with a `get` handler returning `vi.fn` | `MockIR{pattern:'proxy'}` |

### 2.5.2 Detection catalog (Phase 2 — PHP)

| Pattern | AST trigger | Produces |
|---|---|---|
| `$this->createMock(Foo::class)` / `static::createMock` / `$this->createStub` (incl. `$this->prop = …` in `setUp`) | method call | `MockIR{pattern:'createMock', target:{kind:'class'}}` (property form binds class-scoped as `this:prop`) |
| `$this->createConfiguredMock(Foo::class, ['m' => $v])` | method call | mock + `StubbedMemberIR` + `ConfiguredValueIR{api:'literal'}` per array key |
| `$this->createPartialMock(Foo::class, ['m'])` | method call | mock with only-methods list (used for DRIFT-001: named methods must exist) |
| `$this->getMockBuilder(Foo::class)->onlyMethods([...])->getMock()` | method chain | mock + members |
| `$this->getMockForAbstractClass(AbstractFoo::class)` | method call | mock targeting abstract class |
| `Mockery::mock(Foo::class)` / `Mockery::spy(...)` | static call | `MockIR{pattern:'mockery'}` |
| `->shouldReceive('m')->andReturn($v)` | chained method calls | `StubbedMemberIR` + `ConfiguredValueIR{api:'shouldReceive'}` |
| Pest `mock(Foo::class)` / `spy(Foo::class)` / `$this->mock()` | function/method call inside `test()`/`it()` | `MockIR{pattern:'pest-mock'}` |
| Anonymous class: `new class extends Foo { public function m() {...} }` | anonymous class with parent | `MockIR{pattern:'anonymous-class'}` + override members |
| `Mockery::mock('Foo', fn($m) => $m->shouldReceive(...))` | closure form | as above |

Traversal notes (validated, `09-validation-report.md` F9): PHP call chains are `call`/`propertylookup`
nodes (`$repo->method('findById')->willReturn($v)` = nested `call{what: propertylookup{what: <inner call>}}`);
recursively descending `call.what` yields the chain `['method', 'willReturn']`. Mock targets are
`staticlookup` nodes → `what.name` gives the class short name, resolved through `use` statements.

### 2.5.3 Negative rules (what is NOT a mock)

- `vi.fn()` used as a **callback argument** (e.g. `arr.map(vi.fn())`) without assignment or
  assertion is recorded as `pattern:'vi.fn'` but flagged `info` only if it participates in an
  assertion (TAUT-006) — never as drift.
- Plain object literals with no `vi.fn`/`jest.fn`/`shouldReceive` values are **not** mocks
  (they may be fixtures). `synthesize_mock_contract` output, however, is always typed.
- `expect.any()`, `expect.objectContaining()` matchers are assertion metadata, not mocks.

## 2.6 Configuration — `.momusrc`

Loaded from workspace root (or `--config`). JSON or JSONC. Schema published at
`schemas/momusrc.schema.json` (draft 2020-12).

```jsonc
{
  "$schema": "./schemas/momusrc.schema.json",
  "languages": { "typescript": { "enabled": true }, "php": { "enabled": false } },
  "testFilePatterns": ["**/*.{test,spec}.{ts,tsx,js,jsx,mjs}", "**/__tests__/**"],
  "rules": {
    "TAUT-002": "error",        // severity override
    "MOCK-001": "off",          // disable
    "DRIFT-003": { "severity": "warning", "options": { "strictArrays": false } }
  },
  "mockSaturationThreshold": 0.7,
  "ignorePatterns": ["**/__fixtures__/**", "**/generated/**"],
  "suppressions": [
    { "rule": "DRIFT-001", "files": ["tests/legacy/*.test.ts"] },
    { "reason": "third-party SDK, not ours to fix", "files": ["tests/vendor-bridge.test.ts"] }
  ],
  "tokenBudget": { "maxIssuesPerReport": 50, "maxIssueLineTokens": 100, "verbosity": "issues" },
  "cache": { "dir": ".momus/cache", "enabled": true },
  "maxFileSizeBytes": 2097152,
  "maxIndexedLines": 500000
}
```

Precedence: **inline suppression comment > config `suppressions` > rule severity config >
rule default** (§3.5 of `03-analysis-algorithms.md`).

## 2.7 Performance budgets (normative)

| Operation | Budget |
|---|---|
| Parse single file ≤ 1 MB | < 50 ms (TS API `createSourceFile`) |
| Index 10k LOC (cold) | < 1 s |
| Index 100k LOC (warm, cache hit) | < 1 s |
| Incremental update on file save | < 100 ms |
| `audit_test_fidelity` single file | < 200 ms |
| `verify_mock_drift` workspace (100k LOC) | < 2 s |
| Peak memory at 100k LOC | < 200 MB |
| MCP `tools/list` serialized size | < 4 KB (fits one prompt context page) |

Exceeding budgets degrades to `info` diagnostics (`SYS-004`), never crashes.

## 2.8 Error taxonomy

| Code | Meaning | Severity |
|---|---|---|
| `SYS-001` | Parse error in file (syntax) | error (diagnostic, not issue) |
| `SYS-002` | File/workspace over size caps, skipped | info |
| `SYS-003` | Unresolvable import/type — type-aware checks downgraded | info |
| `SYS-004` | Performance budget exceeded, degraded mode | info |
| `SYS-005` | Configuration error (bad `.momusrc`) — tool returns error result | n/a |

System diagnostics never count toward "issues found" for exit-code purposes, but they are
surfaced in every report so agents know analysis was degraded.

---

**Next:** [`03-analysis-algorithms.md`](./03-analysis-algorithms.md) — the rule engine and core algorithms.
