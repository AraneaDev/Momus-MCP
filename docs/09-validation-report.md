# 9. Validation Report — Pre-Implementation Spike

> Status: **COMPLETE** (all experiments green). Date: 2026-08-15.
> This report records the de-risking experiments run **before** writing production code.
> Everything in `experiments/` is a throwaway spike; the findings below are normative inputs
> to the spec (deltas applied to docs 02/03/04/06/07 where marked).

## 9.1 Executive summary

All eight experiments passed. The core bets of the specification are **buildable**:

| # | Hypothesis (from spec) | Verdict |
|---|---|---|
| E1 | TS compiler API extracts symbols/signatures/return types (syntactic + type-aware) | ✅ |
| E2 | `vi.mock`/`vi.fn`/`vi.spyOn`/`vi.mocked` patterns are statically detectable with the planned AST shapes | ✅ |
| E3 | Intra-procedural provenance detects TAUT-002/TAUT-006 while keeping healthy tests quiet | ✅ |
| E4 | TypeChecker verifies DRIFT-001 (member existence), DRIFT-003 (return assignability), DRIFT-005 (factory keys vs exports) | ✅ |
| E5 | Import resolution: relative + tsconfig `paths` aliases + unresolvable → null | ✅ |
| E6 | `php-parser` parses PHPUnit/Mockery patterns, typed classes, namespaces, docblocks | ✅ |
| E7 | Official MCP SDK serves the 5-tool surface with annotations + `structuredContent` over stdio | ✅ |
| E8 | `@momus-ignore` suppression syntax extracts correctly (TS regex contract + PHP docblocks) | ✅ |

**Six design-affecting discoveries** were made (F1–F6 below). None invalidate the architecture;
two require spec changes (TS version pin + custom host pattern; SDK subpath imports), and four
are implementation notes that save the Phase-1 team from re-discovering them.

## 9.2 How to re-run

```bash
cd experiments
npm install            # typescript@^5.9, php-parser, @modelcontextprotocol/sdk, zod, tsx
npm run all            # E1..E8, each exits non-zero on failure
```

Fixture workspace: `experiments/fixtures/ts` (production `ledger.ts`/`db.ts`, test
`ledger.test.ts` with planted TAUT-002/TAUT-006/DRIFT-001 + healthy controls) and
`experiments/fixtures/php` (typed `InvoiceRepository`, PHPUnit test with planted TAUT-003/
DRIFT-001). The shared mini-engine lives in `experiments/spikes/lib/engine.ts`.

## 9.3 Findings (normative)

### F1 — Pin `typescript@^5.9`; TS 7 is not usable programmatically (yet)

`typescript@7.0.2` (the native compiler) exposes **no programmatic API** from ESM: the npm
package's ESM entry exports only `{ default, module.exports, version }`, `module.exports` is
opaque, and `lib/typescript.js` is blocked by the exports map. The stable, documented API is
the 5.x line. **Spec delta:** §6.1 dependency table + §2.2.2 → pin `typescript@^5.9`
(`^5` range), add a tracked migration risk for TS7 (their JS API is still maturing).

### F2 — MCP SDK: use subpath imports; the root entry is broken in the published tarball

`import '@modelcontextprotocol/sdk'` fails on every published version checked (1.12.0, 1.25.3,
1.29.0, 1.30.0): the tarball ships `dist/esm/{client,server,shared,validation,…}` but **never
the root `index.js`/`index.d.ts`** the exports map points at. Working imports:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
```

**Spec delta:** §6.1 → document subpath imports, pin `@modelcontextprotocol/sdk@^1.29` (works
on 1.30.0), note the root-entry packaging bug. `zod` is required for tool schemas (peer dep of
the SDK) — add to the dependency table.

### F3 — `() => ({...})` keeps a ParenthesizedExpression in the TS AST

`vi.mock('x', () => ({ Db: vi.fn() }))` parses the factory body as
`ParenthesizedExpression(ObjectLiteral)`. Factory-key extraction must unwrap. Implementation
note for `parser-typescript` (E2 hit this).

### F4 — `expect(A).toBe(B)`: the operands sit inside a PropertyAccess chain

The inner `expect(A)` call's parent is the `PropertyAccessExpression` (`expect(A).toBe`), not
the matcher call. Assertion walks must traverse PropertyAccess nodes up to the matcher
call (handles `.resolves.toBe` chains too). Implementation note for the rule engine (E3 hit
this; also: only descend to the *nearest* enclosing CallExpression — bounded, so `foo(expect(x))`
is not misread as a matcher call).

### F5 — CRITICAL: `ts.createProgram` files have NO parent pointers — use a custom host

Source files produced by the program's default host are parsed with `setParentNodes: false`,
so `node.parent` is `undefined` everywhere. Any scope/block/assertion analysis that walks up
from a node silently finds nothing (this manifested as "1st call empty, 2nd call full" — a
trap for the unwary, since nothing throws).

**Fix (the typescript-eslint pattern), validated in E7:**
pre-parse every file with `ts.createSourceFile(path, text, target, /*setParentNodes*/ true)`
and hand those instances to the program via a custom `CompilerHost.getSourceFile`. The checker
then resolves types on the same instances.

**Spec delta:** §2.2.2 + §7 Phase 1 → the TS parser MUST build the program over a custom host
with parent-enabled source files; never mix a fresh `createSourceFile` instance with
checker calls (F6).

### F6 — Checker type queries require the program's own SourceFile instance

`checker.getTypeAtLocation(node)` on a node from a *freshly created* `createSourceFile` (same
text, same path) silently degrades to `any` — so `vi.spyOn(service, 'totalForX')` reported
"does not exist on **any**" instead of `LedgerService`. Corollary of F5: parse once, use that
instance for both syntax analysis and checker queries. **Spec delta:** §2.4.2 resolution rule —
single-source-file-instance invariant.

### F7 — Async methods: DRIFT-003 must compare against the promise's resolved type

`LedgerService.totalFor(): Promise<Invoice>` — comparing a stub shape against `Promise<Invoice>`
always fails. The checker provides `checker.getPromisedTypeOfPromise(type)`; DRIFT-003 unwraps
it for async methods (this also confirms the spec's §3.4 rule — now with a concrete API).
**Spec delta:** §3.4 assignability table → add the unwrap API reference.

### F8 — MCP stdio servers must never write to stdout

The server's debug `console.log`s corrupted the stdio transport: the first `tools/call`
response came back truncated/misparsed, the second succeeded. All diagnostics must go to
`stderr` or an injectable logger (default no-op in server mode). **Spec delta:** §4.1 — add a
"transport hygiene" rule: no stdout writes; logging goes to stderr/logger.

### F9 — php-parser actual node shapes (differ from naive expectations)

Validated against `php-parser@3.7.0`:

- No `methodcall` kind: `$obj->method()` parses as `call { what: propertylookup { what: <obj>, offset: <identifier> } }`; the method name is `call.what.offset.name`.
- Class/`Foo::class` targets: `staticlookup { what: name, offset: identifier(class) }`.
- Names are **identifier nodes** (`{kind:'identifier', name:'X'}`), not strings — on classes, methods, parameters.
- Parameter types: `param.type` with kind `typereference`; return types: `method.type` with kind **`name`** (not `typereference`).
- Method bodies are `block` nodes with `children` (not arrays).
- Assignments are `assign` statements inside `expressionstatement`.
- Docblocks attach via `node.leadingComments` when `parser.extractDoc: true` — validated for `/** @momus-ignore */`.
- Chain traversal `$repo->expects(...)->method('fetchAll')` → `['expects', 'method']` via recursive `call.what` descent.

**Spec delta:** §2.5.2 mock catalog → replace "AST trigger" descriptions with these concrete
shapes so Phase 2 implements them directly.

### F10 — MCP SDK supports everything §4 needs

`McpServer.tool()` accepts annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint`, `title`) and returns them in `tools/list`; `structuredContent` round-trips
(including arrays); `isError: true` works for tool execution errors; tool order is stable;
`inputSchema` is generated from zod. Note: `McpServer.tool()` has **no `outputSchema`
parameter** in SDK 1.29/1.30 — `outputSchema` in the spec is aspirational (harmless: clients
validate `structuredContent`; keep it out of the tool registration for now).
**Spec delta:** §4.2 note — `outputSchema` documented but not wired in v1 (SDK gap).

### F11 — Suppression regex contract holds (TS)

All forms from §3.5.1 verified: line-above, trailing, scoped single/multi-rule, docblock,
file-banner, and both negative cases (misspelled directive, space after colon) stay quiet.

## 9.4 Spec deltas applied

| Doc | Change |
|---|---|
| `02-architecture.md` §2.2.2 | Pin `typescript@^5.9`; custom-host pattern with `setParentNodes: true`; single-source-file-instance invariant (F5/F6) |
| `02-architecture.md` §2.2.3 / §2.5.2 | Concrete php-parser node shapes (F9) |
| `03-analysis-algorithms.md` §3.4 | `getPromisedTypeOfPromise` unwrap for async returns (F7) |
| `04-mcp-tool-definitions.md` §4.1 | Transport hygiene rule: no stdout writes (F8); `outputSchema` note (F10) |
| `06-repository-layout.md` §6.1 | SDK subpath imports + version pin + zod (F2); typescript pin + TS7 risk (F1) |
| `07-roadmap.md` Phase 1 | Deliverable: parent-enabled custom host; add SDK subpath imports to scaffold |

## 9.5 Remaining risks (not yet spiked)

| Risk | Why it remains | Suggested spike (Phase 1) |
|---|---|---|
| Large-repo perf (10k+ LOC budgets §2.7) | Spike used a 200-LOC fixture | bench fixture repo; measure program build + incremental |
| `beforeEach`-configured mocks across `describe` scopes | Spike was intra-test-function | extend provenance to describe/beforeEach blocks |
| PHP type resolution across files (FQCN matching for DRIFT-003) | E6 validated syntax only | small cross-file PHP spike |
| Jest automock (`jest.mock('x')` no factory) member checks | Out of scope by design (DRIFT-000) | none needed |
| Mockery closure-form (`Mockery::mock('F', fn($m) => …)`) | Not in spike fixture | add fixture in Phase 2 |

## 9.6 Repo state

- `experiments/` — package.json (`npm run e1..e8`, `npm run all`), `fixtures/`, `spikes/`,
  `spikes/lib/engine.ts`. Throwaway; excluded from the Phase-0 repo skeleton.
- Root `.gitignore` added (node_modules, tsbuildinfo, .momus cache).
- All docs updated per §9.4.
