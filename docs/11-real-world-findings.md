# Momus-MCP — Real-World Validation Findings

> **Live report.** Updated as we validate Momus against two real, independent AraneaDev
> repositories plus Momus itself (dogfooding). This is the honest record of (a) what Momus
> reports about those codebases and (b) the bugs we found in Momus while doing so.
> Non-normative (see `docs/README`).

**Last updated:** 2026-08-19 (round 51)

## 1. Targets

| Repo | Language | Scale | Test stack | Momus config used |
|---|---|---|---|---|
| `/root/Chaos-MCP` | TypeScript (ESM, NodeNext) | 202 audited files, 97 test files | Vitest (`vi.*`), Stryker mutation testing | default TS |
| `/root/Knossos-MCP` | PHP ≥ 8.3 | 455 audited files (683 `.php` + 324 `.ts` + 17 `.py` in tree) | PHPUnit 12, Infection | `.momusrc` → `{languages:{typescript,php,python}}` |
| `/root/Argos-MCP` | TypeScript | 78 audited files | Jest | default TS |
| `/root/termaxa` | Rust | 29 audited files, 8 integration tests + inline `#[cfg(test)]` | Rust built-in `#[test]` / `assert*!`, **no mock library** | `.momusrc` → `{languages:{rust:true}}` |
| `Momus-MCP` (self) | TypeScript + PHP | 59 audited files | Vitest | `.momusrc` (fixtures excluded) |
| `psf/requests` (dogfood clone at `/tmp/requests-dogfood`) | Python | 35 files, 13 test files | pytest + unittest.mock (live test server) | temp `.momusrc` → `{languages:{python:true}}` |
| `asomers/mockall` (dogfood clone at `/tmp/mockall-dogfood`) | Rust | 188 `.rs` files, 172 under `tests/` | mockall's own `#[automock]`/`mock!` + `#[test]`/`#[cfg(test)]` | temp `.momusrc` → `{languages:{rust:true}}` |
| `pallets/flask` (dogfood clone at `/tmp/flask-dogfood`) | Python (src-layout) | 83 files, 3,000+ LOC under `tests/` | pytest (fixture-based; planted `unittest.mock` probes for the rules) | temp `.momusrc` → `{languages:{python:true}}` |
| `lipanski/mockito` (dogfood clone at `/tmp/momus-dogfood/mockito`) | Rust | 12 `.rs` files | mockito's own `mock("GET", "/x").create()` + `server.mock(...)` tests | temp `.momusrc` → `{languages:{rust:true}}` |
| `LukeMathWalker/wiremock-rs` (dogfood clone at `/tmp/momus-dogfood/wiremock-rs`) | Rust | 21 `.rs` files | wiremock's own `Mock::given(...).mount(...).await` tests | temp `.momusrc` → `{languages:{rust:true}}` |
| `alexliesenfeld/httpmock` (dogfood clone at `/tmp/momus-dogfood/httpmock`) | Rust | 73 `.rs` files | httpmock's own `server.mock(|when, then| {...})` + `m.assert()` tests | temp `.momusrc` → `{languages:{rust:true}}` |
| `django/django` (sparse dogfood clone at `/tmp/momus-dogfood/django/tests`) | Python | `tests/tasks` + `tests/apps` | unittest.mock `patch.multiple` (attribute patches) | temp `.momusrc` → `{languages:{python:true}}` |
| `ryo33/mry` (dogfood clone at `/tmp/momus-dogfood/mry`) | Rust | 52 `.rs` files (workspace `mry` + `mry_macros`) | mry's own `#[mry::mry]` + `mock_<method>(…).returns(…)` tests | temp `.momusrc` → `{languages:{rust:true}}` |
| `nrxus/faux` (dogfood clone at `/tmp/momus-dogfood/faux`) | Rust | 38 `.rs` files | faux's own `#[faux::create]` + `Foo::faux()` + `faux::when!(…).then*(…)` tests | temp `.momusrc` → `{languages:{rust:true}}` |
| `kriomant/mockers` (dogfood clone at `/tmp/momus-dogfood/mockers`) | Rust | 59 `.rs` files (workspace `mockers` + `mockers_derive`) | mockers' own `#[mocked]`/`mock!` + `Scenario::create_mock_for::<dyn T>()` + `scenario.expect(handle.m(…).and_return(…))` tests | temp `.momusrc` → `{languages:{rust:true}}` |
| `mockiato/mockiato` (dogfood clone at `/tmp/momus-dogfood/mockiato`) | Rust | 103 `.rs` files (workspace `mockiato` + `mockiato-compiletest`) | mockiato's own `#[mockable]` + `XMock::new()` + `x.expect_<m>(…).returns(…)` tests | temp `.momusrc` → `{languages:{rust:true}}` |
| `CodeSandwich/Mocktopus` (dogfood clone at `/tmp/momus-dogfood/mocktopus`) | Rust | 46 `.rs` files | mocktopus's own `#[mockable]` + `foo.mock_safe/mock_raw(…).MockResult::Return(…)` tests | temp `.momusrc` → `{languages:{rust:true}}` |
| `DavidDeSimone/mock_derive` (dogfood clone at `/tmp/momus-dogfood/mock_derive`) | Rust | 12 `.rs` files | mock_derive's own `#[mock]` trait/extern + `MockX::new()` / `Extern<Abi>Mocks::method_<fn>()` + `method_<m>().set_result(…)` tests | temp `.momusrc` → `{languages:{rust:true}}` |
| `mindblaze/galvanic-mock` (dogfood clone at `/tmp/momus-dogfood/galvanic-mock`) | Rust | 20 test `.rs` files | galvanic-mock's own `#[mockable]`/`#[use_mocks]` + `new_mock!(Trait)` + `given!`/`expect_interactions!` + `mock.method(…)` tests | temp `.momusrc` → `{languages:{rust:true}}` |

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
| 54 | *(dogfood, mockall)* | `tests/` integration tests (incl. compile-only, no `#[test]`) were indexed as **production**, polluting the symbol graph | paths under `tests/` are now classified as test files. 17 false errors → 0 |
| 55 | *(dogfood, mockall 2nd pass)* | Rust `invocationSites` still missed three real invocation shapes: `unsafe { mock.bar(…) }` blocks (execution-time code) were not descended into, `syn::Expr::Reference` (`&mock`) was serialized without its referent so `&mock` never resolved as a receiver/arg, and trait-qualified/UFCS calls (`Foo::foo(&mock)`, `<Mock as Foo>::foo(&mock, 4)`) never recorded — plus TAUT-005 fired on `#[should_panic]` tests whose drop-panic **is** the assertion | 6 false TAUT-005 warnings on mockall (`mock_refmut_arguments`, `automock_impl_trait_for`, `automock_impl_generic_trait_for`, `automock_trait_variant`, `mock_trait_variant`, `automock_many_args`). Now: blocks/unsafe serialize their statements, `Reference` renders its referent, qualified-path callees keep the `<Ty as Trait>::` prefix, first-arg receivers mark the mock reached, and `TestFnIR.shouldPanic` + `MockIR.fnId` (IR schema 8) suppress TAUT-005 inside panic tests. 11 → 5 |
| 56 | *(dogfood, flask)* | `resolvePythonImport` never probed a `src/` ancestor (src-layout), so `patch('flask.sessions.X')` on flask/httpx/django-style repos never resolved `modulePath` and DRIFT-005 **silently degraded** (module target skipped, no issue) | `src/` is now probed at each ancestor alongside the flat layout; planted `patch('flask.sessions.NonexistentSessionAttr')` fires a DRIFT-005 error on the real flask clone, the healthy twin (`existing_attr`) stays quiet, and the clean flask/httpx baselines unchanged (0 issues) |
| 57 | *(dogfood, mockall 3rd pass)* | `rustReturnAssignable` compared non-primitive named return types by **exact name only**, so generic-dependent returns were unprovable and always fell through to `false`: `fn myfunc<V>(&self) -> V` with `return_const(42u32)` and `fn bar<T>(&self, _t: T) -> <T as Foo>::Output` with `return_const(42u32)` | 2 false DRIFT-003 warnings on mockall (`automock_generic_future_with_where_clause.rs`, `automock_qself.rs`). `rustReturnAssignable` now resolves the production name through the symbol index like PHP's class path: unresolvable names (type params, qself projections, `impl Trait`, `Self`, cross-crate types) pass conservatively, resolvable names stay strict (a scalar literal can't construct a struct; distinct resolved symbols can't be the same). mockall re-audit: **0 errors**; the 2 DRIFT-003s gone; TAUT-005 now **3** (2 cfg-gated + 1 configured-but-unused) — all genuine. Regression fixtures `generic_test.rs` + `repo.rs::Record` + unit tests (IR schema 10) |
| 58 | *(dogfood, requests)* | Python `module.exports` listed **symbols only**, so module-level import bindings were invisible to DRIFT-005: `import idna` (binds `idna`) and `from requests.compat import proxy_bypass` (binds `proxy_bypass`) are real module attributes but `patch('requests.help.idna')` / `patch('requests.utils.proxy_bypass')` false-flagged as missing exports (3 errors). Related: MOCK-002 fired `mock-of-self` for **attribute-level** patches inside the SUT module (`patch('requests.help.idna')` in `test_help.py`) — normal dependency patching, not mock-of-self | `exports` now unions top-level import bindings (`import a.b` binds `a`, `as` binds the alias; function-local imports are excluded so they still flag); MOCK-002's Python branch only fires when the patch targets the module itself (`patch('requests.help')` — final dotted segment == module basename). requests re-audit: **3 errors + 3 infos → 0 issues**. Regression fixtures `prod_imports.py`/`test_patch_imports.py` + rule-level tests (IR schema 10) |
| 59 | *(dogfood, contract synthesis)* | `momus contract` defaulted `--framework` to `'vitest'` for every language, so the header label mismatched the emitted body: `momus contract x.py` printed `(vitest)` while emitting `patch.object`, and `.rs` targets fell back to a **wiremock scaffold** instead of a mockall mock | `runContract` now defaults the framework by target extension (`.rs` → `mockall`, `.py` → `pytest`, `.php` → `phpunit`, else `vitest`); explicit `--framework` still wins. Verified on `requests/src/requests/sessions.py` (pytest + `patch.object`) and the `types.rs` fixture (mockall `mock!` block); CLI regression test pins all three defaults + explicit override |
| 60 | *(dogfood, mockall 4th pass)* | mockall's own integration tests (`mockall/tests/*.rs`) declare a fixture `trait Foo`/`struct Bar` **inside each test file** purely to exercise `#[automock]`/`mock!`, then mock it — so MOCK-001 (over-mocking) counted each same-file fixture as a mocked production dependency and MOCK-002 (mock-of-self) read it as mocking the subject-under-test. A second gap: `mock!` macros with generic `where` clauses weren't parsed by the `recordMockMacro` regexes | **60 MOCK-001 + 133 MOCK-002** on mockall (the documented baseline only listed 0 errors / 3 TAUT-005). MOCK-001/MOCK-002 now skip mocks whose target is declared in the **same test file** (a framework self-exercise, not a production dependency or subject); `recordMockMacro` now parses generics + `where` clauses in the `impl` form (2 more MOCK-001 cleared). mockall back to **0 errors / 3 TAUT-005** |
| 61 | *(dogfood, httpmock)* | httpmock's primary API — `server.mock(|when, then| { … })` (a **closure** argument) plus `m.assert()` — was invisible to the Rust parser (only mockito/wiremock call-chains were modeled) | httpmock audit was **vacuous** (0 mocks; only 1 unrelated `#[automock]`). Added httpmock closure detection (`MockFramework`/`MockPattern` IR unions, parser match, CLI help, server enum + rust fence + contract scaffold; IR schema 11). httpmock re-audit: **43 mocks detected, 0 issues** |
| 62 | *(dogfood, mockall)* | mockall's static/associated/constructor method context API — `MockFoo::baz_context()` + `ctx.expect().returning(...)` (plus the module form `mock_foo::bar_context()` and the constructor `MockA::new_context()`) — was invisible: the parser only emitted a mock for `MockFoo::new()`, so **83 `_context()` configs produced zero mocks** and static-only test files had no drift/TAUT surface | emit one mock per `_context()` with the static method as a stub; `ctx.expect().returning/return_const` attaches the return value; reachability covers direct calls (`MockFoo::baz(41)`), UFCS (`<MockA as A>::new()`), function-pointer references (`let p = mock_ffi::foo; p(42)`), and raw-identifier normalization (`Mockwhile::r#loop()`) (IR schema 12) |
| 63 | *(dogfood, mockall 5th pass)* | mockall's one-shot/non-Send return variants — `return_once`, `return_once_st`, `returning_st` (391 `return_*` configs, ~16 of them these variants) — were not captured, so DRIFT-003 missed their values; and the static-context extraction false-flagged **TAUT-005 on `examples/serde.rs`**: an inherent static mock (`mock! { pub Thing { fn private_deserialize() } }`) is invoked *indirectly* through the SUT's own `impl Deserialize for MockThing`, which the parser never sees (impl bodies aren't serialized) | `isReturnMethod` now covers all five `return*` variants; and inherent/module static mocks (no resolvable drift target) skip return-value recording, so TAUT-005 treats them as unconfigured. mockall re-audit: **serde.rs TAUT-005 gone → 0 errors / 3 TAUT-005 + 2 MOCK-002** |
| 64 | *(dogfood, django)* | Python `unittest.mock.patch.multiple(Cls, member=…)` — the one-call patch of several class members — was invisible (0 mocks); found via a fresh `django/django` sparse clone (`tests/tasks` + `tests/apps`, 3 real usages incl. the decorator form `@mock.patch.multiple(...)`) | emitted one `patch-multiple` mock per call with a class target for visibility/MOCK-001. Member-level drift (DRIFT-001/003) is deliberately deferred: `patch.multiple` most often patches class *attributes* (`supports_async_task=False`, `ready=False`), which the Python parser doesn't model (methods-only + no inheritance), so a member check would false-flag inherited attributes. django dogfood: **0 issues**, detection non-vacuous |
| 65 | *(dogfood, mry)* | `discoverFiles` parsed `.gitignore` by dropping every `!` negation line and keeping the rest, so the standard Rust-workspace convention — ignore everything (`*`) then whitelist (`!*/`, `!*.rs`, `!Cargo.toml`) — **ignored the entire workspace** | a mry clone audited as **0 modules**. `.gitignore` is now parsed with proper semantics: negation (`!`, last match wins), directory-only (trailing `/`), anchored (`/` or a mid-pattern `/`), and ancestor-directory matching; the walker passes file-vs-directory so `!*/` re-includes directories. mry re-audit: **52 files discovered**. Regression test pins the ignore-all + whitelist convention |
| 66 | *(dogfood, mry)* | the mry mock library (`#[mry::mry]` + `mock_<method>(…).returns(…)`) was invisible — the Rust parser only modeled mockall/mockito/wiremock/httpmock, so mry's own test suite produced **0 mocks (vacuous audit)** | added mry detection (`MockFramework`/`MockPattern` `'mry'`, IR schema 14): `#[mry::mry]` types/impls/traits map method → declaring type; `x.mock_<method>` (instance), `Type::mock_<method>` (static), `Mock<T>::mock_<method>` (constructor), and bare `mock_<fn>` (free function) each emit a mock. Free-function mocks are untargeted (no member drift surface); a mry file skips the mockall pass (its `Mock<Type>` constructor collides with `MockFoo::new()`); return values are deliberately not recorded (mry returns are almost always `.to_string()` chains, and invocations sit inside `assert_eq!` macros the parser can't see — recording them would false-flag TAUT-005; *literal returns now recorded — see row 72*). mry re-audit: **72 mocks, 0 issues** |
| 67 | *(dogfood, faux)* | the faux mock library (`#[faux::create]` + `#[faux::methods]` + `Foo::faux()` + `faux::when!(mock.method).then(…)`) was invisible — a fresh `nrxus/faux` clone (36 `.rs` files, 55 faux mocks across 16 files) audited as a **vacuous 0-mock** | added faux detection (`MockFramework`/`MockPattern` `'faux'`, IR schema 15): `Foo::faux()` (and `foo::Foo::faux()`) instantiates a mock; `faux::when!(mock.method).then/then_return/then_unchecked` attaches the method as a stub. Return values are deliberately not recorded (faux returns are almost always closures, and invocations sit inside `assert_eq!` macros the parser can't see; *literal `then_return` values now recorded — see row 72*). faux re-audit: **55 mocks, 1 MOCK-002** (the `testable-renderer` example genuinely mocks its own `Renderer` — a true mock-of-self, INFO) |
| 68 | *(dogfood, mry 2nd pass)* | mry's **function-style macro form** `mry::m! { … }` (1 test file) was undetected, and `symbols.ts` derived an impl's owner from `selfType.text` which kept the module path (`foo::Foo`), so `#[faux::methods(path = "crate")] impl foo::Foo { … }` mismatched the symbol name `Foo` | added `mry::m! { … }` detection; `symbols.ts` now uses `selfType.name` (the clean last segment the wasm serializer already exposes). mry re-audit: **92 mocks (72 → 92), 0 issues**; faux's `tests/paths.rs` (`impl foo::Foo`) now resolves DRIFT-001/DRIFT-003 instead of false-flagging |
| 69 | *(dogfood, django full suite)* | a full `django/django` `tests/` clone (2005 `.py` files) surfaced **90 TAUT-005** false positives: `with mock.patch.object(X, "m", return_value=…)` / `@mock.patch(…)` inject the mock into the SUT's dependency graph, so the invocation is *indirect* (the SUT calls the patched target) and the parser can never record an `invocationSite` | TAUT-005 now skips `patch`/`patch-object`/`patch-multiple` mocks (reachability is unobservable for them). django re-audit: **90 → 1 TAUT-005** (the survivor is an `autospec` `MagicMock` injected via a patch's `return_value` — a documented boundary). Remaining django findings are honest: TAUT-001 `assertEqual(x, x)` self-comparisons (33), TAUT-003 constant comparisons in the test-runner's *intentional* fail-fixtures (10), TAUT-004/006 (25) closed by the Python `hasProductionCalls` pass (row 70), DRIFT-001 (2) blocked on inheritance resolution (`_pre_setup`/`_post_teardown` are inherited from `unittest.TestCase`) |
| 70 | *(dogfood, django full suite)* | Python test functions never computed `hasProductionCalls` (`extractTestFunctions` hardcoded `false`), so **TAUT-004** read every mock-assertion-heavy test as "never touches production" (21) and **TAUT-006** read `mock.MagicMock()` members invoked *indirectly* through the SUT (`mock_source_db.backup` called by `setup_worker_connection`) as unconfigured spies with no call path (4) — the TS `productionCalls` dataflow pass had no Python analogue | `extractTestFunctions` now computes `hasProductionCalls` by walking each test function for calls whose root is a **module-level import from a non-framework module** (`unittest`/`mock`/`pytest*`/`django.test*` are helpers; `django.db`, `django.utils.choices`, stdlib `copy`/`datetime`/`ctypes`, … are production), with mock-binding shadowing resolved first. TAUT-006 gained a **Python-scoped** suppression: an unreached spy whose enclosing test exercises production is no longer flagged (Python reachability can't see `return_value=`/SUT-mediated invocation; TS/PHP/Rust keep the strict `invocationSites` signal — the golden fixture's planted TS TAUT-006 still fires). django re-audit: **TAUT-004/006 25 → 0**; requests (35 files) + flask (83 files) baselines unchanged (0 issues). Regression tests: 4 parser + 3 rule |
| 71 | *(dogfood, django full suite)* | a tree-sitter **node-identity bug silently disabled mock binding**: `bindingNameFor` used `childField(parent,'right') === call`, but `childForFieldName` returns a fresh JS wrapper for the same node (same `id`, different object), so on large files the `bindings` map stayed empty and `resolveMockName`/positional hand-off reachability/`m.member.return_value = X` config capture all no-oped (same bug in `importFrom`'s `child === modNode`). This is why django's last TAUT-005 (`test_sqlcompiler.py` `cursor` injected via `return_value=cursor`) and the DRIFT-001 inherited members survived rounds 38–39 | compare nodes by `.id`, not `===`. Also: (1) a mock handed off via a patch's `return_value=`/`side_effect=` **kwarg** is now marked reached; (2) `patch.dict(os.environ, {…})` detected (`patch-dict` pattern, module target, 49 django usages — TAUT-005 skips it like `patch`); (3) Python `classToSymbol` populates `extendsIds` from `superclasses`, and **DRIFT-001 skips missing-member when the target extends an unresolvable base** (the member may be inherited — `_pre_setup`/`_post_teardown` from `unittest.TestCase`). django re-audit: **46 → 43** — only the honest set remains (33 TAUT-001 self-comparisons + 10 TAUT-003 intentional fail-fixtures). requests/flask 0; Chaos 0 err / 4 MOCK-001; Knossos 6 sentinels. IR schema 16 |
| 72 | *(dogfood, mry/faux return-value recording)* | DRIFT-003 (return-type assignability) was **dead for mry and faux** — their return values were deliberately never recorded (the original rationale was that returns are closures/`.to_string()` chains and invocations sit in `assert_eq!` macros), so a planted `returns("nope")`/`then_return("nope")` on a `-> u32` method fired **nothing** | record a **literal** return value for the value-producing verbs — faux `then_return(42)`, mry `returns(42)`/`returns("…")`/`returns_once`/`returns_with` — and skip non-literals (`then`/`then_unchecked`/`returns_with(|…|)` closures, `.to_string()` chains → `literalType` yields `unknown`, no literal to compare). Both mry `emitMryMock`/`emitMryStatic` and the faux stub now return/reuse the mock so the verb can attach its value. Planted probes on fresh `ryo33/mry` + `nrxus/faux` clones fire DRIFT-003 end-to-end. Re-audits unchanged and now honest: faux **55 mocks / 1 MOCK-002** (13 mocks DRIFT-003-checked), mry **92 mocks / 0 issues** (12 DRIFT-003-checked), mockall 0 err / 3 TAUT-005 + 2 MOCK-002 (unchanged). Discovered boundary: mry's `mock_<method>` has no embedded type, so its `typeTargets` is populated only from **same-file** `#[mry::mry]` declarations — a `src/`-declared type mocked in `tests/` audits vacuously (mry's own tests are same-file, so the 92-mock baseline is unaffected) |
| 73 | *(dogfood, mry cross-crate)* | mry's `mock_<method>(…)` carries **no embedded type**, and `scanMry` only ran when the test file itself declared `#[mry::mry]` — so a type declared in a production crate (`src/lib.rs`) and mocked in `tests/` via `MockFoo::default()` + `mock.mock_foo()` was **invisible** (0 mocks; mry's own `crate_bound_consumer` test exercised exactly this shape) | `scanMry` now also runs for files with no same-file `#[mry::mry]` (alongside the mockall pass), binding the receiver var to the mocked type from the unambiguous constructors `Mock<Type>::default()` and `mry::new!(Type { … })` (`::new` is excluded — it collides with mockall's `MockFoo::new()`). `emitMryMock` falls back to the constructor binding when `typeTargets` has no entry. mry re-audit: **93 mocks (92 → 93, the crate_bound_consumer mock now detected), 0 issues**. Planted cross-crate probes (`MockFoo::default()` + `mry::new!`) fire DRIFT-003 on a `-> u32` mismatch |
| 74 | *(dogfood, django)* | `patch.multiple(Service, attr=…)` had **no member-drift surface**: the Python parser modeled methods only, so the one-call multi-member patch emitted a class-target mock with **zero stubs** (DRIFT-001 could not check the patched members) | model **class-level attributes** (`supports_async_task = True`, `ready: bool = False`) as `property` members, and emit **one stub per `patch.multiple` keyword** (the keyword values are patched attribute values, not return values — no DRIFT-003). DRIFT-001 now checks each patched member against the class's methods *and* attributes (a planted `nonexistent_attr` fires); attributes inherited from an unresolvable base stay protected by DRIFT-001's conservative `extendsIds` skip. django re-audit: **43 findings unchanged** (33 TAUT-001 + 10 TAUT-003); requests/flask 0 |
| 75 | *(dogfood, django)* | a bound `m = Mock(return_value=42)` then `assert m() == 42` was an **invisible mock-echo** (TAUT-002): the parser captured no creation-time `return_value` and `m()` (the mock's own `__call__`) was not recognized as a mock-config operand | capture a **literal** `return_value=`/`side_effect=` kwarg on a *bound* `Mock(...)`/`MagicMock(...)`/`AsyncMock(...)` (`valueIR`-defined only — `return_value=[]`/`some_obj` are skipped); recognize `m()` as a `mock-config` operand carrying the configured value; and mark `m()` as an invocation site (so `m = Mock(return_value=42); result = m()` is not a zero-reach stub). **Inline** `Mock(return_value=…)` (e.g. a `patch`'s positional `new` arg) is left unconfigured — its invocation is unobservable. django re-audit: **43 findings unchanged**; planted echo probe fires TAUT-002 while differing-value twins stay quiet |
| 76 | *(dogfood, mockers)* | the mockers library (`#[mocked] trait` / `mock! { Name, self, trait A { … } }` + `scenario.create_mock_for::<dyn T>()` returning `(mock, handle)` + `scenario.expect(handle.m(…).and_return(…))`) was **invisible** — a fresh `kriomant/mockers` clone (59 `.rs` files) audited as a **vacuous 0-mock** | added mockers detection (`MockFramework`/`MockPattern` `'mockers'`, IR schema 17) + tuple-pattern `bindings` serialization in the syn-wasm layer (`let (mock, handle) = …`). `create_mock_for::<dyn T>` / `create_named_mock_for::<dyn T>` / `create_mock::<XMock>` each emit a mock (target = the trait; `Mock`/`MockStatic` suffix stripped cross-crate); the tuple-destructured fake (element 0) and handle (element 1) bind the mock, `scenario.expect(handle.<m>(…).and_return(v))` attaches the stub + literal return, and `mock.<m>(…)` / pass-by-value marks it reached. Mock-specific `clone` stubs (`mock_clone!`/`derive(Clone)`) are filtered via the trait-method set, and multi-trait `mock!` mocks are untargeted (no single production type) — so the self-test fixtures stay honest. mockers re-audit: **151 mocks (23 files), 0 issues**. Also fixed a surfacing mry reachability gap: `Cat::meow(&cat, 2)` (trait-qualified/UFCS invocation) now marks the mock reached, closing a TAUT-005 on mry's `async_fn_trait_variant` (mry back to 0) |
| 77 | *(dogfood, mockiato)* | the mockiato library (`#[mockable] trait` + `XMock::new()`/`XMock::default()` + `x.expect_<m>(…).returns(…)`) was **invisible** — a fresh `mockiato/mockiato` clone (103 `.rs` files) audited as a **vacuous 0-mock** because it uses a *suffix* `Mock` naming convention (`GreeterMock`, not mockall's `MockGreeter` prefix), so the mockall pass never saw its constructors | added mockiato detection (`MockFramework`/`MockPattern` `'mockiato'`, IR schema 18, server enum + rust fence + contract scaffold + CLI help): `XMock::new()`/`XMock::default()` emit a mock (strip the `Mock` suffix → trait target), `x.expect_<m>(…)` attaches the stub (`_calls_in_order` stripped), `.returns(v)`/`.returns_once(v)` record a literal return, and `x.<m>(…)` marks it reached. mockiato re-audit: **48 mocks (23 files), 1 MOCK-002** (the `examples/downcasting.rs` example genuinely mocks its own `ObjectBehavior` — a true mock-of-self, INFO) |
| 78 | *(dogfood, mockiato)* | the syn-wasm serializer descended into block/unsafe bodies but **not control-flow bodies** (`for`/`while`/`loop`/`if`/`match` all fell into the catch-all `other` with no `stmts`), so a mock *invoked* inside a loop/branch was never marked reached — mockiato's `tests/sequential_calls.rs` (`for _ in 0..3 { assert!(mock.bar()); }`) false-flagged **TAUT-005 zero-reach-stub** | serialize `for`/`while`/`loop`/`if`/`match` bodies as runtime `stmts` (then+else branches, arm bodies), and make `?` transparent (`mock.foo()?` keeps its inner call). This is a general Rust-reachability fix benefiting every framework, not just mockiato. mockiato re-audit: **TAUT-005 gone → 0 warnings**; all other Rust baselines unchanged (mockall 0 err / 3 TAUT-005 + 2 MOCK-002, mry 93 mocks / 0, faux 55 / 1 MOCK-002, mockers 151 / 0) |
| 79 | *(dogfood, mocktopus)* | the mocktopus library (`#[mockable]` on fns/methods/impls + `foo.mock_safe(…)` / `foo.mock_raw(…)` replacing the *function itself* with a `MockResult::Return` closure) was **invisible** — a fresh `CodeSandwich/Mocktopus` clone (46 `.rs` files) audited as a **vacuous 0-mock** because its API has no `Mock::new()` constructor at all (the `mock_safe`/`mock_raw` call *is* the mock) | added mocktopus detection (`MockFramework`/`MockPattern` `'mocktopus'`, IR schema 19, server enum + rust fence + contract scaffold + CLI help): `foo.mock_safe(…)`/`foo.mock_raw(…)` emit one mock per call with the receiver's function/method name as an informational `unknown` target (bare fn, module-qualified `hello_world::world`, static `S::method`, and instance `s.method`). A mocked *function* has no member-drift surface and its invocation is indirect (the SUT calls it), so no stubs/return values are recorded — no false TAUT-005/DRIFT surface. mocktopus re-audit: **270 mocks (34 files), 0 issues** |
| 80 | *(dogfood, mock_derive)* | the mock_derive library (`#[mock]` on a trait/extern block + `MockX::new()` / `Extern<Abi>Mocks::method_<fn>()` + `method_<m>().set_result(…)`) was **detected but misattributed** — its `Mock<Name>` *prefix* collides with mockall's `MockFoo::new()`, so a fresh `DavidDeSimone/mock_derive` clone's 32 trait mocks read as `mockall`/`automock` (framework wrong, `set_result` returns unrecorded → DRIFT-003 dead) and its 6 `#[mock] extern` function mocks were **invisible** (the `extern "C" { … }` block wasn't serialized). Related: `#[mock] trait Derived : Base` exposed a **DRIFT-001 supertrait gap** — Rust trait inheritance wasn't modeled, so a mock stubbing an *inherited* method (`add` on `Derived`) false-flagged "missing member" | added mock_derive detection (`MockFramework`/`MockPattern` `'mock_derive'`, IR schema 20, server enum + rust fence + contract scaffold + CLI help): `#[mock] trait X` (incl. `#[cfg_attr(…, mock)]`) + `MockX::new()` emit a mock (the mockall pass skips `#[mock]`-declared constructors), `method_<m>()` attaches the stub, `.set_result(<literal>)` records a literal return, `mock.<m>()` marks it reached; `#[mock] extern` blocks serialize as `kind: extern` (abi + fn names) and emit one untargeted `Extern<Abi>Mocks` mock per fn. (Round 47 also records `.return_result_of(|| <scalar literal>)` — a single-scalar closure body — for DRIFT-003; a computed/block closure stays skipped.) And the Rust symbol index now populates `extendsIds` from `trait X : Y` supertraits (supertrait serialization in the wasm layer), so `membersOf` resolves inherited members (external supertraits stay a conservative DRIFT-001 skip). mock_derive re-audit: **38 mocks (32 trait + 6 extern), 2 TAUT + 7 MOCK-002** — the 2 TAUT are the example's genuine `assert_eq!(1,1)` self-comparison, and the 7 MOCK-002 are examples mocking their own same-file `#[mock]` trait (consistent with mockall's synchronization.rs, which is also flagged) |
| 81 | *(dogfood, galvanic-mock)* | the galvanic-mock library (`#[mockable]` + `#[use_mocks]` + `new_mock!(Trait)` + `given!`/`expect_interactions!` + `mock.method(…)`) was **invisible** — a fresh `mindblaze/galvanic-mock` clone (20 test `.rs` files) audited as a **vacuous 0-mock** because its API has no `Mock::new()` constructor or `mock_*`/`expect_*` config method (the `new_mock!` macro *is* the instantiation, and the `given!`/`expect_interactions!` DSL bodies are macro token streams opaque to syn) | added galvanic detection (`MockFramework`/`MockPattern` `'galvanic'`, IR schema 21, server enum + rust fence + contract scaffold + CLI help): `let mock = new_mock!(Trait)` emits one mock per instantiation with the trait as the target (generics `Trait<i32, f64, Assoc=String>`, explicit mock type `new_mock!(Trait for MyMock)`, referred `new_mock!(::sub1::sub2::EmptyTrait)`, and trailing `#[allow(…)]` mock attributes are all normalized to the trait name); `given!`/`expect_interactions!` record the `<mock as Trait>::method` stub names for DRIFT-001; `mock.method(…)` marks the mock reached. Return values are deliberately *not* recorded (the `then_return`/`then_return_from` values are closures/matchers inside the macro token stream) — no false TAUT-005/DRIFT-003. galvanic re-audit: **45 mocks (20 files), 0 issues**; a planted `nonexistent_method` stub fires DRIFT-001 end-to-end |

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
- **Status after the bounded reachability fix (row 55, IR schema 8): 11 → 5 warnings, 0 errors.**
  The fixed shapes were all real invocation patterns the walker missed, now covered and pinned by
  parser + rule tests:
  1. **UFCS / trait-qualified receivers** (`automock_impl_trait_for.rs:22`
     `<MockSomeStruct as Foo>::foo(&mock, 4)`; `automock_impl_generic_trait_for.rs:24`;
     `automock_trait_variant.rs:84` / `mock_trait_variant.rs:86` `Foo::foo(&mock)` under
     `block_on(…)`) — first-arg receiver calls on a bound mock now count as invocations.
  2. **`unsafe` blocks** (`mock_refmut_arguments.rs:45` — `unsafe { mock.bar(…) }` is
     execution-time code, not cfg-dead) — block/unsafe statements are now descended into.
  3. **`#[should_panic]` tests** (`automock_many_args.rs:30` `not_yet_satisfied`: configures
     `expect_foo().times(1)` and intentionally never invokes — the drop-time panic is the
     assertion) — TAUT-005 is suppressed inside should-panic tests (`TestFnIR.shouldPanic`).
- **Remaining 5 TAUT-005 warnings — the genuine zero-reach set, kept on purpose:**
  1. **cfg-gated compile-only tests** (`mock_cfg.rs:38,46,54,62` — `#[cfg(feature = "nightly")]`
     and its `not` twin configure `expect_foo()`/`expect_beez()` and never invoke them; the
     test only checks the proc-macro codegen compiles, and momus cannot evaluate `cfg` features).
  2. **A configured-but-unused mock in a real test** (`mock_struct.rs:125` `one_match` — a
     second mock `mock1` is configured with two `.with(eq(…))` expectations and never called;
     mockall's default times semantics make the test pass, so it is a textually-true
     zero-reach stub). These are warnings, never errors, and they are the honest boundary
     (docs/03 §3.3.1 TAUT-005): suppressing them would hide real dead config.
- **`mock!` DSL:** mockall's `mock!`/`#[automock]` are proc-macros, so `syn` sees the invocation,
  not the generated mock — the parser hand-models the `mock!` token stream and resolves the
  target trait from the crate graph (see crate spec). Verified against the full `tests/` corpus.
- **Static/associated/constructor context API (row 62, IR schema 12):** `MockFoo::baz_context()` +
  `ctx.expect().returning(...)` (83 sites across the corpus) was previously invisible — only
  `MockFoo::new()` emitted a mock, so static-only test files produced zero mocks. It now emits one
  mock per context with the static method as a stub, and reachability covers direct calls, UFCS,
  function-pointer references, and raw identifiers. Two honest new findings surfaced:
  1. **`examples/serde.rs` TAUT-005** — the inherent static mock `private_deserialize` is
     configured then invoked *indirectly* through `serde_json::from_str` (no direct call site), a
     static-analysis boundary (the mock is reached; momus cannot trace through library calls).
  2. **`examples/synchronization.rs` MOCK-002 ×2** — the `mockall_double` example mocks its own
     `Thing::one()` (declared in the same file), a true mock-of-self (INFO).

## 4e. Findings about `pallets/flask` (Python — second Python dogfood, parity round)

Cloned to `/tmp/flask-dogfood` (temp `.momusrc` → `{languages:{python:true}}`), full audit of
flask's own repo (**83 files, 3,000+ LOC of pytest tests**, src-layout package under `src/flask/`).

- **Baseline: 0 issues, 0 false positives** on 83 real files — the pyright-inference path (DRIFT-002/003
  on unannotated code), TAUT detection, and DRIFT-005 all stayed quiet on genuine, healthy tests.
- **Planted-probe verification** (throwaway test deleted after the run) proved every new rule fires
  end-to-end on the real repo: `patch('flask.sessions.NonexistentSessionAttr')` → DRIFT-005 error,
  `MagicMock()` + `assert_called_once()` with no stub → TAUT-006, `side_effect`-configured mock
  never invoked → TAUT-005, mock-only assertion → TAUT-004.
- **Real bug found (row 56):** the planted DRIFT-005 probe *didn't fire* before the fix — flask is
  **src-layout** (`src/flask/…`), and `resolvePythonImport` only searched ancestors of the test file
  for flat layouts, so `flask.sessions` never resolved and the module-target check silently
  degraded. `src/` is now probed at each ancestor; the planted probe fires (error), the healthy
  twin (`existing_attr`) is quiet, and both baselines (flask + httpx) re-audit at 0 issues.
  *Boundary:* third-party/venv targets stay unresolved (SYS-003) — the `src/` fallback is
  workspace-local by design.

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
    mock, the factory keys (`listChangedFiles`, `Server`, …) extract as    `mockFactoryKey` stubs, and
    MOCK-001 counts stay accurate (no double-counting, no false TAUT/DRIFT). Class-valued factory
    keys (`Server: class { … }`) also extract. Chaos re-audit unchanged (0 errors / 4 MOCK-001);
    Knossos unchanged (6 sentinel errors, all deliberate `assertSame(true, true)` markers).
28. ✅ Four-language parity dogfood (row 48): **mockall** re-audited after the Rust reachability
    fix (wrapper re-bindings + by-value consumption) — warnings dropped 16 → 11, the remaining 11
    are the 4 cfg-gated compile-only tests + 7 deeper UFCS/unsafe/multi-config patterns (documented
    static-analysis boundaries, §4d). **httpx** (shallow clone, mock-heavy pytest repo) audited
    with `languages.python: true` exercising the pyright `--createstub` inference: 60 files, **0
    issues** — the first-file parse (`httpx/__init__.py`) paid the one-time pyright cold start
    (3117ms vs the 2000ms single-file budget → a `SYS-004` note), memoized across the workspace so
    the total audit stayed 5647ms. This is the documented cost of subprocess inference (the
    in-process `pyright-internal` API is unpublished), not a regression. PHP/TS baselines (Knossos /
    Chaos) re-audited unchanged.
29. ✅ mockall third pass (row 55, IR schema 8): after the bounded reachability fix, **11 → 5**
    TAUT-005 warnings — 6 false positives cleared (UFCS/trait-qualified receivers ×4, `unsafe`-block
    descent ×1, `#[should_panic]` drop-panic assertion ×1) by serializer + walker upgrades
    (`Reference` referent, block/unsafe statements, qualified-path callees) and rule-level
    should-panic suppression (`TestFnIR.shouldPanic` + `MockIR.fnId`). The remaining 5 are the
    genuine set (4 cfg-gated compile-only + 1 configured-but-unused mock), kept as honest warnings.
30. ✅ flask dogfood (row 56): 83 files, **0 issues / 0 false positives** on real code; planted
    probes verified DRIFT-005/TAUT-004/005/006 fire end-to-end — and the DRIFT-005 probe exposed a
    real gap: **src-layout resolution** (`resolvePythonImport` never probed `src/`), now fixed with
    a per-ancestor `src/` fallback + fixtures + regression tests. flask + httpx re-audited at 0.
31. ✅ mockall fourth pass (rows 57, IR schema 10): **0 errors, TAUT-005 5 → 3** (2 cfg-gated
    compile-only + 1 configured-but-unused — all genuine), and the **2 DRIFT-003 false positives
    fixed** — generic-dependent return types (`V`, `<T as Foo>::Output`) now resolve through the
    symbol index with a conservative pass for unprovable names (mirrors PHP's class path). Also
    verified the batch's new Rust paths on fresh clones: **mockito** (137 mocks incl. the new
    `server.mock("GET", "/x")` method-call form, 0 issues) and **wiremock-rs** (19+ mocks incl.
    `.await` chains, 0 issues) — both healthy, no vacuous audits (mock counts verified per file).
32. ✅ requests dogfood (row 58): **3 DRIFT-005 errors + 3 MOCK-002 infos → 0 issues** — module-level
    import bindings (`import idna`, `from requests.compat import proxy_bypass`) are now real
    exports for DRIFT-005, and MOCK-002 no longer fires for attribute-level patches inside the
    SUT module. **requests (pytest, pyright inference on src-layout) is now a 0-issue baseline.**
    Contract-synthesis probe found row 59: `momus contract` now defaults `--framework` per target
    language (`.rs` → mockall, `.py` → pytest, `.php` → phpunit) so headers match the emitted
    body. Chaos (0 errors / 4 MOCK-001) and Knossos (6 sentinel errors) baselines unchanged;
    coverage 91.42 → 91.86% stmts / 83.82 → 84.13% branches / 95.96 → 96.16% funcs; **537 tests**.
33. ✅ mockall MOCK false positives closed (row 60): the 4th-pass re-audit surfaced **60 MOCK-001 +
    133 MOCK-002** that the documented "0 errors / 3 TAUT-005" baseline had missed. Root cause:
    mockall's integration tests declare a fixture `trait Foo`/`struct Bar` **inside each test file**
    just to exercise the macros, then mock it — not a production dependency, not a subject. MOCK-001/
    MOCK-002 now skip same-file fixtures, and `recordMockMacro` parses `where`-clause generics.
    mockall back to **0 errors / 3 TAUT-005**; mockito (0), wiremock-rs (0), requests (0) unchanged.
34. ✅ httpmock crate dogfooded (row 61, IR schema 11): fresh clone (`alexliesenfeld/httpmock`, 73
    `.rs` files) exposed a **vacuous audit** — its `server.mock(|when, then| { … })` closure API was
    undetected (0 mocks). httpmock detection added across the Rust parser, IR unions, CLI help, and
    the MCP server (enum + rust fence + contract scaffold). Re-audit: **43 mocks, 0 issues**. Gate:
    **543 tests** (537 → 543), typecheck/lint/format clean, self-audit clean.
35. ✅ mockall static-context detection (row 62, IR schema 12): `MockFoo::baz_context()` /
    `mock_foo::bar_context()` / `MockA::new_context()` — **83 patterns, previously 0 mocks** — now
    emit one mock per context with the static method as a stub and `ctx.expect().returning/return_const`
    return values. Reachability covers direct calls, UFCS, function pointers, and raw identifiers.
    The richer extraction surfaced two honest new findings on the re-audit: **serde.rs** TAUT-005
    (an inherent static mock `private_deserialize` invoked indirectly through `serde_json::from_str` —
    a documented static-analysis boundary; the mock *is* reached) and **synchronization.rs** MOCK-002
    ×2 (the `mockall_double` example mocks its own `Thing` — a true mock-of-self, INFO). mockall
    baseline: **0 errors / 4 TAUT-005 (3 genuine + 1 serde boundary) + 2 MOCK-002**. mockito /
    wiremock-rs / httpmock / requests baselines unchanged; **549 tests** (543 → 549).
37. ✅ mry crate dogfooded (rows 65–66, IR schema 14): a fresh `mitsuhiko/mry` clone (52 `.rs` files,
    workspace `mry` + `mry_macros`) exposed two real gaps. **(1) `.gitignore` negation was dropped**
    by `discoverFiles` — mry's workspace root uses the standard Rust "ignore all, then whitelist"
    convention (`*` / `!*/` / `!*.rs` / `!Cargo.toml`), so the whole workspace was ignored (**0
    modules**). `.gitignore` is now parsed with proper negation/dir-only/anchored/ancestor semantics.
    **(2) mry's mock API was invisible** (`#[mry::mry]` + `mock_<method>(…).returns(…)`) — a vacuous
    0-mock audit. mry detection added (instance/static/`Mock<T>`/free-function forms; mry files skip
    the mockall pass since their generated `Mock<Type>` collides with `MockFoo::new()`). Re-audit:
    **72 mocks, 0 issues**, non-vacuous. All other baselines unchanged (mockall 0 err / 3 TAUT-005 +
    2 MOCK-002; mockito/wiremock-rs/httpmock/requests/flask = 0; Chaos 0 err / 4 MOCK-001; Knossos
    6 sentinels). Gate: **558 tests** (552 → 558), typecheck/lint/format clean, coverage 91.86% stmts /
    84.46% branches / 96.29% funcs.
36. ✅ mockall 5th pass + django dogfood (rows 63–64): (1) captured mockall's one-shot/non-Send
    `return_once`/`return_once_st`/`returning_st` variants (DRIFT-003 now sees them); (2) closed the
    serde.rs TAUT-005 boundary from round 35 — inherent/module static mocks (no resolvable target)
    skip return-value recording, so TAUT-005 no longer false-flags a mock invoked through the SUT's
    own impl (which the parser never serializes). **mockall back to 0 errors / 3 TAUT-005 + 2
    MOCK-002.** (3) **`patch.multiple` dogfooded on a fresh django sparse clone**: the one-call
    multi-member patch was invisible (0 mocks); now emitted as a class-target mock, with member-level
    drift deliberately deferred (patches class attributes, which the Python parser doesn't model).
    django `tests/tasks` + `tests/apps` re-audit: **0 issues**, detection non-vacuous. mockito /
    wiremock-rs / httpmock / requests / flask baselines unchanged; **552 tests** (549 → 552).
38. ✅ faux + mry::m! + django full-suite dogfood (rows 67–69, IR schema 15): **(1)** the faux mock
    library (`#[faux::create]` + `Foo::faux()` + `faux::when!(mock.method).then(…)`) was invisible —
    a fresh `nrxus/faux` clone (36 `.rs` files) audited vacuous (0 mocks). faux detection added
    (instance + `path`-qualified constructors; config verbs `then`/`then_return`/`then_unchecked`;
    returns not recorded — closures + `assert_eq!` macro invocations). Re-audit: **55 mocks, 1
    MOCK-002** (genuine mock-of-self in `testable-renderer`). **(2)** mry's `mry::m! { … }`
    function-style macro form was undetected, and impl owners kept their module path
    (`selfType.text` → `foo::Foo`) so path-qualified `#[faux::methods(path = "crate")]` impls
    false-flagged DRIFT-001; `symbols.ts` now uses `selfType.name`. mry re-audit: **92 mocks, 0
    issues**. **(3)** a full django `tests/` clone (2005 `.py` files) exposed **90 TAUT-005 false
    positives** from indirect `patch`/`patch.object` invocation; TAUT-005 now skips patch-pattern
    mocks. django re-audit: **90 → 1 TAUT-005** (autospec-via-`return_value` boundary), remaining
    buckets honest (TAUT-001 self-compares, TAUT-003 intentional fail-fixtures, TAUT-004/006 blocked
    on Python `hasProductionCalls`, DRIFT-001 blocked on inheritance). All Rust/Python/TS baselines
    unchanged (mockall 0 err / 3 TAUT-005 + 2 MOCK-002; mockito/wiremock-rs/httpmock/mry/requests/
    flask = 0; Chaos 0 err / 4 MOCK-001). Gate: **565 tests** (563 → 565), typecheck/lint/format
    clean, coverage 91.73% stmts / 84.56% branches / 96.33% funcs.
39. ✅ Python `hasProductionCalls` dogfooded (row 70): the django full-suite's **25 TAUT-004/006 false
    positives** traced to `extractTestFunctions` hardcoding `hasProductionCalls: false` — the TS
    `productionCalls` dataflow pass had no Python analogue. Now each Python test function counts calls
    whose root is a module-level import from a non-framework module (framework = `unittest`/`mock`/
    `pytest*`/`django.test*`; production = `django.*`, stdlib `copy`/`datetime`/`ctypes`, …), with
    mock-binding shadowing resolved first. TAUT-006 gains a **Python-scoped** suppression for unreached
    spies in production-exercising tests (Python reachability can't see `return_value=`/SUT-mediated
    invocation; TS/PHP/Rust keep the strict `invocationSites` signal — the golden fixture's planted TS
    TAUT-006 still fires). django re-audit: **TAUT-004 21 + TAUT-006 4 → 0**; remaining findings are the
    honest set (TAUT-001 self-compares 33, TAUT-003 intentional fail-fixtures 10, DRIFT-001 inherited
    `_pre_setup`/`_post_teardown` 2, TAUT-005 autospec-`return_value` boundary 1). requests (35 files) +
    flask (83 files) baselines unchanged at 0 issues. Gate: **572 tests** (565 → 572), typecheck/lint/
    format clean, self-audit CLEAN, coverage 91.77% stmts / 84.63% branches / 96.33% funcs.
40. ✅ Python detection hardening (row 71, IR schema 16): four gaps closed, django **46 → 43 findings** —
    only the honest set remains. **(1) tree-sitter node-identity bug** — `bindingNameFor` compared
    `childField(parent,'right') === call`, but `childForFieldName` returns a fresh wrapper for the same
    node, so mock binding silently no-oped on large files (empty `bindings` map → broken
    `resolveMockName`, positional hand-off reachability, and `m.member.return_value = X` capture;
    same bug in `importFrom`). Now compares node `.id`. **(2) `return_value=`/`side_effect=` kwarg
    hand-off** — a mock injected via a patch's `return_value=m` is marked reached, closing the
    last django TAUT-005 (`test_sqlcompiler.py` `cursor`). **(3) `patch.dict` detection** — new
    `patch-dict` pattern (module target, 49 django usages; TAUT-005 skips it). **(4) inheritance** —
    `extendsIds` populated from `superclasses` + DRIFT-001 conservative skip for unresolvable bases,
    closing the 2 django DRIFT-001 (`_pre_setup`/`_post_teardown` inherited from `unittest.TestCase`).
    Baselines: requests (37 files) 0, flask (83 files) 0, Chaos 0 err / 4 MOCK-001, Knossos 6 sentinels.
    Gate: **577 tests** (572 → 577), typecheck/lint/format clean, self-audit CLEAN, coverage 91.81%
    stmts / 84.52% branches / 96.34% funcs.
41. ✅ mry/faux return-value recording (row 72): the deferred DRIFT-003 surface is restored for both
    frameworks. `faux::when!(…).then_return(42)` and `mry.mock_<method>(…).returns(42)` /
    `returns("…")` now record a **literal** return value on the stub; closure/`.to_string()` returns
    stay unrecorded (`literalType` → `unknown`). Both mry emitters + the faux stub creation return
    the mock so the config verb attaches its value. **Non-vacuous** (planted probes fire DRIFT-003 on
    fresh clones). Re-audits unchanged and honest: faux **55 mocks / 1 MOCK-002** (13 DRIFT-003-checked),
    mry **92 mocks / 0 issues** (12 DRIFT-003-checked), mockall 0 err / 3 TAUT-005 + 2 MOCK-002
    (re-cloned, unchanged). Boundary documented: mry's `mock_<method>` carries no embedded type, so
    cross-file (`src/` → `tests/`) mocks audit vacuously. Gate: **579 tests** (577 → 579),
    typecheck/lint/format clean, self-audit CLEAN, coverage 91.82% stmts / 84.53% branches /
    96.34% funcs.
42. ✅ Three hardening follow-ups (rows 73–75): **(1) mry cross-crate detection** — `scanMry` now runs
    for files with no same-file `#[mry::mry]` (alongside mockall), binding receiver vars from
    `Mock<Type>::default()` / `mry::new!(Type { … })`; mry re-audit **92 → 93 mocks** (the
    `crate_bound_consumer` cross-crate mock now detected), 0 issues, planted cross-crate probes fire
    DRIFT-003. **(2) Python class-attribute modeling** — class-level attributes become `property`
    members and `patch.multiple` emits one stub per keyword, so DRIFT-001 checks patched members
    against the class (planted `nonexistent_attr` fires); django 43 unchanged. **(3) Python
    `Mock(return_value=…)` TAUT-002** — a bound `m = Mock(return_value=42)` captures a literal kwarg,
    `m()` is a mock-config operand, and `m()` marks the mock reached; planted echo fires TAUT-002,
    django 43 unchanged. Baselines: mockall 0 err / 3 TAUT-005 + 2 MOCK-002, faux 55 mocks / 1
    MOCK-002, Chaos 0 err / 4 MOCK-001, Knossos 6 sentinels, requests/flask 0. Gate: **585 tests**
    (579 → 585), typecheck/lint/format clean, self-audit CLEAN, coverage 91.95% stmts / 84.69%
    branches / 96.37% funcs.
43. ✅ mockers detection + mry trait-qualified reachability (row 76, IR schema 17): a fresh
    `kriomant/mockers` clone (59 `.rs` files, workspace `mockers` + `mockers_derive`) audited as a
    **vacuous 0-mock** — its `Scenario::create_mock_for::<dyn T>()` → `(mock, handle)` +
    `scenario.expect(handle.m(…).and_return(…))` API was unmodeled. Added mockers detection
    (`MockFramework`/`MockPattern` `'mockers'`, IR schema 17, server enum + rust fence + contract
    scaffold + CLI help) and **tuple-pattern binding serialization** in the syn-wasm layer (new
    `bindings` field on `let (mock, handle) = …`). `create_mock_for`/`create_named_mock_for`/
    `create_mock` emit mocks (trait target, `Mock`/`MockStatic` suffix stripped cross-crate); the
    fake/handle tuple binds the mock; `scenario.expect(handle.<m>(…).and_return(v))` attaches stubs +
    literal returns; `mock.<m>(…)` and pass-by-value mark it reached. Mock-specific `clone` stubs
    (`mock_clone!`/`derive(Clone)`) filtered via the trait-method set, multi-trait `mock!` untargeted.
    mockers re-audit: **151 mocks (23 files), 0 issues**. The re-audit also surfaced a pre-existing
    mry reachability gap (`async_fn_trait_variant` TAUT-005): `Cat::meow(&cat, 2)` (trait-qualified
    invocation) now marks the mock reached — mry back to **0 issues**. Baselines unchanged: mockall
    0 err / 3 TAUT-005 + 2 MOCK-002, mry 93 mocks / 0, faux 55 mocks / 1 MOCK-002, django 43,
    requests/flask/drf 0, Chaos 0 err / 4 MOCK-001, Knossos 6 sentinels. Gate: **595 tests**
    (585 → 595), typecheck/lint/format clean, self-audit CLEAN, coverage 91.98% stmts / 84.64%
    branches / 96.46% funcs.
44. ✅ mockiato detection + control-flow reachability (rows 77–78, IR schema 18): a fresh
    `mockiato/mockiato` clone (103 `.rs` files, workspace `mockiato` + `mockiato-compiletest`)
    audited as a **vacuous 0-mock** — its `#[mockable]` + `XMock::new()` (suffix `Mock`, not
    mockall's `MockX` prefix) + `x.expect_<m>(…).returns(v)` API was unmodeled. Added mockiato
    detection (`MockFramework`/`MockPattern` `'mockiato'`, IR schema 18, server enum + rust fence +
    contract scaffold + CLI help): `XMock::new()`/`XMock::default()` emit mocks (strip `Mock` →
    trait), `expect_<m>` attaches stubs (`_calls_in_order` stripped), `.returns`/`.returns_once`
    record literal returns, `x.<m>(…)` marks reached. mockiato re-audit: **48 mocks (23 files),
    1 MOCK-002** (the downcasting example genuinely mocks its own `ObjectBehavior` — INFO). The
    re-audit also exposed a **general Rust reachability gap**: the syn-wasm serializer only descended
    into block/unsafe bodies, so `for`/`while`/`loop`/`if`/`match` bodies were opaque — a mock
    invoked inside a loop (`sequential_calls.rs`) false-flagged TAUT-005. Now those bodies serialize
    as runtime `stmts` (then+else + arm bodies) and `?` is transparent. mockiato re-audit: **TAUT-005
    gone → 0 warnings**; all other Rust baselines unchanged (mockall 0 err / 3 TAUT-005 + 2 MOCK-002,
    mry 93 mocks / 0, faux 55 / 1 MOCK-002, mockers 151 / 0). Also verified: Python instance
    attributes (`self.x = …` in `__init__`) are **already modeled** as `property` members (round 42
    added `instanceAttributes`; the `patch.object` DRIFT-001 test exists) — no work needed; and
    mockers' static-vs-instance mock distinction (`FooMockStatic` vs `FooMock`) has **no observable
    effect** (both resolve to the trait; static-vs-instance misuse is a compile error in mockers) —
    deferred. Gate: **600 tests** (595 → 600), typecheck/lint/format clean, self-audit CLEAN,
    coverage 91.89% stmts / 84.71% branches / 96.48% funcs.
45. ✅ mocktopus detection (row 79, IR schema 19): a fresh `CodeSandwich/Mocktopus` clone
    (46 `.rs` files) audited as a **vacuous 0-mock** — its `#[mockable]` + `foo.mock_safe(…)` /
    `foo.mock_raw(…)` API has no `Mock::new()` constructor (the call *is* the mock), so none of the
    existing passes saw it. Added mocktopus detection (`MockFramework`/`MockPattern` `'mocktopus'`,
    IR schema 19, server enum + rust fence + contract scaffold + CLI help): each
    `foo.mock_safe/mock_raw` emits a mock with the receiver's function/method name as an
    informational `unknown` target (bare, module-qualified, static, and instance forms). A mocked
    function has no member-drift surface and its invocation is indirect, so stubs/returns are not
    recorded. mocktopus re-audit: **270 mocks (34 files), 0 issues** — non-vacuous. Also verified the
    mry `Mock<T>::new(…)` cross-crate disambiguation was **already done** in round 42 (the
    `hasMryMockCalls` signal skips the mockall pass and `mryConstructorType` claims `::new`; the
    test exists) — removed from the candidate list. Baselines unchanged: mockall 0 err / 3 TAUT-005
    + 2 MOCK-002, mry 93 mocks / 0, faux 55 / 1 MOCK-002, mockers 151 / 0, mockiato 48 / 1 MOCK-002,
    drf 41 mocks / 0. Gate: **603 tests** (600 → 603), typecheck/lint/format clean, self-audit CLEAN,
    coverage 91.75% stmts / 84.76% branches / 96.51% funcs.
46. ✅ mock_derive detection + Rust supertrait inheritance (row 80, IR schema 20): a fresh
    `DavidDeSimone/mock_derive` clone (12 `.rs` files) was **detected but misattributed** — its
    `#[mock] trait X` + `MockX::new()` API collides with mockall's `MockFoo::new()` prefix, so all 32
    trait mocks read as `mockall`/`automock` and the 6 `#[mock] extern` function mocks were
    **invisible**. Added mock_derive detection (`MockFramework`/`MockPattern` `'mock_derive'`, IR
    schema 20, server enum + rust fence + contract scaffold + CLI help + `#[mock] extern` ForeignMod
    serialization in the syn-wasm layer): `#[mock] trait X` (incl. `#[cfg_attr(…, mock)]`) +
    `MockX::new()` emit a mock (target = the trait; the mockall pass skips `#[mock]`-declared
    constructors), `method_<m>()` attaches the stub, `.set_result(<literal>)` records a literal
    return (DRIFT-003), and `mock.<m>()` marks it reached; `#[mock] extern` blocks emit one
    untargeted `Extern<Abi>Mocks` mock per foreign fn. mock_derive re-audit: **38 mocks (32 trait + 6
    extern), 2 TAUT + 7 MOCK-002** — the 2 TAUT are the example's genuine `assert_eq!(1,1)`
    self-comparison, and the 7 MOCK-002 are examples mocking their own same-file `#[mock]` trait
    (consistent with mockall's synchronization.rs). Also closed a surfaced **DRIFT-001 supertrait
    gap**: `trait Derived : Base` now populates `extendsIds` in the Rust symbol index (supertrait
    serialization in the wasm layer), so a mock stubbing an *inherited* method no longer false-flags
    "missing member" (mock_derive's `advanced_traits.rs` `add`). Baselines unchanged: mockall 0 err /
    3 TAUT-005 + 2 MOCK-002, mry 93 mocks / 0, faux 55 / 1 MOCK-002, mockers 151 / 0, mockiato 48 / 1
    MOCK-002, mocktopus 270 / 0, Chaos 0 err / 4 MOCK-001, Knossos 6 sentinels. Gate: **610 tests**
    (603 → 610), typecheck/lint/format clean, self-audit CLEAN, coverage 91.49% stmts / 84.85%
    branches / 96.54% funcs.
47. ✅ mock_derive `return_result_of` + galvanic-mock detection (rows 80–81, IR schema 21): (1) the
    mock_derive `return_result_of(|| …)` form (from round 46's remaining candidates) now records a
    literal return for DRIFT-003 when the closure body is a single scalar literal (`return_result_of(|| 10)`);
    a computed/block closure stays skipped (no comparable literal). (2) A fresh `mindblaze/galvanic-mock` clone
    (20 test `.rs` files) was **invisible** — its `#[mockable]`/`#[use_mocks]` + `new_mock!(Trait)` +
    `given!`/`expect_interactions!` + `mock.method(…)` API has no `Mock::new()` constructor or
    `mock_*`/`expect_*` config method, so it audited as a vacuous 0-mock. Added galvanic detection
    (`MockFramework`/`MockPattern` `'galvanic'`, IR schema 21, server enum + rust fence + contract
    scaffold + CLI help): `let mock = new_mock!(Trait)` emits one mock with the trait as the target
    (generics, `for MyMock` explicit name, `::path` referred trait, and trailing mock `#[allow]`
    attributes all normalized), `given!`/`expect_interactions!` record the `<mock as Trait>::method`
    stub names for DRIFT-001, and `mock.method(…)` marks the mock reached. Return values are
    deliberately not recorded (closure/matcher `then_return*` values in the opaque macro DSL).
    galvanic re-audit: **45 mocks (20 files), 0 issues**; a planted `nonexistent_method` stub fires
    DRIFT-001. Baselines unchanged: mockall 0 err / 3 TAUT-005 + 2 MOCK-002, mry 93 / 0, faux 55 / 1
    MOCK-002, mockers 151 / 0, mockiato 48 / 1 MOCK-002, mocktopus 270 / 0, mock_derive 38 mocks / 2
    TAUT + 7 MOCK-002, Chaos 0 err / 4 MOCK-001, Knossos 6 sentinels. Gate: **617 tests** (610 →
    617), typecheck/lint/format clean, self-audit CLEAN, coverage 91.62% stmts / 85.21% branches /
    96.57% funcs.

48. **mocktopus literal and function drift resolution (dogfood + mocktopus):** two gaps were closed for mocktopus modeling. (1) **Mocktopus literal return extraction:** `syn-wasm` treats closures as opaque `other` nodes, so `MockResult::Return("val")` inside `.mock_safe(|| ...)` was previously unrecorded. The parser now regex-matches the text of closure nodes to extract literal mocktopus returns. (2) **Function drift resolution:** `DRIFT-003` was failing to resolve mocked local functions (like `global_fetch`) because the symbol index query only checked the global index; it now falls back to `module.symbols` when `index.getSymbol` fails. Mocktopus mocks are now correctly analyzed for return-type drift (`DRIFT-003`) and zero-reach stubs (`TAUT-005`). Planted drift in a new `mocktopus_test.rs` fixture fires exactly as expected. Baselines: mockall 0 err / 3 TAUT-005 + 2 MOCK-002, mry 93 mocks / 0, faux 55 / 1 MOCK-002, mockers 151 / 0, mockiato 48 / 1 MOCK-002, mocktopus 270 / 0 (checked), mock_derive 38 mocks / 2 TAUT + 7 MOCK-002, galvanic 45 mocks / 0, Chaos 0 err / 4 MOCK-001, Knossos 6 sentinels. Gate: **617 tests**, typecheck/lint/format clean, self-audit CLEAN, coverage 91.60% stmts / 85.19% branches / 96.55% funcs.

49. **Argos-MCP dogfood round (21 false positives fixed):** dogfooding against a fresh `Argos-MCP` (58 audited TypeScript files) surfaced 21 false positives. Closed all three gaps: (1) `DRIFT-001` missing member for inline types (e.g. `const logger = internals.logger as { debug: jest.Mock }`) fixed by checking `!targetSym` to skip unresolvable `__type` literals, (2) `TAUT-004` mock-only-assertion for direct `new` calls inside local helpers fixed by explicitly branching on `ts.isNewExpression(n)` within `dataflow.ts`'s recursive visit, (3) `TAUT-005`/`TAUT-006` unconfigured spy and zero-reach stubs for mock objects handed off as SUT injectables (via `mockReturnValue(mockObj)`) fixed by removing the strict `!isConfigCall` guard in reachability analysis. Argos-MCP re-audit: **21 warnings → 0 issues**. Gate: **617 tests**, typecheck/lint/format clean, self-audit CLEAN.
    **Correction (round 50):** that "0 issues" was measured against a stale `.momus/cache/modules.sqlite`
    — `IR_SCHEMA_VERSION` was not bumped with the parser changes, so the re-audit was served the
    pre-fix IR. With the cache cleared the same tree still reported **19 warnings**; only the
    `TAUT-004` half of the claim held. See round 50 for what the remaining 19 actually were.


50. **Chaos + Knossos + Argos sweep (29 findings → 0, on a fresh branch each):** a full re-audit of
    all three AraneaDev repos with the IR caches cleared. Baseline: Argos 19 warnings, Knossos 6
    errors, Chaos 4 warnings. **Three real test defects, 25 Momus false positives, one Momus
    correctness bug.**
    - **Knossos (3 real defects, fixed in the repo):** `tests/phpunit/Cli/CliHelpersTest.php` held
      three `assertSame(true, true)` sentinels that TAUT-001 + TAUT-003 both flagged. Two claimed
      the SUT's output "cannot be captured": `CliCommandContext::output()` in fact `echo`s, so
      `ob_start()` captures it (both the text and the JSON branch are now asserted), and
      `CliHelpRenderer::render()` `fwrite`s to STDOUT, so it got the same injectable-stream
      treatment `CliErrorRenderer` already had and its help text is now asserted. The third was a
      `pcntl`-missing guard that asserted a sentinel instead of skipping; it now calls
      `markTestSkipped`. Knossos re-audit: **6 errors → 0**, suite green (2212 tests).
    - **Argos (19/19 false positives, no repo change):** 15 × TAUT-006 and 3 × TAUT-005 came from
      one root cause — `invocationSites` proves a spy *was* reached but never that it was not, and
      Argos injects doubles into the SUT rather than calling them by name. The clearest case is
      `jest.spyOn(connectionManager, 'emit')` followed by `connectionManager.initialize(cfg)`: the
      spy is on the real subject and the real subject is invoked, yet no site records `emit`.
      TAUT-006's Python-only "unobservable indirect path" suppression is now language-neutral
      (`fn.hasProductionCalls`), keeping the rule's real target — a spy asserted by a test that
      runs no production code at all. TAUT-005 gained two hand-off forms: a mock **installed onto
      another object** (`pm.findAvailablePort = jest.fn().mockRejectedValue(e)`) and a double
      handed to production as a configured return value (`spyOn(cm, 'createAdapter')
      .mockReturnValue(adapter)`, which also reaches every spy on `adapter` — the old
      `isConfigCall` text regex never matched a callee with a parenthesised receiver). The
      remaining 2 × TAUT-004 were already fixed by round 49 and only looked open because of the
      stale cache. Argos re-audit: **19 warnings → 0**, zero changes to Argos.
    - **Chaos (1 false positive fixed in Momus, 3 suppressed with cause):** `MOCK-001` on
      `triage-discover-targets.test.ts` claimed "1 production-provenance assertion" for a file with
      27 assertions on real `resolveTriageTargets` output. Two provenance gaps: the SUT arrives via
      `const { resolveTriageTargets } = await import(…)` (a dynamic import, so not in
      `importedNames`), and the assertions read `await run({…})`, a local wrapper. Both are now
      traced — dynamic-import bindings are production roots, and `provenance` looks through a local
      helper the same way `productionCalls` already did. **Only the source kind carries through,
      never `constant`/`literal`**: the first cut inherited constant-ness and a helper whose single
      return is `null` turned 13 healthy `expect(firstError(x)).toContain('msg')` assertions into
      TAUT-003 constant-tautology errors. A helper now qualifies only when exactly one `return`
      carries a value. Operands: 1 production → 29. The other three MOCK-001 findings are true by
      the rule's own definition (composition-root and interaction tests that mock every
      collaborator on purpose) and carry `// @momus-ignore-file:MOCK-001` with the reason; the
      audit reports them as `suppressed: 3`, not as clean. Chaos re-audit: **4 warnings → 0 (3
      suppressed)**, suite green (3324 tests).
    - **New suppression form:** `// @momus-ignore-file:RULE[,RULE]`. A file-scoped finding is
      reported at 1:1, so no line comment can precede it — before this, MOCK-001 could only be
      silenced by the blunt bare banner or a repo-wide severity override.
    - **Momus correctness bug (the reason round 49 over-reported):** `IR_SCHEMA_VERSION` is the only
      thing that invalidates `.momus/cache/modules.sqlite` across a parser change, and it is bumped
      by hand. Three repos were carrying caches written by a pre-fix parser, so every audit in this
      session was wrong until they were cleared. Bumped to 23. **Any dogfood measurement must clear
      the cache or bump the schema first** — a stale cache reads exactly like a fix that worked.
    - Also fixed while running the gate: the in-flight mocktopus literal extractor emitted
      `{ kind: 'boolean' | 'number' | 'string' }` nodes, which are not `TypeIR` and would never have
      reached DRIFT-003's assignability check; it now emits the `{ kind: 'literal', value }` shape
      the rest of the Rust parser produces, with the string delimiters stripped.
    Gate: **626 tests** (617 → 626), typecheck/lint/format clean, self-audit CLEAN.

51. **Re-verification round on our own MCPs, plus a Rust target (`termaxa`):** re-audited every
    dogfood repo at v0.0.10 with the IR caches cleared, and added `termaxa` (29 `.rs` files) to
    cover a Rust codebase that is not itself a mock library. Result: **Chaos 0 (3 suppressed) ·
    Knossos 0 · Argos 0 · Momus self 0 · termaxa 0.**
    - **termaxa's clean result was checked for vacuity before being believed.** `indexStats`
      reported `mocks: 0`, which is the same signature as the galvanic round 47 failure where a
      whole framework was invisible and the audit passed by seeing nothing. Here it is honest:
      termaxa uses no mock library at all, so there are no doubles to check. Confirmed by
      planting a `assert_eq!(value, value)` / `assert_eq!(1, 1)` probe in `tests/`, which fired
      TAUT-001 ×2 + TAUT-003 as expected, then removing it. **A zero on a repo Momus has never
      seen before means nothing until a planted probe proves the pipeline is live on it.**
    - **Momus bug found by running the tool through its own MCP server** (`audit_workspace` over
      stdio, rather than the CLI): the call answered `attempt to write a readonly database` and
      produced no audit. The parse cache is documented as advisory — "a corrupt or mismatched
      entry is always treated as a miss and recomputed, never a correctness hazard" — but only
      JSON corruption was guarded; any sqlite-level failure propagated out as a tool error. The
      trigger was ordinary: `.momus/` had been deleted while a long-lived server still held the
      handle open, which is what a cache-clearing dogfood run does to an editor's live server.
      `get`/`put`/`close`/`openParseCache` now all degrade, and the docblock says what the code
      does. **An optimization that can fail the thing it optimizes is not advisory.**
    - The fix's own test caught a second trap: the first draft blocked the cache directory with
      `chmod 0o500`, which proves nothing because the suite runs as root and root bypasses
      permission bits. It now blocks the path with a *file*, which fails for every uid.
    Gate: **655 tests** (652 → 655), typecheck/lint/format clean, self-audit CLEAN.
