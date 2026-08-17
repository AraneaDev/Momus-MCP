# Momus-MCP — Real-World Validation Findings

> **Live report.** Updated as we validate Momus against two real, independent AraneaDev
> repositories plus Momus itself (dogfooding). This is the honest record of (a) what Momus
> reports about those codebases and (b) the bugs we found in Momus while doing so.
> Non-normative (see `docs/README`).

**Last updated:** 2026-08-17

## 1. Targets

| Repo | Language | Scale | Test stack | Momus config used |
|---|---|---|---|---|
| `/root/Chaos-MCP` | TypeScript (ESM, NodeNext) | 320 files, 97 test files | Vitest (`vi.*`), Stryker mutation testing | default TS |
| `/root/Knossos-MCP` | PHP ≥ 8.3 | 154 src + 221 test files | PHPUnit 12, Infection | `.momusrc` → `{languages:{php:true}}` (temp) |
| `Momus-MCP` (self) | TypeScript + PHP | 59 audited files | Vitest | `.momusrc` (fixtures excluded) |
| `psf/requests` (dogfood clone at `/tmp/requests-dogfood`) | Python | 35 files, 13 test files | pytest + unittest.mock (live test server) | temp `.momusrc` → `{languages:{python:true}}` |
| `asomers/mockall` (dogfood clone at `/tmp/mockall-dogfood`) | Rust | 188 `.rs` files, 172 under `tests/` | mockall's own `#[automock]`/`mock!` + `#[test]`/`#[cfg(test)]` | temp `.momusrc` → `{languages:{rust:true}}` |

## 2. Bugs found in Momus (and fixed)

| # | Commit | Bug | Symptom on real code |
|---|---|---|---|
| 1 | `33b9847` | CLI space-separated flag values leaked into positional paths | `momus audit --max-issues 50` treated `50` as a path |
| 2 | `33b9847` | DRIFT-005 checked symbol-only exports, not all named exports | false `missing-export` for `const`/`type`/`enum` exports (`TOOL_DEFINITION` etc.) |
| 3 | `33b9847` | `extractSymbols` ignored barrel re-exports | `export { X } from '...'` names treated as missing |
| 4 | `33b9847` | IR cache not invalidated by tool version | stale cached IR served after a parser change |
| 5 | `0504b57` | TS contract synthesis always emitted `undefined` | useless `mockReturnValue(undefined)` |
| 6 | `1620215` | `momus drift` (and precommit/hook) didn't recompute summary | drift-only scan printed full-audit counts + wrong `CLEAN` |
| 7 | `1620215` | TS synthesis used `mockReturnValue(Promise.resolve(...))` | wrong async semantics |
| 8 | `f08bec6` | PHP `valueText()` fell back to AST node `kind` | **50 false TAUT-001 "self-comparison" errors** on Knossos |
| 9 | *(this round)* | TS `instanceIds` was a flat name→id map, so a name reused across test scopes (`mockRun`) resolved every use to the **last** binding | 82 false TAUT-005 on Chaos-MCP `handler.test.ts` |
| 10 | *(this round)* | Chained-config initializers (`const f = vi.fn().mockReturnValue(1)`) and inline `vi.fn().mockXxx(...)` inside object/array literals were never marked reachable | more false TAUT-005 (see #9's fix — folded into the same change) |
| 11 | *(this round)* | `momus contract` on PHP reimplemented TS-only synthesis, ignoring `--framework phpunit` | emitted `satisfies Partial<...>` garbage for a PHP class |
| 12 | *(this round)* | Default `ignorePatterns` omitted `**/vendor/**` (Composer deps) | Knossos audit scanned 3,808 files incl. 3,915 vendor `.php` files (70s) instead of 403 files (8.5s) |
| 13 | *(this round)* | `productionCalls` missed a SUT assigned in `beforeEach`, local helpers wrapping the SUT, and `it.each` parameterized tests | 21 false TAUT-004 "mock-only-assertion" on Chaos-MCP |
| 14 | *(this round)* | PHP mocks handed to production via `new Foo($mock)`, passed as a call argument, or returned from a `willReturnCallback` closure were never marked reachable | 5 false TAUT-005 "zero-reach" on Knossos-MCP |
| 15 | *(this round)* | `productionCalls` did not count dynamic `import()` as executing production code | 1 false TAUT-004 on Chaos-MCP `sandbox.test.ts` (signal-handler re-import pattern) |
| 16 | *(dogfood)* | `synthesize_mock_contract` synthesized `{ length: 0 }` for string-literal union aliases (`Language`/`MockFramework`/`SymbolKind`) because `getPropertiesOfType` returns the primitive `String`'s intrinsic `length` | garbage mock contracts for Momus's own `ModuleIR`/`SymbolIR` |
| 17 | *(dogfood)* | inline type literals (`{ lang: Language }`) recursed through the non-checker `tsReturnExample`, so named union members emitted `undefined` | `{ lang: undefined, sev: undefined }` for a union-field return |
| 18 | *(dogfood)* | generic methods (`identity<T>(x: T): T`) emitted `vi.fn<[x: T], T>()` — an out-of-scope `T` (invalid TypeScript) | broken mock contract for generic methods |
| 19 | *(dogfood)* | generic classes (`Box<T>`) emitted `vi.fn<[], T>()` + `Partial<Box>` (missing type arg) | invalid TypeScript for generic classes |
| 20 | *(dogfood)* | `synthesize_mock_contract` returned `no class found` for interface targets, despite the documented "class/interface" contract | interface-only files were unmockable |
| 21 | *(coverage pass)* | `tsReturnExample`'s union nullish-exclusion missed `null` parsed as a `LiteralType` (not `NullKeyword`) | `null \| undefined` synthesized as `'null'` instead of `'undefined'` |
| 22 | *(coverage pass)* | `gitChangedPaths` returned **toplevel**-relative paths when `root` was a subdirectory of the repo | diff scoping silently no-oped for subdir roots (paths never matched module paths) |
| 23 | *(open items)* | PHP `willThrowException` was recognized for reachability but its exception value never reached the IR | throw-configured mocks couldn't be inspected; open improvement §5.1 — now recorded (mock-level config, deliberately not a return value so DRIFT-003 never compares an exception against the production return type) |
| 24 | *(open items)* | `synthesize_mock_contract` emitted `undefined` for `Record<K, V>` / `NodeJS.ProcessEnv` index-signature types (no named properties in `getPropertiesOfType`) | `{}` is the type-correct placeholder; index-signature detection added to both the syntax-only and checker paths |
| 25 | *(open items)* | synthesized contracts emitted bare `(x)` for unannotated parameters | `paramTypeText` now infers `number`/`string`/`boolean`/`unknown[]`/`Record<string, unknown>` from the default initializer; `unknown` only when no signal exists |
| 26 | *(coverage pass)* | PHPDoc `@return array<int, Invoice>` (generics containing spaces) was truncated to `array<int,` — the first-whitespace token split | wrong TypeIR (`named: 'array<int,'` instead of `array` of `Invoice`); `docTypeFromRest` now consumes tokens until a `$` or a description word |
| 27 | *(dogfood/coverage)* | TS DRIFT-003 was dead for `vi.spyOn` configs: spy-bound configs (`const spy = vi.spyOn(x, 'm'); spy.mockReturnValue(v)`) were attached at mock level only, then **wiped** when the instance-mock pass rebuilt `configuredValues` from member return values — the assigned value never reached the checker | `spy.mockReturnValue('nope')` on a `number`-returning method was silent; now the spyOn assignability pass computes DRIFT-003 (fixture: planted `'nope'` fires, healthy `42` quiet) |
| 28 | *(dogfood/coverage)* | `collectAssignedConfigs` resolved config owners through the **flat** `instanceIds` map, so a name reused across test scopes (`spy`) attached configs to the last binding | wrong-mock config attachment; now position-aware (`resolveInstance` nearest-binding) |
| 29 | *(dogfood/coverage)* | `literalShape` didn't unwrap casts, so `mockReturnValue('x' as T)` yielded no value | `'x' as unknown as number` produced `value: undefined`; casts/parens now unwrap |
| 30 | *(dogfood)* | `momus hook --install --root DIR` (and every non-`serve` command) ignored `--root` — `main` used `process.cwd()` | the hook installer wrote `.git/hooks/pre-commit` into the **wrong repo**; `--root` is now honored by every command |
| 31 | *(dogfood)* | `mockRejectedValue`/`mockRejectedValueOnce` configs were checked against the production return type — but a rejection **reason** is not a resolved value | `spy.mockRejectedValue(new Error('boom'))` on a `Promise<string>` method false-flagged DRIFT-003; rejection configs are now skipped in assignability |
| 32 | *(coverage pass)* | DRIFT-002's `typeAssignable` checked target-union **before** source-union, so a stub param typed `string\|number` could not accept a production `string\|number` param | identical union types falsely flagged as signature-mismatch; source unions now recurse first (each source member must be accepted by the target) |
| 33 | *(refactor)* | CLI `main()` was one giant switch: commands weren't unit-testable without spawning a subprocess (CLI entrypoint coverage 19.4%) | extracted exported per-command functions (`runAudit`/`runDrift`/`runPrecommit`/`runHook`/`runContract`/`runRules`/`runServe`/`runInit`/`runDoctor`/`runAnnotate`/`runAnnotatePr`) + thin mapper; 2 direct tests, CLI stmts 19.4→37.8% |
| 34 | *(coverage pass)* | coverage gaps in `markdown.ts` pluralization, `symbolIndex.ts` dedupe/inheritance/resolveByName, and the PHP `phpReturnAssignable` tree were uncovered | new unit tests took markdown.ts + symbolIndex.ts to 100% stmts/branches and covered every PHP DRIFT-003 branch (mixed/void/null/union/class-resolution) |
| 35 | *(coverage pass)* | `SYS-004` (perf budget §2.7) was declared in the IR taxonomy but **never emitted** — the spec's "degrades to info, never crashes" contract was unexercised | a per-file parse-time budget (`parseBudgetMs`, default 2s) now emits a SYS-004 info diagnostic; deterministic busy-wait-parser tests cover the fires + quiet paths |
| 36 | *(coverage pass)* | `dataflow.ts` block-bodied `mockImplementation` returns (`{ return 42; }`, `function () {}`) fell back to raw source text; the `extractCommentsForModule` wrapper was dead code | literal extraction now walks block bodies (arrow + function-expression), non-literal blocks keep full text; dead wrapper removed; `typeAssignable`/`phpReturnAssignable` named-primitive + void/literal fallthrough branches covered |
| 37 | *(process)* | lint + format:check were scripts but not wired into CI | `ci.yml` test job now runs both gates after the test step |
| 38 | *(coverage pass)* | `phpValue` classified `new X()` as a **literal** (`constant: true`), so a fresh-object comparison (`assertNotSame(new Engine(), $engine)`) could be read as a self-comparison by TAUT-001 | `new` expressions now skip the literal path and classify via `exprKind` → `'new'` (re-evaluating, never constant); regression test pins the classification |
| 39 | *(coverage pass)* | CLI `main` wasn't exported, so help/unknown-command/`init`/`doctor` dispatch cases (lines 602-634) were subprocess-only (37.8% stmts) | `main` exported; direct tests cover help variants, unknown-command exit 2 + stderr hint, `init` via `main`, and `doctor` incl. broken-config tolerance — entrypoint 37.8% → 46.3% |
| 40 | *(coverage pass)* | PHP parser edge branches uncovered: variable class target (`createMock($className)`), foreign-property assignment, dynamic member name, `new` operand | new `EdgeCasesTest.php` fixture + tests cover all four conservatively (variable target binds its members; foreign property never becomes a `this:` mock; dynamic member not bound; `new` classified re-evaluating) — parser-php 79.4% → 80.8% branches |
| 41 | *(perf budget)* | §2.7 `MCP tools/list < 4 KB` budget was asserted nowhere | MCP integration test serializes the live `ListToolsResult` and asserts < 4096 bytes |
| 42 | *(dogfood, Chaos)* | `importOriginal` partial-mock factories (`vi.mock('mod', async (io) => { const a = await io(); return { ...a, key: vi.fn() }; })`) extracted **zero** factory keys — only expression-bodied factories were scanned | block-bodied factories are now scanned via `findReturnedObjectLiteral` (first object-literal return wins; `...actual` spread preserved as non-stub) — the stubbed exports (`readdirSync`, `runShellCommand`, …) become real members for DRIFT-005/TAUT; Chaos re-audit unchanged, no false positives |
| 43 | *(coverage pass)* | `phpReturnExample`/`renderPhpType` union, intersection, and callable return branches in the PHP synth path were uncovered | `DocblockTypes.php` gains `either()` (`int|string` → `andReturn(0)`), `both()` (`CollabA&CollabB` → `null`), `factory()` (`callable(): int` → `null`); MCP test asserts all three renderings |
| 44 | *(dogfood, git-diff on temp Chaos clone)* | module-target mocks (`vi.mock` factories) have no `symbolId`, and `diffRelevant` required one — in precommit/`--git-diff` mode they were **silently out of scope**: a renamed export left the factory key dangling and `momus precommit` reported CLEAN (exit 0) while a plain audit fired DRIFT-005 | `diffRelevant` now resolves module-target mocks via their changed `modulePath`; DRIFT-006 gained a module-target branch (module file changed + mock file untouched → stale, message lists module basename + exports, budget-fitted). Planted rename on the temp clone fires DRIFT-005 errors + DRIFT-006 warnings with exit 1; healthy twin clears. Rule-level + CLI e2e regression tests |
| 45 | *(dogfood, MCP git-diff on temp Knossos clone)* | PHP class-target mocks in the MCP `verify_mock_drift` git-diff scope had no regression coverage | planted `client()` → `clientRenamed()` fired 8 DRIFT-001 + 11 DRIFT-006 via the MCP tool; healthy twin → 0. New PHP git-diff MCP integration test (`.momusrc` php:true fixture repo) pins the path |
| 46 | *(Jest probe)* | `jest.doMock('mod', factory)` — Jest's one-off module mock with identical factory semantics — was invisible (only its inner `jest.fn` was extracted) | matched as its own `jest.doMock` pattern with `mockFactoryKey` members; `MockPattern` union extended; regression test pins factory-key extraction |
| 47 | *(Jest probe, 2nd pass)* | `jest.genMockFromModule` (deprecated alias of `jest.createMockFromModule`) was invisible | now matched as an automock pattern; `jest.unmock`/`requireActual`/`isolateModules`/`replaceProperty` verified as correctly-non-mocks by probe |
| 48 | *(perf budget)* | §2.7 time/memory budgets were asserted nowhere; the workspace-time budget was documented-only | `packages/core/test/perf.test.ts` generates a 100k-LOC PHP workspace and asserts 15s/500 MB ceilings (normative 2s/200 MB; probe measured 169ms/45 MB) + correct findings at scale; a lazy `require('@momus/parser-php')` in the test initially tanked coverage (91.6→85%) via a second module-graph copy — top-level import fixes it |
| 49 | *(dogfood, Chaos `--max-issues 0`)* | the markdown header printed the **shown** (post-truncation) counts while `CLEAN:` used the totals — so `momus audit . --max-issues 0` on a repo with findings printed `0 issues … CLEAN:false … more issues omitted`, a self-contradictory headline that masks findings for a human reader | header now prints the pre-truncation **totals** (`totalIssues`/`totalErrors`/`totalWarnings`/`totalInfos`), consistent with `CLEAN:` and the exit code; regression test pins `4 issues … CLEAN:false` for a fully-truncated run |
| 50 | *(mutation testing, glob)* | `matchGlob` normalized backslashes in the **pattern** only, never the **path** — the old "normalizes windows separators" test passed by accident (backslashes are just non-slash chars, so `**` swallowed them whole), so `matchGlob('src/a.ts', 'src\\a.ts')` returned `false` | `matchGlob` now normalizes both sides; regression tests cover path + pattern normalization (found by a Stryker `StringLiteral` survivor on the `pattern.replace(/\\/g, '/')` line) |
| 51 | *(dogfood, requests)* | Python assertion extraction was **quadratic**: `enclosingFunctionStart` walked the whole tree on every operand lookup (every assertion operand and call argument re-walked the tree) | `test_requests.py` (3,094 lines, 353 assertions) parsed in 12.2s — SYS-004 over the 2s budget; whole-workspace audit 15.4s. A line→scope map is now precomputed once per file (one walk → O(1) lookups): single-file parse 146ms, cold workspace audit 0.9s; regression test pins a 300-fn/600-assert suite under 5s |
| 52 | *(dogfood, mockall)* | Rust mock `invocationSites` were **never populated**, so every `expect_*().returning()` config read as zero-reach (TAUT-005) | `MockFoo::new()` now binds to its variable (incl. `Box`/`Arc`/`Rc`/`Pin` wrappers) and records a call site on any non-`expect_*` method invocation; field/deref/paren wrappers recurse (`*m.foo().0`). 100+ false TAUT-005 → 0 |
| 53 | *(dogfood, mockall)* | a `mock!` macro **and** `MockFoo::new()` both emitted a `MockIR`, and bare names resolved through the wrong-file global fallback | one mock per `MockFoo::new()`; `mock! { impl Trait for Foo }` maps to trait `Trait`, inherent-only `mock! { Foo { .. } }` to no target; the audit engine resolves the bare `exportName` against production (TS/PHP precedent). False DRIFT-001 → 0 |
| 54 | *(dogfood, mockall)* | `tests/` integration tests (incl. compile-only, no `#[test]`) were indexed as **production**, polluting the symbol graph | paths under `tests/` are now classified as test files. 17 false errors → 0 |

## 3. Findings about `/root/Chaos-MCP` (TypeScript)

Verified against source after fixes; working tree at commit `a65faae`.

- **DRIFT-006** (git-diff `HEAD~10`): 6 stale-mock warnings — `estimate-handler.test.ts` and
  `handler-container.test.ts` mock `estimateAudit`/`estimateNeedsSandbox`/`createExecutionSession`
  from `core/estimate.ts`, `estimate-handler.ts`, `utils/execution.ts`, which changed in that
  range while the test files did not. **True positives.**
- **Remaining warnings (0 errors):** MOCK-001 (4, mock-heavy unit tests — heuristic, working as
  intended: `handler-container`, `index`, `python-interpreter-memo`, `triage-discover-targets`).
- **Resolved false positives:** TAUT-005 (scope-aware hand-off, **107 → 0**), TAUT-006
  (spied-object hand-off, **5 → 0**), the TAUT-001 determinism test
  (`expect(f(x)).toBe(f(x))` — a re-evaluating call, now correctly not flagged), and TAUT-004
  (**21 → 0** — `productionCalls` now sees SUT instances assigned in `beforeEach`, traces local
  helper functions that wrap the SUT, collects `it.each`/`test.each` tests, and counts a dynamic
  `import()` as executing production code).

## 4. Findings about `/root/Knossos-MCP` (PHP)

Verified against source after fixes; working tree at commit `3ff6b0c` (now with a `vendor/` dir).

- **TAUT-001 / TAUT-003** (`tests/phpunit/Cli/CliHelpersTest.php:322,530,568`):
  `assertSame(true, true)` with the author's own `// sentinel` comments — **true positives**
  (no-op smoke assertions).
- **TAUT-005** (0 warnings, was 8 → 5 → 0): `createStub(PDO::class)` / `PDOStatement` configured
  then passed into the SUT (`new ProjectWriterLease($pdo, …)`, `new ProjectWriterLock($pdo)`)
  or returned from a `willReturnCallback` closure (`return $stmt;`). After wiring
  constructor/call/return hand-off reachability, all were correctly marked reachable.
- **Drift:** CLEAN. Mocks target `LanguageWorkerPool` (own class, resolves via PSR-4 to
  `src/Scan/LanguageWorkerPool.php`) and `PDO`/`PDOStatement` (PHP built-ins, correctly skipped).
- **`willThrowException` now recognized** as a config call (like `willReturnCallback`), which
  removed 3 of the TAUT-005 warnings (the throw-configured `$pool`/`$pdo` mocks are now marked
  reachable instead of zero-reach). The thrown exception expression is now also captured in the
  IR as mock-level config (row 23).
- **Remaining findings are the 6 genuine `assertSame(true, true)` sentinels** — true positives
  (the author's own `// sentinel` comments).
- **DRIFT-001 / DRIFT-003 drill-down: 0 issues** on the full corpus — the drift rules produce no
  false positives (and no true positives: Knossos genuinely has no planted drift).
- **MCP round-trip verified** against Knossos with all 5 tools, twice: once over the in-memory
  transport and once over a **real stdio subprocess** (temp `.momusrc` with PHP enabled + cache
  disabled, removed after). Both give: `listTools` → 5, `list_rules` → 14, `verify_mock_drift` →
  0, `detect_tautological_assertions` → 6 sentinels, `audit_test_fidelity` on
  `CliHelpersTest.php` → 6, `synthesize_mock_contract` on `LanguageWorkerPool.php` → correct
  `phpunit` template.
- **Sentinel decision:** the 6 `assertSame(true, true)` hits are correct true positives, not a
  Momus bug. The author uses them as no-op smoke/skip markers (`// sentinel` — `assertTrue` is
  absent from `Support/Assertions.php`). Recommendation for Knossos (not a Momus change): add
  `assertTrue` to the assertion shim, or use PHPUnit's `expectNotToPerformAssertions()` / a
  proper `markTestSkipped` for the pcntl-guard case — the current lines give false confidence.

## 4b. Self-dogfooding (Momus on Momus)

- **Full audit incl. DRIFT-000: 0 issues** on 59 files (all 23 test files + production source).
  The tool's own test suite genuinely exercises the drift/tautology rules (36 `vi.fn`, 20
  `vi.spyOn`, 6 `vi.mock`) and stays clean.
- **git-diff drift (`--base HEAD~15`): CLEAN** — no DRIFT-006 stale-mock.
- **`momus contract` on its own classes** surfaced two real synthesis bugs (fixed, rows 16–17):
  string-literal union aliases emitted `{ length: 0 }`, and inline type literals didn't recurse
  through the checker. Post-fix, `momus contract packages/core/src/audit.ts` produces a fully
  correct nested literal for `AuditResult` (`summary: { … truncated: false }`, `issues: []`,
  `indexStats: { modules: 0, symbols: 0, mocks: 0 }`).
- **Second dogfooding pass** surfaced three more synthesis bugs (fixed, rows 18–20): generic
  methods and generic classes emitted out-of-scope type parameters (now concretized to `unknown`,
  with `Partial<Box<unknown>>` for generic classes), and interface targets returned `no class
  found` (now supported — data properties become plain values, methods become `vi.fn` stubs).
  `momus contract packages/core/src/ir.ts --symbol ModuleIR` now yields a correct 13-property
  `ModuleIR` mock.

## 4c. Findings about `psf/requests` (Python — first Python dogfood)

Cloned to `/tmp/requests-dogfood` (temp `.momusrc` → `{languages:{python:true}}`, cache off),
full audit: **35 files, 0 issues**, cold parse 0.9s (15.4s before the row-51 fix). requests'
tests mock sparingly (5 `@patch`/`mock.patch`, 3 `Mock`/`MagicMock` — most tests run against
a live test server), so DRIFT/TAUT had little to fire on: **no false positives**, and the one
planted perf bug (row 51) was caught and fixed here. The Python drift rules get a stronger
real-world workout in the next dogfood (a mock-heavy pytest repo — e.g. httpx/flask).

## 4d. Findings about `asomers/mockall` (Rust — first Rust dogfood)

Cloned to `/tmp/mockall-dogfood` (temp `.momusrc` → `{languages:{rust:true}}`, cache off),
full audit of mockall's **own test suite** (188 `.rs` files, 172 under `tests/`).

- **Fixed (rows 52–54):** three real bugs — `invocationSites` never populated (100+ false
  TAUT-005), double-`MockIR` emission for `mock!` + `MockFoo::new()` (false DRIFT-001), and
  `tests/` integration tests indexed as production (17 false errors). Result: **265 issues
  (17 errors) → 16 warnings, 0 errors.**
- **Remaining 16 TAUT-005 warnings — all on mockall's codegen edge cases, none are errors,**
  and none are false DRIFT/TAUT-001 positives. They fall into three documented static-analysis
  boundaries:
  1. **Receiver-wrapper re-bindings** (`automock_auto_impl.rs:28`
     `let boxed: Box<dyn Foo> = Box::new(mock); assert_eq!(5, boxed.foo(4))`;
     `mock_box_self.rs` `Arc::new(mock).bean()` / `Rc::new(mock).blez()` /
     `Pin::new(Box::new(mock)).booz()`) — the method is invoked on a re-cast/wrapper value, not
     the bound variable, so the invocation isn't traced to the stub.
  2. **By-value consumption** (`automock_generic_future.rs` `block_on(mock)` — `poll()` is
     driven inside the future executor, not called on the variable directly).
  3. **cfg-gated compile-only tests** (`mock_cfg.rs` `#[cfg(feature = "nightly")]` variants
     configure `expect_foo()`/`expect_beez()` but never invoke them — the test only checks the
     proc-macro codegen compiles). These are arguably *true* zero-reach (the stub genuinely is
     never called) but are compile-checks, not behavior assertions.
- **`mock!` DSL:** mockall's `mock!`/`#[automock]` are proc-macros, so `syn` sees the invocation,
  not the generated mock — the parser hand-models the `mock!` token stream and resolves the
  target trait from the crate index (see spec §4). Verified against the full `tests/` corpus.

## 5. Open / candidate improvements

1. ✅ PHP `willThrowException`'s exception value is now recorded in the IR as mock-level config
   (`configuredValues`, api `willThrowException`) — implemented. It is deliberately **not** a
   return value, so DRIFT-003 never compares an exception against the production return type.
   (Left: surfacing the exception value in the `synthesize_mock_contract` PHP templates.)
2. ✅ TS synthesis now resolves **named** interface/class returns through the type checker
   (`tsReturnExampleChecked`), so `User` / `Promise<User>` emit data-shape literals
   (`mockResolvedValue({ id: 0, … })`) instead of `undefined`. `Record<K, V>` / index-signature
   types (`NodeJS.ProcessEnv`) emit `{}`. Method-bearing shapes now emit `vi.fn()` stubs too:
   inline type literals with method signatures (`{ run(): void }` → `{ run: vi.fn() }`),
   function-typed properties (`cb: (x: number) => void` → `cb: vi.fn()`), and named
   interfaces with methods (data properties as values, methods as `vi.fn`). Remaining nuance:
   optional members are included with their example value (`zip?: number` → `zip: 0`).
3. ✅ PHP synthesis surfaces `@throws` docblocks: the parser now extracts exception class names
   into `SignatureIR.throws` (IR schema v3), and `synthesize_mock_contract` emits a commented
   `willThrowException` (phpunit) / `andThrow` (pest) alternative per `@throws`-documented method.
   The doc-type tokenizer also handles generics with spaces (`array<int, Invoice>`) — see row 26.
4. MOCK-001 (over-mocking) remains a heuristic warning — it intentionally flags mock-heavy unit
   tests; tuning its threshold or production-assertion counting is a judgment call, not a bug.
5. TAUT-004's last survivor is a dynamic-`import()` + indirect signal-handler invocation
   (`(sigCall[1])()` from a spy's `.mock.calls`) — statically untraceable without full
   interprocedural analysis.
6. ✅ The 5s vitest default timeout flaked under parallel coverage on three tests (git-diff MCP,
   syntax-only, in-memory audit); a global `testTimeout: 15s` now covers instrumentation headroom
   without masking real hangs. Coverage gate holds at 80/75/90.
7. PHP parser coverage raised 88.4→96.6% stmts / 100% funcs via new fixtures: `createPartialMock`
   member lists, `createConfiguredMock` array values, PHPDoc type-syntax variants, and a
   deliberately broken file exercising the SYS-001 parse-error diagnostic.
8. ✅ TS DRIFT-003 now fires for spyOn-bound configs (rows 27–29): a new `computeReturnAssignability`
   pass runs for `vi.spyOn`/`jest.spyOn` mocks (previously only `vi.mocked` instances), the
   value node resolves to the config **argument** (not the callee), owner resolution is
   position-aware, and casts are unwrapped. Planted fixture (`mockReturnValue('nope')` on
   `totalCents(): number`) → DRIFT-003 warning; healthy twin quiet.
9. ✅ Member calls on a spied-on object now mark the matching spy reached
   (`svc.totalCents()` invokes the `vi.spyOn(svc, 'totalCents')` spy) — removes TAUT-005
   false positives on the standard spy+call pattern while preserving TAUT-006 (member names
   must match, so `service.totalFor()` never satisfies a spy on `totalForX`).
10. ✅ `momus --root DIR` is honored by every command (row 30): audit/drift/hook/contract/rules/
    init/doctor/serve run against DIR from any cwd (mirrors the MCP server's `MOMUS_ROOT`).
    Regression test runs the bin from an empty cwd with `--root` pointing at a target repo.
11. ✅ TS DRIFT-003 assignability now covers the full spy-config surface: `mockReturnValueOnce` /
    `mockResolvedValueOnce` flow through the same pass (fixture: planted once-mismatch fires),
    `mockImplementation`/`mockImplementationOnce` callback **returns** are checked against the
    production return type (`spy.mockImplementation(() => 'nope')` on `totalCents(): number`
    fires), and `mockRejectedValue` is correctly exempted (row 31 — a rejection reason, not a
    resolved value). Dogfooded on Momus itself (20+ spyOn uses): 0 issues; Chaos re-audit
    unchanged (0 errors / 4 MOCK-001).
12. ✅ DRIFT-002 parameter assignability tree covered (rows 32): union-union no longer false-
    flags; named params compare names + type args; array/tuple element-wise; literal-vs-named
    handled in both directions. New direct rule tests exercise every `typeAssignable` branch.
13. ✅ Coverage pass: `markdown.ts` 100% branches (pluralization edges), `symbolIndex.ts` 100%
    stmts/branches (new direct unit tests: inheritance, diamond dedupe, missing extends,
    same-module `resolveByName`, exports), and direct PHP DRIFT-003 rule tests for the
    `phpReturnAssignable` tree (mixed/void/null/union/class-resolution branches).
14. ✅ CLI `main()` dispatch extracted into exported per-command functions (`runAudit`/`runDrift`/
    `runPrecommit`/`runHook`/`runContract`/`runRules`/`runServe`/`runInit`/`runDoctor`/
    `runAnnotate`/`runAnnotatePr`) with a thin `main` mapper — commands are now unit-testable
    without spawning a subprocess (2 direct tests added); CLI entrypoint coverage 19.4% → 37.8%.
    Note: the ts.Program cache is memoized per process, so calling a run* twice on the same path
    in one process can serve a stale program — the real CLI invokes one command per process.
15. ✅ SYS-004 (perf-budget, §2.7) is now real, not just a declared code: a per-file parse over
    the budget (`AuditOptions.parseBudgetMs`, default 2s — well above the 50ms normative budget
    to keep CI timing-flake-free) emits an info diagnostic and the audit still completes. Unit
    tests drive a busy-wait parser against a 1ms budget (fires) and a 5s budget (quiet). Row 35.
16. ✅ CI now runs `npm run lint` + `npm run format:check` in the test job — the style gates
    were script-only before.
17. ✅ CLI entrypoint coverage 37.8% → 46.3%: `main` is now exported, and direct tests (no
    subprocess) cover help/`--help`/`-h`, unknown-command exit 2, `init` dispatch through
    `main`, and `doctor` incl. a broken-`.momusrc` tolerance path (rows 39–40).
18. ✅ PHP parser branch coverage 79.4% → 80.8% + a **real bug fixed**: `phpValue` classified
    `new X()` as a literal (`constant: true`), so `assertNotSame(new Engine(), $engine)` could
    be read as a self-comparison; a `new` expression re-evaluates (fresh object), so it now
    falls through to `exprKind` → `'new'` (row 38). New `EdgeCasesTest.php` fixture also
    covers variable class targets (`createMock($className)`), non-`$this` property
    assignments (correctly not bound as `this:` mocks), and dynamic member names
    (conservatively not bound). Knossos re-audit unchanged.
19. ✅ §2.7 perf budget `MCP tools/list serialized size < 4 KB` is now asserted in the MCP
    integration test (the SDK's `ListToolsResult` payload is serialized and measured); the
    workspace-time budget stays documented-only because a wall-clock assert on a 100k-LOC
    workspace would flake under CI/coverage instrumentation.
20. ✅ Dogfood gap found on Chaos-MCP: **`importOriginal` partial-mock factories lost their
    override keys**. `vi.mock('mod', async (io) => { const a = await io(); return { ...a,
    key: vi.fn() }; })` produced a mock with **zero** stubbed members (only expression-bodied
    factories were scanned), so the stubbed exports were invisible to DRIFT-005/TAUT rules.
    `findReturnedObjectLiteral` now scans block bodies; the `...actual` spread is preserved
    as a non-stub. Regression tests cover both the block-bodied `importOriginal` form and the
    non-object fallback (row 42). Chaos re-audit unchanged (4 MOCK-001 / 0 errors) — no
    false positives from the richer extraction.
21. ✅ PHP synth render branches covered: `phpReturnExample` union (non-null member drives
    the example: `int|string` → `andReturn(0)`), intersection, and callable returns stay
    conservative (`null`), via new `either`/`both`/`factory` methods on `DocblockTypes.php`
    (row 43). Server stmts 91.5 → 92.1%.
22. ✅ **Real precommit bug found by dogfooding the git-diff flow on a temp clone of Chaos-MCP**: module-target
    mocks (`vi.mock`/`jest.mock` factories) have **no `symbolId`**, and `diffRelevant` required one — so in
    `precommit`/`--git-diff` mode they were silently out of scope. A renamed production export left the
    `vi.mock` factory key dangling and precommit reported **CLEAN** (exit 0) while a plain audit correctly
    fired DRIFT-005. `diffRelevant` now resolves module-target mocks through their changed `modulePath`, and
    DRIFT-006 (stale-mock) gained a module-target branch (stale when the module file changed + mock file
    untouched; message lists the module basename + export names, budget-fitted). Planted rename on the temp
    clone now fires DRIFT-005 errors + DRIFT-006 warnings across every affected test file with exit 1; the
    healthy twin (factory key updated alongside) clears. Regression tests at rule level (diff.test.ts) and
    CLI end-to-end (row 44).
23. ✅ Dogfooded the **MCP `verify_mock_drift` git-diff scope on a temp clone of Knossos-MCP (PHP)**: planted
    `client()` → `clientRenamed()` in `LanguageWorkerPool.php` with `LanguageScanRunnerTest`'s `createStub`
    + `->method('client')` untouched → the tool surfaced **8 DRIFT-001 errors + 11 DRIFT-006 warnings**; the
    healthy twin (stub updated to `clientRenamed`) cleared to 0. PHP class-target mocks participate in diff
    scope exactly like TS. Added a PHP git-diff MCP integration test (fixture repo with `.momusrc` php:true)
    so the path stays regressed (row 45).
24. ✅ Jest probe: `jest.doMock('mod', () => ({...}))` (one-off module mock, same factory semantics as
    `jest.mock`) was invisible — only its inner `jest.fn` was caught. Now matched as its own `jest.doMock`
    pattern with `mockFactoryKey` members; `MockPattern` union extended. Regression test pins the factory-key
    extraction (row 46). Second pass: `jest.genMockFromModule` (deprecated alias of
    `jest.createMockFromModule`) was also invisible — now matched as an automock. `jest.unmock`/
    `jest.requireActual`/`jest.isolateModules`/`jest.replaceProperty` are correctly **not** mocks
    (verified by probe, no change).
25. ✅ **§2.7 perf budgets now asserted** (row 47): `packages/core/test/perf.test.ts` generates a
    deterministic 100k-LOC PHP workspace (500 classes × 100 methods) in a temp dir, audits it, and asserts
    the time/memory budgets with CI-tolerant ceilings (15s / 500 MB vs normative 2s / 200 MB — the real
    signal is no order-of-magnitude regression, and the probe measured **169ms / 45 MB**). It also asserts
    the planted 500 TAUT-002 echoes still fire at scale (`totalIssues`, since `maxIssues: 0` truncates
    `issues`). Gotcha found while writing it: a **lazy `require('@momus/parser-php')` inside the test
    function** loaded a second copy of the module graph (parser-php's own `@momus/core` dependency) and
    confused v8 coverage — dropping `All files` from 91.6% → 85%; top-level `import { PhpParser }` fixed
    it (and `config.ts`/`audit.ts` etc. returned to their real numbers).
26. ✅ Release tooling migrated from changesets to **release-please** modeled on Knossos-MCP (single
    lockstep version from **0.0.1**): `release-please-config.json` (json extra-files bump all five
    workspace `package.json`s) + `.release-please-manifest.json`; `pr-title.yml` conventional-commit
    gate; `.github/workflows/release-please.yml` (version-PR → `v*` tag + GitHub Release → gate +
    `npm run publish` on `release_created`); `scripts/publish.mjs` (dependency-ordered `npm publish -w`).
    Internal `@momus/*` deps re-pinned `~0.0.1` so they track in lockstep. Two verification layers:
    `scripts/verify-release-config.mjs` (deterministic, no-network consistency check wired into
    `ci.yml` + `test/release-config.test.ts`) and `scripts/simulate-release.mjs` (round-trips the
    release flow in an isolated worktree: bump 0.0.1 → 0.0.2 exactly as release-please would →
    `npm ci` → `npm publish` dry-run → asserts all five packages pack at 0.0.2 and `~` ranges admit
    the bump). MCP `serverInfo.version` is now read from `@momus/mcp-server`'s package.json at
    runtime (was hardcoded `0.1.0`); pinned by an integration test. First live runs against
    the real GitHub API surfaced three more fixes: `json` extra-files need a `jsonpath`
    property; `bump-patch-for-minor-pre-major: true` keeps pre-1.0 releases in 0.0.x so the
    `~0.0.1` internal dep ranges resolve on release branches; and **npm publishing was removed
    from CI entirely** (manual-only by decision — tags/releases cut automatically, npm never
    touched until publishing is sanctioned). v0.0.1 bootstrapped + v0.0.2 cut automatically
    (PR → merge → tag + release with changelog); main branch protected (PRs only, required
    checks, strict up-to-date, enforced for admins).
27. ✅ Dogfood probe round (no code gaps found): `vi.hoisted(() => vi.fn())` and
    `vi.hoisted(() => ({ key: vi.fn() }))` — the pervasive real-world pattern for sharing mock fns
    with `vi.mock` factories — resolve correctly on Chaos-MCP: the hoisted `vi.fn` is a standalone
    mock, the factory keys (`listChangedFiles`, `Server`, …) extract as `mockFactoryKey` stubs, and
    MOCK-001 counts stay accurate (no double-counting, no false TAUT/DRIFT). Class-valued factory
    keys (`Server: class { … }`) also extract. Chaos re-audit unchanged (0 errors / 4 MOCK-001);
    Knossos unchanged (6 sentinel errors, all deliberate `assertSame(true, true)` markers).
