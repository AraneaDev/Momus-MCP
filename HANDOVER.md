# Momus-MCP — Session Handover

**Date:** 2026-08-18 · **State:** Phases 1–3 built & green; Phase 4 release scaffolding in-repo; **four language families at parity — TypeScript/PHP/Python/Rust** (shared 14-rule catalog, pyright `--createstub` inference for unannotated Python DRIFT-002/003, cross-language MOCK-002/DRIFT-005/TAUT-006, 4-language `synthesize_mock_contract`; Rust TAUT-005 reachability closed to 3 genuine warnings, httpmock/mry/faux/mockers/mockiato/mocktopus/mock_derive/galvanic crate detection + `.gitignore` negation support + mockall `_context()`/`return_once` handling + mry/faux literal return-value recording restores DRIFT-003 surface + mry cross-crate detection via `Mock<T>::default()`/`mry::new!` constructor binding + mry trait-qualified invocation reachability (`Cat::meow(&cat, 2)` marks the mock reached) + Rust control-flow body descent (`for`/`while`/`loop`/`if`/`match` bodies walk mocks inside them) + Rust trait supertrait inheritance (`trait X : Y` → `extendsIds` closes inherited-member DRIFT-001 false flags); Python `patch.multiple` detection + src-layout DRIFT-005 resolution + TAUT-005 skips indirect `patch`/`patch.object` + `hasProductionCalls` from non-framework imports closes django TAUT-004/006 + `patch.dict` detection + tree-sitter node-identity binding fix + `extendsIds` inheritance closes django DRIFT-001/TAUT-005 + class-attribute modeling enables `patch.multiple` member drift + bound `Mock(return_value=…)` kwarg capture enables TAUT-002 echo), 7 packages lockstep at 0.0.7 — release-please, persistent IR cache, ESLint+Prettier, coverage tooling — full gate green (626 tests), typecheck/lint/format clean, self-audit clean. Agent-tool-surface spec (`docs/superpowers/specs/2026-08-18-agent-tool-surface-design.md`) written, awaiting plan+implementation.
**Next session: keep the hardening loop — dogfood rounds on the four language families (mockito/wiremock-rs/httpmock/requests/flask/django/mry/faux/mockers/mockiato/mocktopus/mock_derive/drf baselines are verified; mockall 0 errors / 3 genuine TAUT-005 + 2 MOCK-002; mry 93 mocks / 0 issues, 13 now DRIFT-003-checked incl. the cross-crate `crate_bound_consumer` mock; faux 55 mocks / 1 genuine MOCK-002, 13 DRIFT-003-checked; mockers 151 mocks / 0 issues; mockiato 48 mocks / 1 genuine MOCK-002; mocktopus 270 mocks / 0 issues; mock_derive 38 mocks (32 trait + 6 extern) / 2 genuine TAUT (`assert_eq!(1,1)`) + 7 MOCK-002 (examples mocking their own same-file `#[mock]` trait — consistent with mockall's synchronization.rs; `.return_result_of(|| <scalar literal>)` now records DRIFT-003 returns); galvanic 45 mocks / 0 issues; django 43 honest findings — 33 TAUT-001 `assertEqual(x,x)` self-compares + 10 TAUT-003 intentional fail-fixtures; drf 41 mocks / 0 issues). Remaining candidates: mockers static-method mocks (`FooMockStatic` vs instance `FooMock` — no observable effect today, deferred), more unseen Rust mock libs (e.g. `dbl`), richer mocktopus modeling (record `MockResult::Return` literals + resolve a cross-module function to its production symbol for MOCK-001/002), and keep raising coverage. (Python instance-attribute `self.x = …` modeling is already done — round 42; mry `Mock<T>::new(…)` cross-crate disambiguation is already done — round 42.)**

## Current checkpoint — 2026-08-18

- **Last verified (round 50, three-repo sweep: Chaos + Knossos + Argos):** re-audited all three
  AraneaDev repos with the IR caches cleared — 29 findings, of which **3 were real test defects and
  25 were Momus false positives**, plus **one Momus correctness bug that invalidated round 49's
  measurement**. (a) `IR_SCHEMA_VERSION` is the only thing invalidating `.momus/cache/modules.sqlite`
  across a parser change and it is bumped by hand; all three repos carried caches written by a
  pre-fix parser, so round 49's "Argos 21 → 0" was measured against stale IR (cleared, the same tree
  still reported 19). Bumped to **23**. **Clear the cache or bump the schema before any dogfood
  measurement.** (b) **TAUT-006** is no longer TS-strict: `invocationSites` proves a spy *was*
  reached, never that it was not (`jest.spyOn(cm, 'emit')` + `cm.initialize(cfg)` reaches the spy
  without naming it), so the Python-only "unobservable indirect path" suppression is now
  language-neutral on `fn.hasProductionCalls`; the rule keeps its real target — a spy asserted by a
  test that runs **no** production code. (c) **TAUT-005** gained two hand-off forms: a mock installed
  onto another object (`pm.findPort = jest.fn()…`) and a double handed to production as a configured
  return value (`spyOn(cm, 'createAdapter').mockReturnValue(adapter)` — also reaching every spy on
  `adapter`; the old `isConfigCall` text regex never matched a parenthesised receiver). (d)
  **provenance** now traces dynamic-import bindings (`const { f } = await import(…)`) and local
  wrapper helpers — but **source kind only, never `constant`/`literal`**, and only when the helper
  has exactly one value-returning `return`: the first cut inherited a helper's `return null` and
  turned 13 healthy Chaos assertions into TAUT-003 errors. (e) New suppression form
  **`// @momus-ignore-file:RULE[,RULE]`** — a file-scoped finding is reported at 1:1, so no line
  comment can precede it. (f) The in-flight mocktopus literal extractor emitted
  `{kind:'boolean'|'number'|'string'}` nodes, which are not `TypeIR` and would never have reached
  DRIFT-003; now `{kind:'literal', value}` with delimiters stripped. Repo side: Knossos lost three
  `assertSame(true, true)` sentinels (CliCommandContext::output is `echo`, so ob_start captures it;
  CliHelpRenderer got CliErrorRenderer's injectable stream; the pcntl guard now `markTestSkipped`s),
  Chaos carries three justified `@momus-ignore-file:MOCK-001` banners on composition-root/interaction
  suites, Argos needed **no change at all**. Final: **Chaos 0 (3 suppressed) · Knossos 0 · Argos 0**,
  their suites green (3324 / 2212 / —). Gate: **626 tests** (617 → 626), typecheck/lint/format clean,
  self-audit CLEAN.
- **Last verified (round 49, dogfood Argos-MCP):** dogfooding against a fresh `Argos-MCP` (58 files) surfaced 21 false positives (`DRIFT-001` missing member for inline types, `TAUT-004` mock-only-assertion for `new` calls inside local helpers, and `TAUT-005`/`TAUT-006` zero-reach stubs for args handed off to `mockReturnValue(mockObj)`). Closed all three gaps: (1) `DRIFT-001` now checks `!targetSym` to skip unresolvable `__type` literals, (2) `productionCalls`'s AST `visit()` recursively checks `ts.isNewExpression(n)` to trace direct `new MyProductionClass()` calls in local helpers, (3) `mocks.ts` reachability removes the strict `!isConfigCall` guard so `jest.spyOn(sut, 'method').mockReturnValue(mockObj)` explicitly registers `mockObj` as reached. Argos-MCP re-audit: **21 warnings → 0 issues** — **corrected in round 50: measured against a stale IR cache; with the cache cleared the same tree still reported 19 warnings, only the `TAUT-004` half held**. Gate: **617 tests**, typecheck/lint/format clean, self-audit CLEAN.
- **Last verified (round 48, dogfood + mocktopus drift + function drift):** closed two gaps for mocktopus. **(1) Mocktopus literal return extraction:** `syn-wasm` treats closures as opaque `other` nodes, so `MockResult::Return("val")` inside `.mock_safe(|| ...)` was previously unrecorded. The parser now regex-matches the text of closure nodes to extract literal mocktopus returns. **(2) Function drift resolution:** `DRIFT-003` was failing to resolve mocked local functions (like `global_fetch`) because the symbol index query only checked the global index; it now falls back to `module.symbols`. Mocktopus mocks are now correctly analyzed for return-type drift (`DRIFT-003`) and zero-reach stubs (`TAUT-005`). Planted drift in a new `mocktopus_test.rs` fixture fires exactly as expected. Baselines: mockall 0 err / 3 TAUT-005 + 2 MOCK-002, mry 93 mocks / 0, faux 55 / 1 MOCK-002, mockers 151 / 0, mockiato 48 / 1 MOCK-002, mocktopus 270 / 0 (checked), mock_derive 38 mocks / 2 TAUT + 7 MOCK-002, galvanic 45 mocks / 0, Chaos 0 err / 4 MOCK-001, Knossos 6 sentinels, Argos 0 err / 0 issues. Gate: **617 tests**, typecheck/lint/format clean, self-audit CLEAN, coverage **91.60% stmts / 85.19% branches / 96.55% funcs**. IR schema 21.
- **Last verified (round 47, dogfood + galvanic-mock detection):** a fresh `mindblaze/galvanic-mock`
  clone (20 test `.rs` files) was **invisible** — its `#[mockable]`/`#[use_mocks]` + `new_mock!(Trait)`
  + `given!`/`expect_interactions!` + `mock.method(…)` API has no `Mock::new()` constructor or
  `mock_*`/`expect_*` config method (the `new_mock!` macro *is* the instantiation, and the DSL bodies
  are macro token streams opaque to syn). Added galvanic detection (`MockFramework`/`MockPattern`
  `'galvanic'`, IR schema 21, server enum + rust fence + contract scaffold + CLI help):
  `let mock = new_mock!(Trait)` emits one mock with the trait as the target (generics
  `Trait<i32, f64, Assoc=String>`, explicit `new_mock!(Trait for MyMock)`, referred
  `new_mock!(::sub1::sub2::EmptyTrait)`, and trailing mock `#[allow(…)]` attributes all normalized);
  `given!`/`expect_interactions!` record the `<mock as Trait>::method` stub names for DRIFT-001;
  `mock.method(…)` marks the mock reached. Return values are deliberately not recorded (closure/
  matcher `then_return*` values in the opaque DSL). galvanic re-audit: **45 mocks (20 files), 0
  issues**; a planted `nonexistent_method` stub fires DRIFT-001 end-to-end. Also closed the deferred
  mock_derive `return_result_of(|| …)` gap: a single-scalar closure body now records a literal return
  for DRIFT-003 (computed/block closures stay skipped). Baselines unchanged: mockall 0 err / 3
  TAUT-005 + 2 MOCK-002, mry 93 mocks / 0, faux 55 / 1 MOCK-002, mockers 151 / 0, mockiato 48 / 1
  MOCK-002, mocktopus 270 / 0, mock_derive 38 mocks / 2 TAUT + 7 MOCK-002, Chaos 0 err / 4 MOCK-001,
  Knossos 6 sentinels. Gate: **617 tests** (610 → 617), typecheck/lint/format clean, self-audit
  CLEAN, coverage **91.62% stmts / 85.21% branches / 96.57% funcs**. IR schema 21. docs/11 rows 80–81
  + progress 47.
- **Last verified (round 46, dogfood + mock_derive detection):** a fresh `DavidDeSimone/mock_derive`
  clone (12 `.rs` files) was **detected but misattributed** — its `#[mock] trait X` + `MockX::new()` /
  `Extern<Abi>Mocks::method_<fn>()` API collides with mockall's `MockFoo::new()` prefix, so all 32
  trait mocks read as `mockall`/`automock` and the 6 `#[mock] extern` function mocks were invisible.
  Added mock_derive detection (`MockFramework`/`MockPattern` `'mock_derive'`, IR schema 20, server
  enum + rust fence + contract scaffold + CLI help + `#[mock] extern` ForeignMod serialization in the
  syn-wasm layer): `#[mock] trait X` (incl. `#[cfg_attr(…, mock)]`) + `MockX::new()` emit a mock
  (target = the trait; the mockall pass skips `#[mock]`-declared constructors), `method_<m>()`
  attaches the stub, `.set_result(<literal>)` records a literal return (DRIFT-003), and `mock.<m>()`
  marks it reached; `#[mock] extern` blocks emit one untargeted `Extern<Abi>Mocks` mock per foreign
  fn. mock_derive re-audit: **38 mocks (32 trait + 6 extern), 2 TAUT + 7 MOCK-002** — the 2 TAUT are
  the example's genuine `assert_eq!(1,1)` self-comparison, and the 7 MOCK-002 are examples mocking
  their own same-file `#[mock]` trait (consistent with mockall's synchronization.rs). Also closed a
  surfaced **DRIFT-001 supertrait gap**: `trait Derived : Base` now populates `extendsIds` in the
  Rust symbol index (supertrait serialization in the wasm layer), so a mock stubbing an *inherited*
  method no longer false-flags "missing member" (mock_derive's `advanced_traits.rs` `add`).
  Baselines unchanged: mockall 0 err / 3 TAUT-005 + 2 MOCK-002, mry 93 mocks / 0, faux 55 / 1
  MOCK-002, mockers 151 / 0, mockiato 48 / 1 MOCK-002, mocktopus 270 / 0, Chaos 0 err / 4 MOCK-001,
  Knossos 6 sentinels. Gate: **610 tests** (603 → 610), typecheck/lint/format clean, self-audit
  CLEAN, coverage **91.49% stmts / 84.85% branches / 96.54% funcs**. IR schema 20. docs/11 row 80 +
  progress 46.
- **Last verified (round 45, dogfood + mocktopus detection):** a fresh `CodeSandwich/Mocktopus` clone
  (46 `.rs` files) audited as a **vacuous 0-mock** — its `#[mockable]` + `foo.mock_safe(…)` /
  `foo.mock_raw(…)` API has no `Mock::new()` constructor (the call *is* the mock), so no existing
  pass saw it. Added mocktopus detection (`MockFramework`/`MockPattern` `'mocktopus'`, IR schema 19,
  server enum + rust fence + contract scaffold + CLI help): each `foo.mock_safe/mock_raw` emits a
  mock with the receiver's function/method name as an informational `unknown` target (bare,
  module-qualified, static, and instance forms). A mocked function has no member-drift surface and
  its invocation is indirect, so stubs/returns are not recorded (no false TAUT-005/DRIFT surface).
  mocktopus re-audit: **270 mocks (34 files), 0 issues** — non-vacuous. Also verified the mry
  `Mock<T>::new(…)` cross-crate disambiguation was **already done** in round 42 (`hasMryMockCalls`
  skips the mockall pass + `mryConstructorType` claims `::new`; test exists) — removed from the
  candidate list. Baselines unchanged: mockall 0 err / 3 TAUT-005 + 2 MOCK-002, mry 93 mocks / 0,
  faux 55 / 1 MOCK-002, mockers 151 / 0, mockiato 48 / 1 MOCK-002, drf 41 mocks / 0. Gate: **603
  tests** (600 → 603), typecheck/lint/format clean, self-audit CLEAN, coverage **91.75% stmts /
  84.76% branches / 96.51% funcs**. IR schema 19. docs/11 row 79 + progress 45.
- **Last verified (round 44, dogfood + mockiato detection):** a fresh `mockiato/mockiato` clone
  (103 `.rs` files, workspace `mockiato` + `mockiato-compiletest`) audited as a **vacuous 0-mock** —
  its `#[mockable]` + `XMock::new()`/`XMock::default()` (a *suffix* `Mock`, vs mockall's `MockX`
  prefix) + `x.expect_<m>(…).returns(v)` API was unmodeled. Added mockiato detection
  (`MockFramework`/`MockPattern` `'mockiato'`, IR schema 18, server enum + rust fence + contract
  scaffold + CLI help): `XMock::new()`/`XMock::default()` emit mocks (strip `Mock` → trait),
  `expect_<m>` attaches stubs (`_calls_in_order` stripped), `.returns`/`.returns_once` record
  literal returns, `x.<m>(…)` marks reached. mockiato re-audit: **48 mocks (23 files), 1 MOCK-002**
  (the `examples/downcasting.rs` example genuinely mocks its own `ObjectBehavior` — INFO). The
  re-audit also surfaced a **general Rust reachability gap**: the syn-wasm serializer only descended
  into block/unsafe bodies, so `for`/`while`/`loop`/`if`/`match` bodies were opaque — a mock invoked
  inside a loop (`tests/sequential_calls.rs`) false-flagged **TAUT-005**. Those bodies now serialize
  as runtime `stmts` (then+else + arm bodies) and `?` is transparent. mockiato re-audit: **TAUT-005
  gone → 0 warnings**; all other Rust baselines unchanged (mockall 0 err / 3 TAUT-005 + 2 MOCK-002,
  mry 93 mocks / 0, faux 55 / 1 MOCK-002, mockers 151 / 0). Also verified: Python instance
  attributes (`self.x = …` in `__init__`) are **already modeled** (round 42 `instanceAttributes`,
  tested) and mockers' static-vs-instance distinction has **no observable effect** (deferred). Gate:
  **600 tests** (595 → 600), typecheck/lint/format clean, self-audit CLEAN, coverage **91.89% stmts /
  84.71% branches / 96.48% funcs**. IR schema 18. docs/11 rows 77–78 + progress 44.
- **Last verified (round 43, dogfood + mockers detection):** a fresh `kriomant/mockers` clone
  (59 `.rs` files, workspace `mockers` + `mockers_derive`) audited as a **vacuous 0-mock** — its
  `Scenario::create_mock_for::<dyn T>()` → `(mock, handle)` + `scenario.expect(handle.m(…).and_return(…))`
  API was unmodeled. Added mockers detection (`MockFramework`/`MockPattern` `'mockers'`, IR schema 17,
  server enum + rust fence + contract scaffold + CLI help) and **tuple-pattern binding serialization**
  in the syn-wasm layer (new `bindings` field on `let (mock, handle) = …` so the fake/handle tuple
  binds the mock). `create_mock_for`/`create_named_mock_for`/`create_mock` emit mocks (trait target,
  `Mock`/`MockStatic` suffix stripped cross-crate); `scenario.expect(handle.<m>(…).and_return(v))`
  attaches stubs + literal returns; `mock.<m>(…)` and pass-by-value mark it reached. Mock-specific
  `clone` stubs (`mock_clone!`/`derive(Clone)`) are filtered via the trait-method set, and multi-trait
  `mock!` mocks are untargeted (no single production type). mockers re-audit: **151 mocks (23 files),
  0 issues** — non-vacuous. The re-audit also surfaced a pre-existing mry reachability gap
  (`async_fn_trait_variant` TAUT-005): `Cat::meow(&cat, 2)` (trait-qualified/UFCS invocation) now marks
  the mock reached — mry back to **0 issues**. Baselines unchanged: mockall 0 err / 3 TAUT-005 + 2
  MOCK-002, mry 93 mocks / 0, faux 55 mocks / 1 MOCK-002, django 43, drf 41 mocks / 0,
  requests/flask 0, Chaos 0 err / 4 MOCK-001, Knossos 6 sentinels. Gate: **595 tests** (585 → 595),
  typecheck/lint/format clean, self-audit CLEAN, coverage **91.98% stmts / 84.64% branches / 96.46%
  funcs**. IR schema 17. docs/11 row 76 + progress 43.
- **Last verified (round 42, dogfood + three hardening follow-ups):** all three remaining hardening
  candidates closed. **(1) mry cross-crate detection** (row 73): mry's `mock_<method>` carries no
  embedded type, so `scanMry` only ran on same-file `#[mry::mry]` declarations — a `src/`-declared
  type mocked in `tests/` was invisible (mry's own `crate_bound_consumer` test). `scanMry` now also
  runs for non-mry files (alongside the mockall pass), binding the receiver var from the
  unambiguous constructors `Mock<Type>::default()` / `mry::new!(Type { … })` (`::new` excluded —
  mockall collision). mry re-audit: **93 mocks (92 → 93), 0 issues**; planted cross-crate probes
  fire DRIFT-003. **(2) Python class-attribute modeling** (row 74): class-level assignments
  (`supports_async_task = True`, `ready: bool = False`) are now `property` members, and
  `patch.multiple` emits one stub per keyword — DRIFT-001 now checks patched members against the
  class (a planted `nonexistent_attr` fires); attributes on unresolvable bases stay protected by
  the `extendsIds` skip. django re-audit: **43 findings unchanged**. **(3) Python
  `Mock(return_value=…)` TAUT-002** (row 75): a bound `m = Mock(return_value=42)` captures a
  **literal** kwarg, `m()` is recognized as a `mock-config` operand, and `m()` marks the mock
  reached — the echo `assert m() == 42` now fires TAUT-002. Inline `Mock(return_value=…)` (a
  patch's `new` arg) and non-literals (`[]`, `some_obj`) are skipped so TAUT-005 stays quiet.
  Baselines: mockall 0 err / 3 TAUT-005 + 2 MOCK-002, faux 55 mocks / 1 MOCK-002, Chaos 0 err / 4
  MOCK-001, Knossos 6 sentinels, requests (37 files) 0, flask (83 files) 0. Gate: **585 tests**
  (579 → 585), typecheck/lint/format clean, self-audit CLEAN, coverage **91.95% stmts / 84.69%
  branches / 96.37% funcs**. IR schema 16. docs/11 rows 73–75 + progress 42.
- **Last verified (round 41, dogfood + mry/faux return-value recording):** the deferred mry/faux
  **return-value recording** is now done — DRIFT-003 (return-type assignability) had been dead for
  both frameworks because their return values were deliberately never recorded. Now `faux::when!(
  …).then_return(42)` and `mry.mock_<method>(…).returns(42)` / `returns("…")` record a **literal**
  return value on the stub; closure/`then`/`then_unchecked`/`returns_with`/`.to_string()`-chain
  returns stay unrecorded (`literalType` yields `unknown` — no literal to compare, and no TAUT-005
  churn from an `unknown` value). Both mry `emitMryMock`/`emitMryStatic` and the faux stub creation
  now return/reuse the mock so the config verb can attach its value. **Non-vacuous** (planted
  probes on fresh `mry`/`faux` clones fire DRIFT-003: `returns("nope")`/`then_return("nope")` on a
  `-> u32` method). Re-audits unchanged and now honest: **faux 55 mocks / 1 MOCK-002** (13 mocks
  DRIFT-003-checked), **mry 92 mocks / 0 issues** (12 mocks DRIFT-003-checked), mockall 0 err / 3
  TAUT-005 + 2 MOCK-002 (re-cloned `asomers/mockall`, unchanged). Discovered boundary (documented,
  not fixed): mry's `mock_<method>` carries no embedded type, so `typeTargets` is populated only
  from **same-file** `#[mry::mry]` declarations — a real-world `src/`-declared type mocked in
  `tests/` audits vacuously (mry's own tests declare types same-file, so the 92-mock baseline is
  unaffected). Gate: **579 tests** (577 → 579), typecheck/lint/format clean, self-audit CLEAN,
  coverage **91.82% stmts / 84.53% branches / 96.34% funcs**. IR schema 16. docs/11 row 72 + progress 41.
- **Last verified (round 40, dogfood + Python detection hardening):** four gaps closed, django
  **46 → 43 findings** — only the honest set remains (33 TAUT-001 `assertEqual(x,x)` self-compares +
  10 TAUT-003 intentional fail-fixtures). **(1) tree-sitter node-identity bug** — `bindingNameFor`
  compared `childField(parent,'right') === call`, but `childForFieldName` returns a fresh JS wrapper
  for the same node (same `id`, different object), so the `bindings` map stayed **empty on large files**
  and `resolveMockName`/positional hand-off reachability/`m.member.return_value = X` capture all
  no-oped (same bug in `importFrom`'s `child === modNode`). Now compares node `.id`. **(2)
  `return_value=`/`side_effect=` kwarg hand-off** — a mock injected via a patch's `return_value=m` is
  marked reached, closing the last django TAUT-005 (`test_sqlcompiler.py` `cursor`). **(3) `patch.dict`
  detection** — new `patch-dict` pattern (module target, 49 django usages; TAUT-005 skips it). **(4)
  inheritance** — `extendsIds` populated from `superclasses` + DRIFT-001 conservative skip for
  unresolvable bases, closing the 2 django DRIFT-001 (`_pre_setup`/`_post_teardown` inherited from
  `unittest.TestCase`). Baselines: requests (37 files) 0, flask (83 files) 0, Chaos 0 err / 4 MOCK-001,
  Knossos 6 sentinels. Gate: **577 tests** (572 → 577), typecheck/lint/format clean, self-audit CLEAN,
  coverage **91.81% stmts / 84.52% branches / 96.34% funcs**. IR schema 16. docs/11 row 71 + progress 40.
- **Last verified (round 39, dogfood + Python `hasProductionCalls`):** the django full-suite's **25
  TAUT-004/006 false positives** traced to `extractTestFunctions` hardcoding `hasProductionCalls:
  false` — the TS `productionCalls` dataflow pass had no Python analogue. Now each Python test
  function counts calls whose root is a **module-level import from a non-framework module**
  (framework = `unittest`/`mock`/`pytest*`/`django.test*`; production = `django.*` + stdlib
  `copy`/`datetime`/`ctypes`, …), with mock-binding shadowing resolved first. TAUT-006 gained a
  **Python-scoped** suppression for unreached spies in production-exercising tests (Python
  reachability can't see `return_value=`/SUT-mediated invocation; TS/PHP/Rust keep the strict
  `invocationSites` signal — the golden fixture's planted TS TAUT-006 still fires). django re-audit:
  **TAUT-004 21 + TAUT-006 4 → 0**; remaining django findings are the honest set (TAUT-001
  self-compares 33, TAUT-003 intentional fail-fixtures 10, DRIFT-001 inherited
  `_pre_setup`/`_post_teardown` 2, TAUT-005 autospec-`return_value` boundary 1). requests (35 files)
  + flask (83 files) baselines unchanged at 0 issues. Gate: **572 tests** (565 → 572), typecheck/lint/
  format clean, self-audit CLEAN, coverage **91.77% stmts / 84.63% branches / 96.33% funcs**. docs/11
  row 70 + progress 39.
- **Last verified (round 38, dogfood + faux/mry::m!/django):** three gaps closed. **(1) faux crate**
  (`#[faux::create]` + `Foo::faux()` + `faux::when!(mock.method).then(…)`) was invisible — a fresh
  `nrxus/faux` clone (36 `.rs` files) audited vacuous (0 mocks). faux detection added
  (`MockFramework`/`MockPattern` `'faux'`, IR schema 15): `Foo::faux()` / `foo::Foo::faux()`
  instantiate a mock; `faux::when!(mock.method).then/then_return/then_unchecked` attaches the method;
  returns are deliberately not recorded (closures + `assert_eq!` macro invocations). Re-audit: **55
  mocks, 1 MOCK-002** (genuine mock-of-self in `testable-renderer`, INFO) (row 67). **(2) mry
  `mry::m! { … }` form + path-qualified impl owners**: mry's function-style macro form was
  undetected, and `symbols.ts` kept the module path from `selfType.text` (`foo::Foo`), so
  `#[faux::methods(path = "crate")] impl foo::Foo` false-flagged DRIFT-001; now uses `selfType.name`.
  mry re-audit: **92 mocks (72 → 92), 0 issues** (row 68). **(3) django full-suite** (2005 `.py`
  files) surfaced **90 TAUT-005** false positives from indirect `patch`/`patch.object` invocation;
  TAUT-005 now skips `patch`/`patch-object`/`patch-multiple` mocks. django re-audit: **90 → 1
  TAUT-005** (autospec-via-`return_value` boundary); remaining buckets honest — TAUT-001
  `assertEqual(x, x)` self-comparisons (33), TAUT-003 intentional fail-fixtures (10), TAUT-004/006
  (25) blocked on Python `hasProductionCalls` (TypeScript-only today), DRIFT-001 (2) blocked on
  inheritance (`_pre_setup`/`_post_teardown` inherited from `unittest.TestCase`) (row 69). Baselines
  unchanged (mockall 0 err / 3 TAUT-005 + 2 MOCK-002; mockito/wiremock-rs/httpmock/mry/requests/flask
  = 0; faux 1 MOCK-002; Chaos 0 err / 4 MOCK-001). Gate: **565 tests** (563 → 565),
  typecheck/lint/format clean, coverage **91.73% stmts / 84.56% branches / 96.33% funcs**. docs/11
  rows 67–69 + progress 38.
- **Last verified (round 37, dogfood + mry detection):** a fresh `mitsuhiko/mry` clone (52 `.rs` files,
  workspace `mry` + `mry_macros`) surfaced two real gaps. **(1) `.gitignore` negation was dropped** by
  `discoverFiles` — mry's workspace root uses the standard Rust "ignore all, then whitelist"
  convention (`*` / `!*/` / `!*.rs` / `!Cargo.toml`), so the whole workspace was ignored (**0 modules**).
  `.gitignore` is now parsed with proper negation (last match wins), directory-only (trailing `/`),
  anchored (`/` or mid-pattern `/`), and ancestor-directory semantics; the walker passes file-vs-dir so
  `!*/` re-includes directories (row 65). **(2) mry's mock API was invisible**
  (`#[mry::mry]` + `mock_<method>(…).returns(…)`) — a vacuous 0-mock audit. mry detection added
  (`MockFramework`/`MockPattern` `'mry'`, IR schema 14): instance `x.mock_<method>`, static
  `Type::mock_<method>`, constructor `Mock<T>::mock_<method>`, and bare `mock_<fn>` free-function forms;
  free-function mocks are untargeted, and a mry file skips the mockall pass (its `Mock<Type>` collides
  with `MockFoo::new()`) (row 66). mry re-audit: **72 mocks, 0 issues**, non-vacuous. All other baselines
  unchanged (mockall 0 err / 3 TAUT-005 + 2 MOCK-002; mockito/wiremock-rs/httpmock/requests/flask = 0;
  Chaos 0 err / 4 MOCK-001; Knossos 6 sentinels). Gate: **558 tests** (552 → 558), typecheck/lint/format
  clean, self-audit CLEAN, coverage **91.86% stmts / 84.46% branches / 96.29% funcs**. docs/11 rows 65–66
  + progress 37.
- **Last verified (round 36, dogfood + refinements):** three refinements. **(1) mockall `return_once` /
  `returning_st` / `return_once_st` captured** — the one-shot/non-Send `return*` variants were missed,
  so DRIFT-003 never saw their values (row 63). **(2) serde.rs TAUT-005 boundary closed** — inherent /
  module static mocks (no resolvable drift target) now skip return-value recording, so TAUT-005 no
  longer false-flags a static mock invoked through the SUT's own impl (`impl Deserialize for
  MockThing` calls `MockThing::private_deserialize`, but impl bodies aren't serialized). **mockall
  back to 0 errors / 3 TAUT-005 + 2 MOCK-002.** **(3) Python `patch.multiple` dogfooded on a fresh
  django sparse clone** (`tests/tasks` + `tests/apps`, 3 real usages incl. the decorator form) — the
  one-call multi-member patch was invisible (0 mocks); now emitted as a class-target mock, with
  member-level drift deliberately deferred (it patches class *attributes*, which the Python parser
  doesn't model — methods-only, no inheritance). django re-audit: **0 issues**, detection non-vacuous
  (row 64, IR schema 13). mockito/wiremock-rs/httpmock/requests/flask baselines unchanged. Gate:
  **552 tests** (549 → 552), typecheck/lint/format clean, self-audit CLEAN. docs/11 rows 63–64 +
  progress 36.
- **Last verified (round 35, dogfood + static-context detection):** mockall's static/associated/
  constructor method context API was invisible — `MockFoo::baz_context()` + `ctx.expect().returning(...)`
  (plus the module form `mock_foo::bar_context()` and constructor `MockA::new_context()`) produced
  **zero mocks** across 83 `_context()` sites, so static-only test files had no drift/TAUT surface.
  Now one mock is emitted per `_context()` with the static method as a stub; `ctx.expect()` attaches
  `returning`/`return_const` values; reachability covers direct calls, UFCS (`<MockA as A>::new()`),
  function-pointer references (`let p = mock_ffi::foo; p(42)`), and raw identifiers
  (`Mockwhile::r#loop()`) (row 62, IR schema 12). Re-audit surfaced two honest findings:
  **serde.rs** TAUT-005 (inherent static mock `private_deserialize` invoked indirectly through
  `serde_json::from_str` — a documented static-analysis boundary) and **synchronization.rs**
  MOCK-002 ×2 (the `mockall_double` example mocks its own `Thing` — true mock-of-self, INFO).
  mockall baseline now **0 errors / 4 TAUT-005 (3 genuine + 1 serde) + 2 MOCK-002**. mockito /
  wiremock-rs / httpmock / requests baselines unchanged. Gate: **549 tests** (543 → 549),
  typecheck/lint/format clean, self-audit CLEAN. docs/11 row 62 + progress 35.
- **Last verified (round 33–34, dogfood + hardening):** two new findings closed. **(1) mockall MOCK false positives** (row 60): the 4th-pass re-audit surfaced **60 MOCK-001 + 133 MOCK-002** the documented "0 errors / 3 TAUT-005" baseline had missed — mockall's integration tests declare a fixture `trait Foo`/`struct Bar` **inside each test file** just to exercise the macros, then mock it (not a production dependency, not a subject). MOCK-001/MOCK-002 now skip same-file fixtures, and `recordMockMacro` parses `where`-clause generics (2 more MOCK-001). mockall back to **0 errors / 3 TAUT-005**. **(2) httpmock crate dogfooded** (row 61, IR schema 11): fresh clone (`alexliesenfeld/httpmock`, 73 `.rs` files) exposed a **vacuous audit** — its `server.mock(|when, then| { … })` closure API was undetected (0 mocks). httpmock detection added across the Rust parser, IR unions, CLI help, and the MCP server (enum + rust fence + contract scaffold). Re-audit: **43 mocks, 0 issues**. Baselines unchanged: mockito 0, wiremock-rs 0, requests 0. Gate: **543 tests** (537 → 543), typecheck/lint/format clean, self-audit CLEAN. docs/11 rows 60–61 + progress 33–34.
- **Last verified (round 31–32, dogfood + coverage):** four-language dogfood round — **Rust**:
  mockall 4th pass → **0 errors**, TAUT-005 5→3 (all genuine), and 2 **DRIFT-003 false positives
  fixed** (generic-dependent returns `V` / `<T as Foo>::Output` now resolve via the symbol index
  with a conservative pass for unprovable names — mirrors PHP's class path; fixtures
  `generic_test.rs` + `repo.rs::Record` + 3 direct rule tests). Fresh clones verified healthy:
  **mockito** 137 mocks (incl. the new `server.mock` form) 0 issues, **wiremock-rs** 19+ mocks
  (incl. `.await` chains) 0 issues — both non-vacuous (per-file mock counts checked). **Python**:
  **requests dogfood → 0 issues** (was 3 DRIFT-005 errors + 3 MOCK-002 infos): module-level
  import bindings (`import idna`, `from … import proxy_bypass`) are now real `exports` for
  DRIFT-005 (function-local imports still flag; `import a.b` binds `a`; `as` binds the alias),
  and MOCK-002's Python branch only fires for a patch of the module itself, not an attribute
  inside the SUT (`patch('requests.help.idna')` is normal). **CLI**: `momus contract` now
  defaults `--framework` per target language (`.rs`→mockall, `.py`→pytest, `.php`→phpunit) so
  headers match the emitted body (was `(vitest)` on Python output / wiremock scaffold for Rust
  traits). Baselines unchanged: Chaos 0 errors / 4 MOCK-001, Knossos 6 sentinel errors. Gate:
  **537 tests**, typecheck/lint/format clean, self-audit CLEAN, coverage **91.86% stmts /
  84.13% branches / 96.16% funcs** (IR schema 10). docs/11 rows 57–59 + progress 31–32.
- **Last verified (follow-ups round):** from the parity release, three follow-ups: the two
  dogfood/parser work items shipped in **v0.0.7** (see the bullet below); the agent-tools spec is
  committed on `feat/agent-tool-surface` awaiting review. Details: (1) **Agent tool surface spec written and
  committed** (`docs/superpowers/specs/2026-08-18-agent-tool-surface-design.md` on
  `feat/agent-tool-surface`): six new MCP tools (`explain_issue`, `preview_issue_fix`,
  `apply_issue_fix` — the only writer, two-phase one-issue-at-a-time with a stale-span guard —
  `audit_workspace` with dedupe, `get_ir`, `doctor_status`), three resources
  (`momus://rules`, `momus://config`, `momus://issues/latest`), and watcher-driven
  `notifications/resources/updated` (degrade-gated on SDK support). Design approved by user;
  **decision recorded: two-phase fix, not single-shot**; awaiting user spec review before
  writing-plans. (2) **Rust TAUT-005 third pass — implemented, gate green** (rows 55, §4d in
  docs/11): the syn-wasm serializer now renders `&`-reference referents, block/`unsafe`
  statements, and qualified-path callees (`<Ty as Trait>::foo`), the TS walker resolves
  trait-qualified/UFCS first-arg receivers and descends into blocks, and
  `TestFnIR.shouldPanic` + `MockIR.fnId` (IR schema 8) suppress TAUT-005 inside
  `#[should_panic]` tests (the drop-panic is the assertion). **mockall dogfood: 11 → 5
  warnings, 0 errors** — the 6 cleared were false positives (UFCS ×4, unsafe-block ×1,
  should-panic ×1); the 5 remaining are the genuine cfg-gated compile-only set ×4 + one
  configured-but-unused mock (`mock_struct.rs:125`). (3) **flask dogfood — implemented,
  verified green** (docs/11 §4e, row 56): 83 files, 0 issues / 0 false positives; planted
  probes fired DRIFT-005/TAUT-004/005/006 end-to-end and exposed a real gap —
  `resolvePythonImport` never probed `src/` (src-layout), so `patch('flask.sessions.X')`
  silently degraded DRIFT-005. Fixed with a per-ancestor `src/` fallback + fixtures;
  flask + httpx re-audit at 0. Full gate green: **501 tests**, typecheck/lint/format clean,
  self-audit CLEAN (107 files).
- **Last verified (0.0.7 released):** PR #17 (`feat: close mockall TAUT-005 false positives +
  src-layout DRIFT-005 fix`) merged to main (all 4 gates green), release-please opened PR #18
  (`chore(main): release 0.0.7`) which merged and cut **v0.0.7** tag + GitHub Release
  (2026-08-18) — 7 packages lockstep. The release-PR CI dispatch hit the known
  `action_required`-with-0-jobs quirk again (GITHUB_TOKEN-opened PRs don't fire runs); recovered
  via `gh run rerun` — no config change needed. Main CI + Release Please green after the merge.
- **Last verified (0.0.6 released):** PR #14 (`feat: four-language parity`) merged to main (all 4
  gates green), release-please opened PR #15 (`chore(main): release 0.0.6`) which merged and cut
  **v0.0.6** tag + GitHub Release (2026-08-17) — 7 packages lockstep. The release-PR CI dispatch hit
  the known `action_required`-with-0-jobs quirk (GITHUB_TOKEN-opened PRs don't fire runs); recovered
  via `gh run rerun` — no config change needed.
- **Last verified (four-language parity):** `feat/language-parity` implements the
  `docs/superpowers/specs/2026-08-17-four-language-parity-design.md` plan (11 TDD tasks): a single
  shared 14-rule catalog (`@momus/core` `RULES_CATALOG`) drives both `momus rules` and MCP
  `list_rules`; the watcher watches `.rs` and default ignores cover `.venv`/`__pycache__`/`target`;
  Rust TAUT-005 gained wrapper re-bindings + by-value consumption (mockall warnings 16→11);
  MOCK-002 subject derivation is per-language, and Python DRIFT-005 + Python/PHP TAUT-006
  (`assert_called*`/Mockery `spy()` → new `mockery-spy` pattern, IR schema v7) shipped;
  **pyright `--createstub` inference** (the in-process `pyright-internal` API is unpublished on
  npm) resolves unannotated Python return types into `SignatureIR` so DRIFT-002/003 fire on
  unannotated code (degrades to annotations-only on failure); and `synthesize_mock_contract` gained
  `pytest`/`unittest`/`mockall`/`mockito`/`wiremock` templates. Full gate green (491 tests),
  typecheck/lint/format clean, self-audit clean. Dogfood: httpx 0 issues (first-file pyright cold
  start logged as a `SYS-004` note — documented cost, not a regression).
- **Last verified (Rust support):** Rust shipped as a fourth language family (spec + plan under
  `docs/superpowers/…`, 10 TDD tasks). `@momus/parser-rust` parses `mockall` (`#[automock]`,
  `mock!`, `expect_*().returning()`), `mockito`/`wiremock` HTTP mocks, and built-in
  `assert!`/`assert_eq!`/`assert_ne!`/`assert_matches!` into the same `ModuleIR` (rules untouched),
  via a **thin `syn`→wasm32 WASM module** (`parseFile(source) → JSON AST`, synchronous, no-import
  FFI, committed as `packages/parser-rust/wasm/pkg/momus-syn-wasm.wasm`) + a **fat TS** layer doing
  symbol/import/crate-index resolution and mock/assertion extraction. Semantic-from-day-one drift
  (`rustReturnAssignable` → DRIFT-003, DRIFT-001 missing-member, TAUT-001 self-comparison) with a
  crate-wide index that resolves `use`/`mod` paths, aliases, and trait targets. Wired through
  CLI/server (`createWorkspaceParser`/`createMomusServer`), `momus doctor` Rust-readiness, schema
  `rust` flag, release/publish config, golden + MCP round-trip tests. **Dogfooded on mockall's own
  test suite (188 `.rs` files): 0 errors** (3 real bugs fixed — rows 52–54 in docs/11; 16 remaining
  TAUT-005 warnings are documented static-analysis boundaries, see docs/11 §4d). Full gate green.
- **Last verified (0.0.5 released):** PR #11 (`feat: Rust language support (syn → WASM)`) merged
  to main (all 4 gates green), release-please opened PR #12 (`chore(main): release 0.0.5`) which
  merged and cut **v0.0.5** tag + GitHub Release (2026-08-17) — 7 packages lockstep (parser-rust
  aligned via `version:sync` before merge so the release-config gate stayed green). The
  release-PR CI dispatch hit the same `action_required`-with-0-jobs quirk as 0.0.4; recovered
  via `gh run rerun` — no config changes needed.
- **Last verified (version-sync automation):** added `scripts/sync-versions.mjs`
  (`npm run version:sync` + `version:check`) to align every `package.json` version to
  `.release-please-manifest.json`, plus a `.githooks/pre-commit` hook that runs it on every
  commit — a **new** package now starts at the current lockstep version instead of a hardcoded
  one (the manual 0.0.2→0.0.3 alignment on parser-python is what prompted this). docs/06 §6.5.2
  and the Python plan's package template updated to say "run version:sync, never hardcode".
- **Last verified (0.0.4 released):** PR #8 (`feat: Python language support`) merged to main
  (all 4 gates green), release-please opened PR #9 (`chore(main): release 0.0.4`) which merged
  and cut **v0.0.4** tag + GitHub Release (2026-08-17) — 6 packages lockstep (parser-python
  aligned to the 0.0.3 baseline before merge so the release-config gate stayed green). A live
  GitHub 503 incident ate the release-please run and the release-PR CI dispatch (`action_required`
  with 0 jobs); both recovered via `gh run rerun` — no config changes needed.
- **Last verified (0.0.3 release unblocked):** PR #7 (`chore(main): release 0.0.3`) was
  deadlocked — the required `conventional-title` check (the `PR Title` workflow, triggered by
  `pull_request_target`) never runs on release-please PRs because GitHub does not create new
  workflow runs for events triggered by `GITHUB_TOKEN` (release-please opens PRs with
  `secrets.GITHUB_TOKEN`); `--admin` merges stay blocked too (`enforce_admins` + required
  status checks). Fixed by dropping `conventional-title` from the required checks on `main`
  (now `commit-hygiene` + `release-config` + `test`, strict still on) — the title check still
  runs on human PRs and release-please titles are auto-conventional anyway. PR #7 merged →
  **v0.0.3 tagged + released** (2026-08-17); CI + release-please runs on main green.
- **Last verified (Python support):** Python shipped as a third language family. A single
  language registry (`packages/core/src/languages.ts`) now drives the `Language` type, config
  defaults, test-file patterns, and the discovery extension regex; the audit engine's language
  gate is `config.languages[module.language]` (no hardcoded per-language checks).
  `@momus/parser-python` parses pytest/unittest via `tree-sitter-python` + textual PEP
  484/526/585/604 annotations into the same `ModuleIR` (rules untouched): `patch`/
  `patch.object`/`Mock(spec=)`/`mocker`/`monkeypatch` mocks, `assert`/`pytest.raises`
  assertions, DRIFT-001 (missing patched member) + annotated DRIFT-002/003 (unannotated →
  SYS-003), TAUT-*/MOCK-* parity. Wired through CLI/server (`createWorkspaceParser`/
  `createMomusServer`), `momus doctor` Python-readiness, schema flag, release/publish config,
  golden + MCP round-trip tests. Full gate green: 425 tests, typecheck, lint, format,
  `audit-self` clean on 84 files. Design spec + plan under `docs/superpowers/…`. **Rust (`syn`
  via WASM) + pyright type inference remain follow-ups.**
- **Last verified (branch protection live):** `main` is protected on GitHub — enforced for
  admins too (no direct pushes, including for us; every change goes through a PR), required
  checks `commit-hygiene` + `release-config` + `test` (`conventional-title` dropped as a
  required check on 2026-08-17 — `pull_request_target` cannot fire on GITHUB_TOKEN-opened
  release-please PRs, see the 0.0.3 bullet) with branches required up-to-date (strict), no
  review required (solo repo), force-push and branch deletion blocked. The release-please
  bot's version PRs pass the same gates. docs/06 §6.5.1 updated to the real job set.
- **Last verified (live release flow):** repo pushed to `https://github.com/AraneaDev/Momus-MCP`
  (first push ever — CI had never run before, which is how several latent CI bugs survived).
  Release-please now works end-to-end against the real GitHub API: **v0.0.1** bootstrapped
  (tag + release, since the manifest baseline is 0.0.1 and the first run would have proposed
  0.1.0 from the 4 early `feat` commits) and **v0.0.2 cut automatically** (PR #2 → merge →
  tag + GitHub Release with changelog). Live bugs found & fixed: (1) `json` extra-files need
  a `jsonpath` property (release-please rejects `{type:'json', path}` — caught on the first
  real run); (2) `bump-patch-for-minor-pre-major: true` added so pre-1.0 releases stay in
  0.0.x and the `~0.0.1` internal dep ranges always resolve (`npm ci` on the release branch
  had E404'd when 0.1.0 was proposed); (3) the `release-config` check asserts the ~ range
  *admits* the current version, not equals it; (4) CI env bugs: serverInfo test hardcoded
  0.0.1, `--fix` tests inherited `CI=true` on runners, and the **CLI smoke step was
  false-green since the first commit** (absolute path + `--max-issues 0` → audited nothing;
  never surfaced because the repo was never pushed). All CI runs on main now green; release
  PRs get the same gates (commit-hygiene, release-config, conventional-title, test). The
  **npm publishing is removed from CI entirely** — manual-only by user direction (run
  `npm run publish` deliberately when publishing is sanctioned; `scripts/publish.mjs` stays
  in-repo). Tags + GitHub Releases are still cut automatically by release-please; npm is
  never touched by CI. The release-config test pins that no publish step / NPM_TOKEN /
  id-token exists in the workflow. All workflows pass `actionlint`.
  Also fixed: the `--fix` CLI smoke step was false-green since the first commit (absolute
  path + `--max-issues 0` audited nothing) — now `cd`s into the fixture, audits '.', and
  drops `--max-issues`; verified locally + green in CI.
- **Last verified:** npm publishing **removed from CI entirely** per user direction ("publish
  dormant until I say so — just remove it"): `release-please.yml` no longer contains a
  publish step, `MOMUS_NPM_TOKEN` env, or `id-token` permission; `test/release-config.test.ts`
  now asserts the workflow contains no `npm run publish` step / `NPM_TOKEN` reference (pinned),
  and docs/06/07/10/11 + HANDOVER updated. Landed via PR #4 (`ci: remove npm publishing from
  release workflow entirely`) — all four gates green, merged, CI + Release Please green on
  main. Tags + GitHub Releases still cut automatically by release-please; `scripts/publish.mjs`
  stays in-repo for a deliberate manual `npm run publish` when sanctioned. (Mystery resolved:
  a stray `npm run publish` fired during the PR-4 command chain was my own final verify step
  running after `gh pr create` — no hooks/CI/process trigger; failed ENEEDAUTH, nothing published.)
- **Last verified:** release-please round-trip verified end-to-end: `scripts/simulate-release.mjs`
  creates an isolated worktree, bumps 0.0.1 → 0.0.2 exactly as release-please's json extra-files
  would (root + all five packages + manifest + CHANGELOG), runs `npm ci` + the publish step
  dry-run, and asserts every `@momus/*` packs at 0.0.2 with `~0.0.1` ranges admitting the bump.
  `scripts/verify-release-config.mjs` (deterministic, no-network) is wired into `ci.yml` as the
  `release-config` job and pinned by `test/release-config.test.ts` (3 tests, root-level vitest
  include added). Dogfood probe round on Chaos/Knossos found no new gaps: `vi.hoisted`
  (fn + object forms) and class-valued factory keys resolve correctly, MOCK-001 counts stay
  accurate; both baselines unchanged (Chaos 4 MOCK-001 / 0 errors, Knossos 6 sentinel errors).
- **Last verified:** release tooling migrated from changesets to **release-please** modeled on
  Knossos-MCP: root + all five packages at **0.0.1** (lockfile synced), internal `@momus/*` deps
  re-pinned `~0.0.1` to track in lockstep, `release-please-config.json` (json extra-files bump
  every workspace `package.json`) + `.release-please-manifest.json` (`".": "0.0.1"`),
  `.github/workflows/release-please.yml` (release-please-action@v4 → version PR → `v*` tag +
  GitHub Release; **no npm publish step at all** — manual-only per user direction, pinned by
  the release-config test), `.github/workflows/pr-title.yml`
  (conventional-commit title gate, payload-only `pull_request_target`, `permissions: {}`), and
  `scripts/publish.mjs` (`npm publish -w` in dependency order, `NPM_PUBLISH_DRY_RUN=1`
  supported). `@changesets/cli`, `.changeset/`, and `release.yml` removed. MCP serverInfo
  version now reads `@momus/mcp-server`'s package.json at runtime (test pins 0.0.1). MCP
  integration test (18) and full gate green.
- **Last verified:** setup scopes, assigned `vi.fn`/`jest.fn` implementations, DRIFT-002 arity and
  parameter-type checks, Proxy doubles, syntax-only target-name enrichment, spy implementation
  signatures, and module automock helpers are complete. Full tests (112), typecheck, self-audit,
  and diff validation are green.
- **Last decision:** no concrete TypeScript `partialMock` convention exists in the repository or
  normative catalog; the named partial-mock form is PHP `createPartialMock`, so the ambiguous TS
  helper is deferred rather than invented.
- **Last verified:** the E6 PHP parsing spike now passes all checks: typed production methods,
  PHPUnit `createMock`/`method`/`willReturn`/`expects` chains, class targets, and suppression
  docblocks. Its existing reference correctly points to `InvoiceTest.php`.
- **Last verified:** the initial `@momus/parser-php` integration passes: typed production symbols,
  PHPUnit `createMock` chains, configured `willReturn` values, planted missing-member drift, and
  healthy PHP assertions. E6 also passes; full tests (112), typecheck, self-audit, and diff checks are
  green. The core AuditEngine can run the PHP parser in direct integration tests.
- **Last verified:** PHP configured-mock provenance is complete: bound PHPUnit
  `method(...)->willReturn(...)` calls produce `mock-config` assertion provenance, TAUT-002 fires
  for the planted echo, and the healthy twin remains quiet. Full tests (112), typecheck, self-audit,
  and diff validation are green.
- **Last verified:** PHP `use ... as ...` alias resolution is focused-test and typecheck green;
  the aliased `Repo::class` target resolves to `InvoiceRepository`, and planted/healthy mock behavior
  remains covered.
- **Last verified:** PHP `use` aliases, configured-mock TAUT-002 flow, the composite parser, PHP
  language gating, and explicit original-constructor DRIFT-004 are complete. CLI/server construct
  the TypeScript+PHP multiplexer; full tests (115), typecheck, self-audit, and diff validation are green.
- **Last verified:** PHP Mockery/Pest support is complete for this slice: `Mockery::mock`/`spy`,
  Pest `mock(...)`, chained `shouldReceive(...)->andReturn(...)`, planted missing members, and
  healthy controls pass. Full tests (115), typecheck, self-audit, and diff validation are green.
- **Last verified:** Composer PSR-4/use resolution is focused-test and typecheck green; the fixture
  `composer.json` resolves `App\\InvoiceRepository` to its source file while alias target resolution
  remains intact.
- **Last verified:** Composer PSR-4/use resolution is complete for the initial slice; full tests
  (115), typecheck, self-audit, and diff validation remain green, with the Composer fixture resolving
  `App\\InvoiceRepository` correctly.
- **Last verified:** PHP constructor drift focused coverage passes: `__construct` signatures are
  emitted, `getMockBuilder(...)->enableOriginalConstructor()->getMock()` records supplied args,
  DRIFT-004 flags the missing-argument double, and the supplied-argument twin stays quiet.
- **Last verified:** MCP PHP language selection and direct CLI parser dispatch are covered; the
  in-memory `verify_mock_drift` reaches PHP DRIFT-001/DRIFT-004, and CLI imports no longer execute
  the command entrypoint. Full tests (117), typecheck, self-audit, and diff validation are green.
- **Last verified:** CLI workspace parser selection is focused-test and typecheck green; importing
  the CLI no longer executes its entrypoint, and direct tests dispatch both TypeScript and PHP source.
- **Last verified:** Composer classmap fallback is complete: the fixture `composer.json` classmap
  root resolves the namespaced `Legacy\\LegacyRepository` to its source file while PSR-4 keeps
  resolving `App\\*`. Direct `resolveImport` unit coverage was added.
- **Last verified:** DRIFT-004 optional-constructor coverage is complete: a new all-optional
  `OptionsRepository` fixture proves defaulted parameters do not count as required (a 0-arg
  original-constructor double stays quiet; the missing-args twin remains the only DRIFT-004).
- **Last verified:** Mockery/Pest closure-form is complete: `Mockery::mock(Class::class, fn ($m) => …)`
  and `function ($m) { … }` forms bind configs span-scoped (same-named `$m` params in two
  closures no longer collide); string class targets (`'App\Foo'`) resolve via the `use` specifier.
  PHP DRIFT-003 return-type assignability is wired in the rule: declared PHP types (`array`/`void`/
  nullable/union mapping in `phpType`), cross-file class resolution via `SymbolIndex`, planted
  void/class/array mismatches fire (echo fixture's `willReturn(42)` on `findById(): Invoice`
  included), healthy twins stay quiet. New `Invoice.php` fixture enables class-type resolution.
- **Last verified:** Phase 3 (git-diff) is implemented end-to-end: `gitChangedPaths` (name-status
  + find-renames + untracked + rename pairs, repo-toplevel-aware), engine `DiffScope`
  (`changedSymbolIds` derived from changed production files), drift rules diff-filtered,
  DRIFT-006 stale-mock (fires when target changed + mock file untouched; message lists target
  class + members). CLI: `audit|drift --git-diff --base REF` + `momus precommit` (default base
  HEAD). MCP: `verify_mock_drift` `scope: git-diff` wired (git errors → tool errors). Tests:
  rule-level, `gitChangedPaths` unit (real temp repos), CLI precommit end-to-end through the
  bin (planted rename → DRIFT-006+DRIFT-001, exit 1; healthy twin → exit 0), MCP git-diff
  round-trip + non-git error path.
- **Last verified:** Phase 4 prep: `packages/action/action.yml` composite action (diff-scoped
  audit + annotate step, base defaults to PR base SHA, `fail-on` input) and `momus annotate-pr`
  (GitHub Checks API annotations via built-in fetch; GITHUB_TOKEN/REPOSITORY/SHA envs;
  dependency-free; pure `buildCheckAnnotations` unit-tested). `momus init` template fixed
  (languages booleans — was nested `{enabled}` objects) and `schemas/momusrc.schema.json`
  created (referenced by the template, previously missing). npm pack dry-runs clean.
  DRIFT-006 messages are budget-fitted (member names survive the 80-char limit; regression
  pinned in `diff.test.ts`).
- **Last verified:** PHPDoc `@return`/`@param` typing and PHP `synthesize_mock_contract`
  (phpunit/pest templates) are complete: the parser reads docblock annotations into signatures
  when native types are absent (scalars, `?T`, `T[]`/`array<K,V>`, generics, unions, FQCN
  short-names); planted docblock-typed DRIFT-003 mismatches fire and the healthy twin stays
  quiet; `synthesize_mock_contract` emits `phpunit`/`pest` templates (`createMock`/`mock` +
  `method`/`shouldReceive` + `willReturn`/`andReturn`) with type-derived placeholder values and a
  `php` code fence. Full tests (133), typecheck, and parser/MCP integration are green.
- **Last verified:** PHP anonymous-class doubles are complete: `new class extends Foo { … }`
  emits `MockIR{pattern:'anonymous-class'}` targeting the parent (via `use` aliases + FQCN
  short-names) with override methods as `StubbedMemberIR` members; a planted stale override
  fires DRIFT-001 and the healthy override stays quiet. Full tests (134), typecheck, and parser
  integration are green.
- **Last verified:** `momus doctor` PHP-readiness is complete: it reports the `languages.php`
  gate, `php-parser` availability, `composer.json` presence, and a bounded `.php` file count,
  summarizing as `off` / `ready` / `enabled (loose)`. Unit tests cover each branch. Full tests
  (137), typecheck, and CLI tests are green.
- **Last verified:** `momus hook` pre-commit installer is complete: `hook --install`/`--uninstall`
  writes/removes `.git/hooks/pre-commit` (marker-guarded so a foreign hook is never removed,
  `--yes`-gated per §1.5, executable), and `hook` (no flags) runs the staged-files drift gate via
  `gitStagedPaths` (index-only vs HEAD). A staged production rename blocks the gate
  (DRIFT-006 + DRIFT-001, exit 1) and the staged test update clears it. Full tests (141),
  typecheck, and CLI/diff tests are green.
- **Last verified:** `momus serve --transport http` (Streamable HTTP) is complete: `serveHttp` in
  `@momus/mcp-server` uses the SDK's stateful per-session transports (stateless tools), one
  transport per `mcp-session-id`, and the CLI wires `--transport http [--port N]`. An end-to-end
  `StreamableHTTPClientTransport` round-trip (initialize → tools/list → verify_mock_drift) is
  green. Full tests (142), typecheck, and integration tests are green.
- **Last verified:** `momus annotate` JSONL mode is complete: one JSON object per finding
  (workspace-relative file/line/column, rule/severity/message, deterministic key order) for
  editor plugins, with `--git-diff`/paths support and exit 1 on errors.  `buildAnnotateLines`
  is unit-tested. Full tests (143), typecheck, and CLI tests are green.
- **Last verified:** `momus audit --fix` mechanism is complete: dry-run unified diff by default,
  `--yes` applies span-based replace/delete/insert fixes, refused in CI without `--yes` (§1.5).
  `collectFixable`/`applyFixes`/`unifiedDiff`/`buildFixDiff`/`applyFixToFiles` are unit-tested.
  DRIFT-001 now emits a real rename fix (unique near-match within edit distance 2, quoted per
  stub api) and stub spans are narrowed to the name token; a planted stale spy is  dry-run diffed, applied with `--yes`, and re-audits clean. Full tests (153), typecheck, and CLI tests
  are green.
- **Last verified:** TAUT-001/002/003 fix code is resolved as a **decision, not code**: these are
  semantic tautologies and any auto-fix would invent the asserted value, so they stay
  descriptive-only (the `— fix:` hint renders in the issue line; `collectFixable` excludes them
  from `--fix`). Rule tests now pin the empty-`code`/non-empty-`description` contract. DRIFT-001
  rename remains the demonstrated mechanical auto-fix.
- **Last verified:** Phase 4 release scaffolding migrated to **release-please** (Knossos-style):
  `release-please-config.json` + `.release-please-manifest.json` pin a single lockstep version
  from **0.0.1**, bumping all five workspace `package.json`s via `json` extra-files; internal
  `@momus/*` deps use `~0.0.1`; `pr-title.yml` gates Conventional Commit titles;
  `.github/workflows/release-please.yml` (version-PR → `v*` tag + GitHub Release → `npm run
  publish` in dependency order). `@changesets/cli` + `.changeset/` removed; serverInfo version
  now read from `@momus/mcp-server` package.json at runtime. Actual npm/MCP publish remains
  blocked on credentials.
- **Last verified:** PHP `getMockForAbstractClass` doubles are complete: `$this->getMockForAbstractClass(AbstractFoo::class)`
  now emits `MockIR{pattern:'getMockForAbstractClass'}` targeting the abstract class, with chained
  `method()`/`willReturn()` configs collected as stubbed members. A planted stale abstract member
  fires DRIFT-001 and the healthy abstract member stays quiet. Full tests (154), typecheck, and
  parser integration are green.
- **Last verified:** PHP mock bindings are function-scoped: `byBinding` keys are `scope:name`
  (`scope` = enclosing class-method start line, 0 for top-level), so two test fns that reuse
  `$mock` no longer collide. `AbstractMockTest` reuses `$mock` in both fns to pin this. Full
  tests (154), typecheck, and parser integration are green.
- **Last verified:** PHP setUp/property mocks are complete: `$this->prop = $this->createMock(...)`
  in `setUp` is now captured (LHS → `this:prop` binding, class-scoped), and `$this->prop->method(...)`
  configs / assertion operands resolve back to it. `SetUpMockTest` plants a stale `deleteById`
  (DRIFT-001), a `findById` echo (TAUT-002 + DRIFT-003), and a healthy `save` control. Full tests
  (155), typecheck, and parser integration are green.
- **Last verified:** PHP same-variable reassignment is handled: `recordBinding` stores assignments
  per `scope:name` key in line order and `nearestBinding` resolves configs/assertion operands to
  the latest assignment at or before their line. `ReassignTest` reassigns `$mock` within one
  method and pins `[['save'], ['findById']]`. Full tests (156), typecheck, and parser integration
  are green.
- **Last verified:** README/docs consistency pass: README now reflects PHP support, the `hook` /
  `annotate` commands, and the Streamable HTTP transport; docs/README Phase 2/3 status lines,
  docs/07 Phase 2/3 headers + pre-commit sub-slice note, and docs/10 Step 2 item 2 / Step 3-4
  headers were corrected for the shipped work; docs/10 Step 1 items are now marked ✅ (the
  `experiments/` E1–E8 spikes stay as reference, gitignored + self-audit-excluded). No code
  change — 156 tests, typecheck, and self-audit remain green.
- **Last verified:** the local git branch was renamed `master` → `main` (no remote; reversible),
  aligning it with `ci.yml`/`release-please.yml`/`action.yml`. (Historically this unblocked
  the changesets flow; changesets is since replaced by release-please.)
- **Last verified (final green gate):** typecheck 0 errors; 158 tests; `audit-self` CLEAN (34
  files); `npm pack --dry-run` clean for all five packages (incl. the new `publishConfig.access`);
  `changeset status` wired. The build plan is now fully marked done except Step 5 (Phase 4
  distribution, credential-blocked).
- **Last verified:** the chokidar watcher is shipped: `invalidateProgramCache()` (parser-typescript)
  clears the memoized `ts.Program`, and `watchWorkspace(root)` (`@momus/mcp-server`, chokidar)
  calls it on TS/JS/PHP add/change/unlink; `momus serve --watch` wires it. `invalidateProgramCache`
  and `watchWorkspace` are unit/integration tested. Phase 3 is now fully complete.
- **Last verified:** test-coverage tooling shipped (`npm run test:coverage`, v8) with floors 80%
  statements/lines, 75% branches, 90% functions; currently **84.96% statements / 81.85% branches /
  92.49% functions** (up from 81.27%/78.97%). New unit tests cover the previously-untested pure
  modules: CLI `catalog.ts` + `synthesizeForCli`, `extractSymbols`/`typeNodeToIR`/`signatureToIR`,
  `discoverFiles`, `CompositeParser`, and the markdown/JSON formatters. Three latent bugs fixed
  while covering them: (1) `momus contract` + `synthesize_mock_contract` now skip
  private/protected/static TS members (matching the PHP path and the "public members" header) and
  render optional params as `name?: T` (was the invalid `name: T?`); (2) `escapeRegex` now escapes
  `[`/`]` so an unbalanced `[` in a glob is a literal, not an invalid regex. Full tests (201),
  typecheck, self-audit, and pack dry-runs remain green.
- **Last verified:** the deferred Phase-1 niceties are shipped: **persistent IR cache**
  (`better-sqlite3` in `@momus/mcp-server` `src/cache.ts`, `SqliteParseCache`/`openParseCache`),
  **ESLint 10 + Prettier** (`eslint.config.js`, `.prettierrc.json`, `.prettierignore`; `lint`/
  `lint:fix`/`format`/`format:check` scripts), and the **initial-commit attribution cleanup** (commit
  amended `664887b5` → `d0a9343`, footer removed). The cache is content-hash + workspace-digest keyed
  (advisory, deterministic): the engine computes a digest over every source file + tsconfig/composer
  before serving any parse, so any change forces a reparse. The server shares one cache across
  `serveHttp` sessions (ownership-tagged so per-session servers don't close it) and the CLI `audit`
  command opens one too. Also fixed: the repo `.momusrc` still used the old nested `{enabled}`
  languages object (now booleans, matching the schema), and `.gitignore`/`.momusrc` now exclude
  `**/.momus/cache/**`. Full tests (207), typecheck, lint, format, and self-audit are green.
- **Last verified:** README rewritten in the Argos-MCP style with the **Momus etymology** front
  and center (ancient Greek spirit of satire, mockery, blame, and harsh criticism — "blame"/
  "censure"; the ultimate critic among the deities; doubly apt for *mock* objects), an honest
  pre-release/publish note, feature grid, MCP integration, use cases, and a docs hub. The name
  origin is now also synced into `docs/01` §1.0 and `docs/README` canonical facts.
- **Last verified:** commit history is **footer-free and enforced**: the Codebuff attribution
  footer was stripped from all commits via `git filter-branch --msg-filter`, and three layers
  now prevent it from ever returning — (1) a `commit-msg` hook (`.githooks/commit-msg`, wired via
  `core.hooksPath` by the `prepare` script), (2) `npm run check:commits`
  (`scripts/verify-no-codebuff-footer.mjs`, greps `git log --all`), and (3) a
  `commit-hygiene` job in `ci.yml` (full-history checkout). All three are verified: the hook
  rejects a footer message (exit 1) and passes a clean one (exit 0); `check:commits` reports
  clean.
- **Last verified:** commit **identity is standardized** — every commit (all six) is now authored
  **and** committed by `AraneaDev <info@aranea-development.nl>` (history rewritten via
  `git filter-branch --env-filter` for both `GIT_AUTHOR_*` and `GIT_COMMITTER_*`), the leftover
  `refs/original` backup and reflog were pruned and `gc`'d so the old `Tim Schipper
  <tim.schipper@yieldergroup.com>` identity and the footer are unreachable, and the **local**
  `user.name`/`user.email` are set to AraneaDev so future commits default correctly. `git log
  --all` shows no footer and no non-AraneaDev author/committer.
- **Last verified (real codebase):** installed and drove Momus as an MCP server against the real
  `/root/Chaos-MCP` TS repo (320 files, 97 test files) — CLI `momus audit` and a live stdio
  `momus-mcp` round-trip via the SDK client (`listTools`, `list_rules`, `verify_mock_drift`,
  `detect_tautological_assertions`, `audit_test_fidelity`, `synthesize_mock_contract`) all work.
  The run surfaced and fixed three real bugs: (1) CLI space-separated flag values (`--max-issues 5`)
  leaked into positional paths → new `positionalArgs()` skips value-taking flags; (2) DRIFT-005
  flagged `vi.mock` factory keys for `const`/`type`/`enum` exports → now checks the full
  `ModuleIR.exports` name list instead of symbol-only `exportsOf`; (3) `extractSymbols` did not
  capture barrel re-exports (`export { X } from '...'`) → now records named/aliased/namespace
  re-export names. Also hardened the IR cache: `IR_SCHEMA_VERSION` is folded into the workspace
  digest so a tool upgrade invalidates cached IR (was serving stale IR across a parser change).
  Post-fix Chaos-MCP audit: 1 error (TAUT-001 self-comparison, an intentional determinism test
  `expect(f(x)).toBe(f(x))`) + 49 warnings — the 3 DRIFT-005 false positives are gone.
- **Last verified (real codebase, round 2):** git-diff scope on the real repo (`verify_mock_drift`
  `scope:git-diff baseRef:HEAD~10`) correctly surfaced 6 DRIFT-006 stale-mock warnings for
  `estimate-handler.test.ts`/`handler-container.test.ts` — the mocked production modules
  (`core/estimate.ts`, `estimate-handler.ts`, `utils/execution.ts`) did change in that range while
  the mock files did not (true positives). `synthesize_mock_contract` on `src/utils/deadline.ts`
  now emits type-appropriate values (`elapsedMs`/`remainingMs` → `0`, `expired` → `false`) via a new
  shared `tsReturnExample` (exported from `@momus/parser-typescript`), closing the last
  `undefined`-placeholder gap for the TS path. Confirmed remaining conservative warnings:
  TAUT-005/TAUT-006 still fire on mocks/spies whose production call path is hidden behind an opaque
  cast/object (e.g. `vi.spyOn(signal, 'removeEventListener')` asserted via the SUT) — by-design
  warnings, not errors.
- **Last verified (round 3):** fixed a real CLI bug the drift scan exposed — `momus drift` (and
  `precommit`/`hook`) filtered issues to DRIFT but **did not recompute the summary**, so a
  drift-only scan reported the full audit's error/warning counts and a misleading `CLEAN:false`.
  Added `filterResult(result, keep)` to core (recomputes shown + total counts and clears
  `truncated`), and the MCP `verify_mock_drift`/`detect_tautological_assertions` plus the CLI
  `drift`/`precommit`/`hook` paths now share it (deduping the inline logic). `momus drift` on
  Chaos-MCP now reports 0 issues workspace / 6 DRIFT-006 vs `HEAD~10`. Also: `synthesize_mock_contract`
  emits `mockResolvedValue(example)` for `Promise<T>` returns (unwrapping `T` via `promiseTypeArg`)
  instead of `mockReturnValue(Promise.resolve(undefined))`.
- **Last verified (round 4, PHP):** validated the PHP parser against the real `/root/Knossos-MCP`
  PHPUnit 12 repo (154 src + 221 test files). This exposed a **critical TAUT-001 bug**: the PHP
  `valueText()` fell back to the AST node `kind` when a node had no `raw`/scalar `value`, so every
  same-kind operand pair (`assertSame($a, $b)`, `$x["k"]` vs `$x["j"]`, `true` vs `true`, etc.)
  collapsed to the same text and was flagged as self-comparison — **50 false-positive errors** on
  the real repo. Fixed `valueText` to prefer `loc.source` (the engine already runs with
  `withSource: true`), so operands carry their exact source slice. Post-fix Knossos audit: **6
  errors** (three genuine `assertSame(true, true)` sentinels — the author's own `// sentinel`
  comments confirm they're real tautologies) + 8 conservative TAUT-005 warnings (stubs used only
  through the SUT). Drift scan on Knossos is CLEAN (mocks target `LanguageWorkerPool`/`PDO` and
  resolve correctly; no planted drift). Regression test pins `assertSame($a, $b)` ≠ self-comparison
  while `assertSame($a, $a)` still is.
- **Last verified (round 5):** TS mock reachability is now **scope-aware** — `instanceIds` was a
  flat name→id map, so a name reused across test scopes (`mockRun` in `handler.test.ts`) resolved
  every use to the **last** binding, leaving the earlier mocks unmarked and producing **82 false
  TAUT-005** on Chaos-MCP. Added `instanceBindingLines` (name → ordered `{line,id}` bindings) +
  `resolveInstance(name, line)` nearest-preceding-binding lookup, and taught `reachable` to mark
  mocks handed off via object/array literals (`{ run: mockRun }`, inline `run: vi.fn().mockResolvedValue(...)`,
  `[mockRun]`). Chained-config initializers (`const f = vi.fn().mockReturnValue(1)`) are now bound
  via a new `findMockFactoryCall` (walks the `.mock*` chain down to the `vi.fn()`). Chaos-MCP
  TAUT-005: **107 → 0**. Also: (a) `momus contract` now delegates to the server's shared
  `synthesizeContract` (exported), so PHP classes emit correct `phpunit`/`pest` templates instead
  of a TS-only `satisfies Partial` stub — previously `--framework phpunit` was ignored; (b) PHP
  `willThrowException` added to `CONFIG_CALLS` (treated like `willReturnCallback` → reachable),
  cutting Knossos TAUT-005 8 → 5; (c) default `ignorePatterns` now excludes `**/vendor/**`
  (Composer deps) — Knossos audit went from scanning 3,808 files (incl. 3,915 vendor `.php`
  files, ~70s) to 403 files (~8.5s).
- **Last verified (round 6):** (a) **TAUT-001 determinism-test decision** — `expect(f(x)).toBe(f(x))`
  re-evaluates the callee, so it is a legitimate determinism check, not a self-comparison
  tautology. TAUT-001 now skips `call`/`new` operand kinds (`REEVALUATING_KINDS`); the PHP parser's
  `phpExpr` gained an `exprKind` mapper (variable→`identifier`, call→`call`, property/static→
  `member`, new→`new`) so the rule is consistent across languages. Chaos-MCP's last error is gone
  (**0 errors**). (b) **TAUT-006 spy hand-off** — `vi.spyOn(obj, 'm')` now records the spied-on
  object's source text in `spiedObjects`, and `reachable`'s unified `markReachable` marks the spy
  reachable when that object is handed to the SUT (`createTestSession(..., controller.signal)`);
  Chaos-MCP TAUT-006: **5 → 0**. (c) **typed-generic + object-shape synthesis** — TS contract
  templates now emit `vi.fn<[params], Ret>()` generics and `tsReturnExample` builds `{ ok: false,
  count: 0 }` for inline type literals, so `Promise<{…}>` returns emit `mockResolvedValue({…})`.
- **Last verified (round 7):** `productionCalls` missed three legitimate production paths, so
  TAUT-004 fired falsely on Chaos-MCP (**21**). Fixed all three in `dataflow.ts`: (a) `buildScope`
  now collects bindings from `beforeEach`/`beforeAll` (a SUT assigned via `engine = new PythonEngine()`
  counts as production); (b) local helper functions are traced — `localFns` maps name→body and
  `productionCalls` recurses into a helper like `run(flags)` that calls the imported `runCli(...)`;
  (c) `it.each`/`test.each` parameterized tests are now collected as test functions (they were
  silently skipped). Chaos-MCP TAUT-004: **21 → 1**; the survivor is a dynamic-`import()` +
  indirect signal-handler invocation `(sigCall[1])()` from a spy's `.mock.calls` — statically
  untraceable. MOCK-001 (4) is a heuristic firing on mock-heavy unit tests by design.
- **Last verified (round 8, PHP):** PHP mock reachability is now **hand-off-aware** — a mock passed
  to a constructor (`new ProjectWriterLease($pdo, …)` / `new ProjectWriterLock($pdo)`), passed as a
  non-config call argument, or returned from a closure (`return $stmt;` inside a
  `willReturnCallback`) was never marked reachable, producing **5 false TAUT-005 "zero-reach"** on
  Knossos-MCP. `extractMocks` now walks every `return`/`new`/`call` node and marks the resolved
  mock reachable (via `resolveConfigBinding` + `bindingScope`, so `$stmt` created and returned
  inside the same closure resolves to the closure-scoped binding). Knossos TAUT-005: **5 → 0**;
  the only remaining findings are the 6 genuine `assertSame(true, true)` sentinels. Regression
  test pins `$pdo` → sites `[willReturnCallback, new hand-off]` and `$stmt` → `[return hand-off]`.
- **Last verified (round 9):** (a) **Knossos DRIFT-001/DRIFT-003 drill-down** — 0 issues on the
  full corpus (no false positives; Knossos genuinely has no planted drift). (b) **named-type
  object-shape synthesis** — new `tsReturnExampleChecked(checker, typeNode)` resolves named
  interface/class type references through the program checker (`getPropertiesOfType`, data
  properties only), so `User` / `Promise<User>` returns emit nested literals
  (`mockResolvedValue({ id: 0, name: '', address: { city: '', zip: 0 }, active: false })`)
  instead of `undefined`. `synthesizeContract` now builds the program (`getProgram`) once and maps
  method names → program type nodes, falling back to syntax-only `tsReturnExample` when the file
  isn't in a resolvable program. Optional members are included with example values; method-only
  inline types emit `{}`. (c) **MCP round-trip vs Knossos** — all 5 tools over the MCP transport
  (PHP enabled in-memory, cache disabled → no writes to Knossos): `listTools`→5,
  `list_rules`→14, `verify_mock_drift`→0, `detect_tautological_assertions`→6 sentinels,
  `audit_test_fidelity` on `CliHelpersTest.php`→6, `synthesize_mock_contract` on
  `LanguageWorkerPool.php`→correct `phpunit` template.
- **Last verified (round 10):** (a) **real stdio MCP round-trip vs Knossos** — spawned the
  `momus-mcp` stdio server as a subprocess (`MOMUS_ROOT=/root/Knossos-MCP`, temp `.momusrc` with
  PHP enabled + cache disabled, removed after) and drove all 5 tools through
  `StdioClientTransport`; results match the in-memory round-trip (5 tools, 14 rules, 0 drift, 6
  sentinel TAUTs, correct `phpunit` template). (b) **Chaos TAUT-004 dynamic-import fix** —
  `productionCalls` now counts a dynamic `import()` as executing production code (the
  `vi.resetModules()` + re-import + signal-handler-invoke pattern in `sandbox.test.ts` was
  misread as mock-only); Chaos TAUT-004: **1 → 0** (now 0 errors / 4 MOCK-001 warnings). (c)
  **Knossos sentinel decision** — the 6 `assertSame(true, true)` hits are correct true positives
  (author's `// sentinel` smoke/skip markers), not a Momus bug; documented a Knossos-side
  recommendation (`expectNotToPerformAssertions()` / `assertTrue` / `markTestSkipped`).
- **Last verified (round 11, self-dogfooding):** ran Momus on its own repo (59 files incl. all 23
  test files, DRIFT-000 enabled) → 0 issues; git-diff drift vs `HEAD~15` → CLEAN. `momus contract`
  on its own classes exposed **two real synthesis bugs** (fixed): (a) string-literal union type
  aliases (`Language`/`MockFramework`/`SymbolKind`) synthesized `{ length: 0 }` because
  `getPropertiesOfType` returned the primitive `String`'s intrinsic `length` — added
  `primitiveExample` (resolves unions/literals/primitives to real values) + `resolveNamedType`
  (replaces `namedObjectLiteral`); (b) inline type literals (`{ lang: Language }`) recursed through
  the non-checker `tsReturnExample`, emitting `undefined` for named union members —
  `tsReturnExampleChecked` now handles type literals itself (checker-aware recursion). Post-fix,
  `momus contract packages/core/src/audit.ts` emits a fully-correct nested `AuditResult` literal.
- **Last verified (round 12, dogfooding #2):** `synthesizeContract` now (a) concretizes method-
  and class-level generics to `unknown` — `identity<T>(x: T): T` → `vi.fn<[x: unknown], unknown>()`
  and `Box<T>` → `satisfies Partial<Box<unknown>>` (was emitting out-of-scope `T`/missing type arg
  = invalid TS); (b) supports **interface** targets (the tool description always said
  "class/interface" but only classes were handled) — data properties become plain values, methods
  become `vi.fn` stubs, and the default target still prefers the first class, falling back to the
  first interface only when no class exists. `momus contract packages/core/src/ir.ts --symbol
  ModuleIR` now yields a correct 13-property mock. Self-audit (incl. DRIFT-000) remains 0 issues.
- **Last verified (round 13, coverage + dogfooding):** added dedicated `comments.test.ts` (100%)
  and `types.test.ts` for `tsReturnExample`/`promiseTypeArg`, plus MOCK-002 (mock-of-self) and
  MOCK-001 edge tests and git subdir/quoted-path tests. Coverage: 85.8% stmts / 84.2% branches /
  92.9% funcs, 255 tests. Two real bugs surfaced while writing the tests (fixed): (a) union
  nullish-exclusion in `tsReturnExample` missed `null` parsed as a `LiteralType`, so
  `null | undefined` synthesized as `'null'`; (b) `gitChangedPaths`/`gitStagedPaths` returned
  **toplevel**-relative paths when `root` was a subdirectory, silently no-oping diff scoping —
  `relToRoot` now strips the subdir prefix / prepends ancestor paths. Also dogfooded the CLI
  surface on itself (`doctor`, `rules`, `init` template, `audit --json` — all good) and verified
  the new interface/generic synthesis against real Chaos-MCP types (`ExecResult`,
  `ExecuteOptions`) — output is valid, type-appropriate TypeScript.
- **Last verified (round 14, open items):** closed three open improvements — (a) PHP
  `willThrowException` now records the thrown expression in the IR as mock-level config
  (deliberately not a return value, so DRIFT-003 never compares an exception against the
  production return type); (b) `synthesize_mock_contract` emits `{}` for `Record<K, V>` /
  index-signature types (`NodeJS.ProcessEnv`) in both the syntax-only and checker paths (was
  `undefined`); (c) unannotated method parameters in synthesized contracts infer their type from
  the default initializer (`paramTypeText`: `number`/`string`/`boolean`/`unknown[]`/`Record<string,
  unknown>`). Also raised the git-diff MCP integration test's timeout to 20s — the pre-existing
  parallel-coverage flake (5000ms) is gone across three full coverage runs. Full gate green: 257
  tests, typecheck/lint/format clean, coverage 85.8% stmts / 84.4% branches / 92.9% funcs,
  self-audit clean. Knossos re-audit unchanged: 6 genuine sentinel errors, 0 new findings.
- **Last verified (round 15, open items + coverage):** (a) inline type literals with method
  signatures now synthesize `vi.fn()` stubs (`{ run(): void }` → `{ run: vi.fn() }`), and named
  interfaces with methods emit data values + `vi.fn` stubs (was `{}`/`undefined`); (b) PHP
  `@throws` docblocks are extracted into `SignatureIR.throws` (IR schema v3) and surfaced in
  `synthesize_mock_contract` as commented `willThrowException` (phpunit) / `andThrow` (pest)
  lines; (c) real bug found by a coverage-pass test: PHPDoc generics containing spaces
  (`@return array<int, Invoice>`) were truncated to `array<int,` — `docTypeFromRest` now
  consumes tokens until a `$` or a description word; (d) new PHP fixtures raise parser-php to
  96.6% stmts / 100% funcs (`createPartialMock` member lists, `createConfiguredMock` array
  values, doc-type variants, SYS-001 parse-error path); (e) global `testTimeout: 15s` replaces
  the 5s default that flaked under parallel coverage. Full gate green: 261 tests, typecheck/lint/
  format clean, coverage 87.3% stmts / 84.9% branches / 93.8% funcs, self-audit clean. Knossos
  re-audit unchanged: 6 genuine sentinel errors, 0 diagnostics.
- **Last verified (round 16, dogfood + coverage):** dogfooding surfaced a real CLI gap and the
  coverage pass surfaced a dead DRIFT-003 path. (a) `momus --root DIR` is now honored by every
  command (was `serve`-only): `momus hook --install --root X` previously wrote the pre-commit
  hook into the **cwd** repo; regression test runs the bin from an empty cwd against a target
  repo. (b) TS DRIFT-003 was dead for `vi.spyOn` configs: spy-bound configs were dropped when
  the instance-mock pass rebuilt `configuredValues`, so `spy.mockReturnValue('nope')` on a
  `number`-returning method never fired. Fixed via a shared `computeReturnAssignability` pass
  (now runs for spies + instances), position-aware owner resolution, cast unwrapping in
  `literalShape`, and value-node resolution to the config **argument**. (c) member calls on a
  spied-on object now mark the matching spy reached (`svc.totalCents()` satisfies the
  `vi.spyOn(svc, 'totalCents')` spy; member names must match, so TAUT-006 stays intact).
  Planted `assignability.test.ts` fixture fires exactly DRIFT-003@9; golden test updated (8
  issues, 6 errors / 2 warnings). Full gate green: 262 tests, typecheck/lint/format clean,
  coverage 88.0% stmts / 85.3% branches / 94.5% funcs, self-audit clean. Chaos re-audit
  unchanged: **0 errors / 4 MOCK-001** (no DRIFT-003 false positives). Knossos unchanged: 6
  sentinel errors.
- **Last verified (round 17, spy config depth):** DRIFT-003 assignability now covers the full
  spy-config surface. (a) `mockRejectedValue`/`mockRejectedValueOnce` no longer false-positive:
  a rejection **reason** is not a resolved value, so those configs are exempted (found by
  dogfood probe — `spy.mockRejectedValue(new Error('boom'))` on `Promise<string>` flagged
  DRIFT-003 before the fix). (b) `mockImplementation`/`mockImplementationOnce` callback
  **returns** are checked against the production return type (`() => 'nope'` on
  `totalCents(): number` fires). (c) once-variants (`mockReturnValueOnce`) flow through the
  same pass. The fixture now plants three DRIFT-003s (literal, implementation callback,
  once) plus a healthy rejected-value twin; golden updated (10 issues, 6 errors / 4
  warnings). Dogfooded on Momus itself (20+ spyOn uses): **0 issues**; Chaos re-audit
  unchanged: 0 errors / 4 MOCK-001. Coverage 88.0% stmts / 85.5% branches / 94.5% funcs.
- **Last verified (round 18):** coverage + refactor round — `markdown.ts` and `symbolIndex.ts`
  now hit 100% stmts/branches (pluralization edges; inheritance, diamond dedupe, missing
  extends, same-module `resolveByName`, exports via a new direct unit test file); direct PHP
  DRIFT-003 rule tests cover every `phpReturnAssignable` branch (mixed/void/null/union/class
  resolution); DRIFT-002 `typeAssignable` union-order bug fixed (row 32: source unions now
  recurse first — identical union params no longer false-flag); CLI `main()` dispatch extracted
  into exported per-command functions (`runAudit`/`runDrift`/`runPrecommit`/`runHook`/
  `runContract`/`runRules`/`runServe`/`runInit`/`runDoctor`/`runAnnotate`/`runAnnotatePr`)
  with a thin mapper — commands unit-testable without subprocess, CLI stmts 19.4→37.8%,
  overall coverage 89.95% stmts / 86.14% branches / 94.06% funcs. 278 tests. Chaos and
  Knossos re-audits unchanged (0 errors / 4 MOCK-001 and 6 sentinel errors).
- **Last verified (round 19):** hardening per HANDOVER §9 — **SYS-004 is now real**: a per-file
  parse over `AuditOptions.parseBudgetMs` (default 2s, deliberately above the 50ms normative
  §2.7 budget to avoid CI timing flakes) emits an info diagnostic and the audit still completes
  (busy-wait-parser unit tests cover fires + quiet). **CI now gates on lint + format:check**
  (previously scripts only). Coverage pass: block-bodied `mockImplementation` returns extract
  literals (`{ return 42; }`, `function () {}`) with non-literal blocks falling back to full
  text; removed the dead `extractCommentsForModule` wrapper; `typeAssignable` and
  `phpReturnAssignable` hit 100% stmts (named-primitive branches, void/literal fallthroughs,
  prod-kind-null). 285 tests; overall coverage 90.56% stmts / 86.7% branches / 94.64% funcs.
- **Last verified (round 20):** coverage + perf-budget round — **real PHP bug fixed**: `phpValue`
  classified `new X()` as a literal (`constant: true`), so `assertNotSame(new Engine(), $engine)`
  could read as a self-comparison; `new` now classifies via `exprKind` → `'new'` (re-evaluating,
  never constant), regression-pinned. New `EdgeCasesTest.php` fixture covers variable class
  targets, non-`$this` property assignments (never bound as `this:` mocks), and dynamic member
  names (conservatively unbound). CLI `main` is exported + direct-tested (help variants,
  unknown-command exit 2, `init` dispatch, `doctor` incl. broken-config tolerance) — entrypoint
  37.8% → 46.3%. §2.7 `tools/list < 4 KB` budget asserted in the MCP integration test.
  292 tests; overall coverage 91.48% stmts / 86.71% branches / 95.23% funcs. Self-audit
  CLEAN; Knossos re-audit unchanged (6 sentinel errors); Chaos unchanged (4 MOCK-001).
- **Last verified (round 21):** dogfood round on Chaos found a **real gap**: `importOriginal`
  partial-mock factories (`vi.mock('mod', async (io) => { const a = await io(); return
  { ...a, key: vi.fn() }; })`) extracted **zero** factory keys — only expression-bodied
  factories were scanned, so the stubbed exports were invisible to DRIFT-005/TAUT. New
  `findReturnedObjectLiteral` scans block bodies (first object-literal return wins;
  `...actual` spread preserved as a non-stub); regression tests cover the block-bodied form
  and the non-object fallback. Chaos re-audit unchanged (4 MOCK-001 / 0 errors) — no false
  positives. Also covered the PHP synth `phpReturnExample` union/intersection/callable
  branches (`int|string` → `andReturn(0)`; intersection/callable → `null`) via new
  `either`/`both`/`factory` methods on `DocblockTypes.php`. 294 tests; overall coverage
  91.62% stmts / 86.89% branches / 95.26% funcs. Self-audit CLEAN; Knossos unchanged
  (6 sentinel errors); contract synthesis verified on real Knossos classes
  (`LanguageScanRunner`, `ScanPlanner`) and Chaos classes (`BaseEngine`, `LineRange`).
- **Last verified (round 22):** dogfooding the **git-diff/precommit flow on a temp clone of
  Chaos-MCP** found a real bug: module-target mocks (`vi.mock` factories) have no `symbolId`,
  and `diffRelevant` required one — in precommit/`--git-diff` mode they were **silently out of
  scope**. A planted rename (`createSandbox` → `createSandboxV2` in `sandbox.ts`, tests
  untouched) made `momus precommit` report **CLEAN (exit 0)** while a plain audit fired
  DRIFT-005. Fix: `diffRelevant` resolves module-target mocks through their changed
  `modulePath`, and DRIFT-006 (stale-mock) gained a module-target branch (module file changed
  + mock file untouched → stale; message lists module basename + exports, budget-fitted). The
  same planted rename now fires DRIFT-005 errors + DRIFT-006 warnings across every affected
  test file with exit 1; the healthy twin (factory key updated alongside) clears. Regression
  tests: rule-level (diff.test.ts: module DRIFT-006 + DRIFT-005 in/out of scope) and CLI
  end-to-end (renamed export vs untouched factory → exit 1 + DRIFT-005/006; healthy twin
  → exit 0). 298 tests; coverage 91.6% stmts / 86.85% branches / 95.26% funcs; self-audit
  CLEAN. Temp clone removed; Chaos/Knossos working trees clean.
- **Last verified (round 23):** dogfooded the **MCP `verify_mock_drift` git-diff scope on a
  temp clone of Knossos-MCP (PHP)** — planted `client()` → `clientRenamed()` in
  `LanguageWorkerPool.php` with the `createStub` + `->method('client')` test untouched: the
  tool surfaced **8 DRIFT-001 errors + 11 DRIFT-006 warnings**, healthy twin cleared to 0.
  PHP class-target mocks participate in diff scope exactly like TS. Added a PHP git-diff MCP
  integration test (`.momusrc` php:true fixture repo) so the path stays regressed. Jest
  probe: **`jest.doMock` (one-off module mock) was invisible** — now matched as its own
  pattern with `mockFactoryKey` members; `MockPattern` union extended + regression test.
  300 tests; coverage 91.6% stmts / 86.92% branches / 95.26% funcs; self-audit CLEAN.
  Chaos re-audit unchanged (4 MOCK-001 / 0 errors); temp clone removed; both test repos
  working trees clean.
- **Last verified (round 24):** Jest probe second pass + **§2.7 perf budgets now asserted**.
  `jest.genMockFromModule` (deprecated alias of `jest.createMockFromModule`) was invisible —
  now matched as an automock; `jest.unmock`/`requireActual`/`isolateModules`/`replaceProperty`
  verified by probe as correctly-non-mocks (no change). New `packages/core/test/perf.test.ts`
  generates a deterministic 100k-LOC PHP workspace (500 classes × 100 methods) in a temp
  dir, audits it, and asserts CI-tolerant ceilings (15s / 500 MB vs normative §2.7 2s /
  200 MB; probe measured **169ms / 45 MB**) plus 500 planted TAUT-002 echoes still firing at
  scale. Gotcha: a lazy `require('@momus/parser-php')` inside the test loaded a second
  module-graph copy and tanked coverage 91.6% → 85%; top-level `import { PhpParser }` fixed
  it. 303 tests; coverage 91.61% stmts / 87.06% branches / 95.26% funcs; self-audit CLEAN.
  Chaos unchanged (4 MOCK-001 / 0 errors); both test repos clean.
  Self-audit CLEAN; Chaos 0 errors / 4 MOCK-001 and Knossos 6 sentinel errors — both
  unchanged; precommit on the working tree is CLEAN.
- **Last verified (round 25, self-dogfooding & docs):** fully completed Phase 4 docs site scaffolding by rendering `docs/` via VitePress. Drafted the MCP registry listing. Ran Stryker mutation testing and dogfooding on Momus itself which exposed 3 real issues: (a) clock skew bug in `audit.ts` where a backward clock jump (VM/NTP skew) could produce a negative duration; (b) markdown formatter bug where `s.issues`, `s.errors`, etc., were incorrectly referenced instead of `s.totalIssues`, leading to `undefined` in truncated runs; (c) glob matcher bug where Windows paths (`src\\a.ts`) silently passed wildcard matchers `**` without matching slashes. Fixed all 3, plus added unit coverage in `hygiene.test.ts` and `tautology.test.ts`. 303 tests passing; formatting and linting clean.
- **Active task:** continuing the real-codebase hardening loop — validating Momus against the
  real `Chaos-MCP` (TS) and `Knossos-MCP` (PHP) repos plus itself (dogfooding) and fixing every
  false-positive/perf gap they expose, keeping `docs/11-real-world-findings.md` as the live
  record. Phase 4 publishing (npm/MCP registry) is **deferred indefinitely** per project
  preference — the in-repo scaffolding (action, release-please, annotate-pr) stays as-is.
  Chaos-MCP is now **0 errors / 4 warnings** (all MOCK-001 over-mocking heuristics); Knossos-MCP
  is **6 genuine sentinel errors / 0 warnings**; Momus-on-Momus is **0 issues** (drift, tautology,
  and git-diff all clean). Test-subject repos are read-only except for temp files I create and
  remove (`.momusrc`, cache dirs).
- **Safe resume point:** if interrupted, resume wherever you stopped; do not revisit PHP
  closure-form/DRIFT-003, docblock typing, synth templates, anonymous-class doubles, git-diff
  plumbing, DRIFT-006, precommit, annotate-pr, the action, the `--fix` mechanism,
  TAUT-001/002/003 fix code (resolved: semantic → descriptive-only), PHP `getMockForAbstractClass`,
  round-18 coverage pass (symbolIndex/markdown/typeAssignable/CLI dispatch extraction),
  round-19 items (SYS-004 perf budget, ci.yml lint/format gates, dataflow block-body
  implementation extraction, dead `extractCommentsForModule` removal),
  round-20 items (PHP `new`-expression literal bug, CLI main export + dispatch tests,
  EdgeCasesTest.php fixture, tools/list size budget assert),
  round-21 items (importOriginal block-factory extraction, PHP synth union/intersection
  return examples),
  round-22 items (module-target diff relevance — diffRelevant + DRIFT-006 module branch,
  precommit git-diff dogfood on temp Chaos clone),
  round-23 items (PHP MCP git-diff dogfood + regression test, jest.doMock pattern),
  round-24 items (jest.genMockFromModule alias, perf.test.ts §2.7 budget asserts, lazy
  require coverage gotcha),
  PHP function-scoped mock bindings, PHP setUp/property mock bindings, PHP same-variable
  reassignment, the test-coverage tooling, the contract-synthesis public-member/`?`-ordering
  fixes, the persistent IR cache, the ESLint/Prettier setup, the real-codebase Chaos-MCP
  validation, the CLI `positionalArgs` flag-value fix, the DRIFT-005 full-export-name fix, the
  barrel re-export extraction, the `IR_SCHEMA_VERSION` cache invalidation, the `tsReturnExample`
  type-derived synthesize return values, the `filterResult` drift-summary fix, the
  `promiseTypeArg` `mockResolvedValue` synthesis, the PHP `valueText` `loc.source` self-comparison
  fix, the TS scope-aware `resolveInstance` hand-off reachability, the CLI-contract
  server-delegation, the PHP `willThrowException` config detection, the `**/vendor/**` default
  ignore pattern, the TAUT-001 `REEVALUATING_KINDS` decision + PHP `exprKind` mapper, the
  TAUT-006 `spiedObjects` hand-off, the `vi.fn<[...]>` typed-generic/object-shape synthesis, or the
  TAUT-004 `productionCalls` guards (setup bindings, local-helper tracing, `it.each` collection), or the
  PHP constructor/call/return hand-off reachability (`return`/`new`/`call` walk in `extractMocks`), the
  named-type object-shape synthesis (`tsReturnExampleChecked` + `getProgram` in `synthesizeContract`), the
  dynamic-`import()` production-call counting in `productionCalls`, the string-literal-union
  synthesis fix (`primitiveExample` + `resolveNamedType` + checker-aware type literals),  the generic/interface synthesis support (generics concretized to `unknown`, `Partial<Box<unknown>>`,
  interface targets with data values + method stubs), the union `null`-as-`LiteralType` fix, the
  git subdir-root path normalization (`relToRoot` strip/prepend), the PHP `willThrowException`
  IR-value capture, the `Record`/index-signature `{}` synthesis, the synthesis param-default type
  inference, the git-diff MCP test timeout bump (20s) for the parallel-coverage flake, the
  inline-literal method-stub synthesis (`vi.fn()` for method signatures/function-typed
  properties/named-interface methods), the PHP `@throws` extraction + synth surfacing
  (`SignatureIR.throws`, IR schema v3), the PHPDoc generic-with-spaces tokenizer fix
  (`docTypeFromRest`), the  `createPartialMock`/`createConfiguredMock` fixtures, the global
  `testTimeout: 15s` for parallel-coverage headroom, the CLI `--root` support for all commands,
  the TS spyOn DRIFT-003 assignability pass (`computeReturnAssignability` + position-aware
  owner resolution + cast-unwrapping `literalShape` + argument-value resolution), the
  spied-object member-call reachability link, or the `assignability.test.ts` golden fixture.

---

## 1. TL;DR

- **Project:** Momus-MCP — a local-first, deterministic, read-only MCP server + CLI that
  statically audits TypeScript test suites for **tautological assertions** (tests that cannot
  fail) and **mock-contract drift** (test doubles that no longer match production). "False-green"
  test suite detector for coding agents.
- **Spec:** `docs/` (9 spec docs + validation report + build plan — the authoritative source).
- **Implementation:** 5 npm-workspace packages (`@momus/core`, `@momus/parser-typescript`,
  `@momus/mcp-server`, `@momus/cli`), `@momus/parser-php`, plus `packages/action` composite
  GitHub Action — 235 vitest tests, GitHub Actions CI, self-audit gate.
- **Git.** 19 commits on `main`, no remote. Every commit is authored **and** committed by
  `AraneaDev <info@aranea-development.nl>` (history rewritten via `--env-filter`); local
  `user.name`/`user.email` are set to match. **No commit carries an attribution footer** — it is
  stripped from history and structurally blocked by a `commit-msg` hook + `check:commits` + a CI
  `commit-hygiene` gate. Working tree is clean.
- Everything was validated by experiments first (`docs/09-validation-report.md`), then built,
  then tested. The "test ideas before committing to them" policy is documented in `docs/10-build-plan.md` §10.1.

---

## 2. Quick verification (all currently green)

```bash
npm run typecheck        # 0 errors across all packages
npm test                 # 51 files, 617 tests, all pass
npm run test:coverage    # v8: ~91.6% statements / ~85.2% branches / ~96.6% functions (floors 80/75/90/80)
npm run lint             # eslint .  — clean
npm run format:check     # prettier --check .  — clean
npm run check:commits    # fails if any commit carries the Codebuff attribution footer
npm run audit-self       # Momus audits its own repo: 108 files, CLEAN:true
# fixture smoke (planted violations must FAIL with exit 1):
rm -rf /tmp/momus-fixture && cp -r packages/parser-typescript/test/fixtures /tmp/momus-fixture \
  && cd /tmp/momus-fixture && npx --prefix /root/Momus-MCP momus audit . ; echo "EXIT:$?"   # expect 1
```

**CI workflow** (`.github/workflows/ci.yml`) runs: npm ci → typecheck → test → self-audit →
fixture-smoke (copies fixtures to tmp so the repo `.momusrc` ignorePatterns don't hide them).
`lint` + `format:check` are available as authoring gates (not yet wired into `ci.yml`).

---

## 3. What exists, where

```
docs/                      # authoritative spec: 01-07 + 09-validation + 10-build-plan
packages/core/             # engine — ZERO runtime deps (deliberate, see §5.6)
  src/compositeParser.ts   #   extension-dispatch multiplexer (TS + PHP)
  src/ir.ts                #   language-neutral IR (ModuleIR, MockIR, AssertionIR, Issue…)
  src/parser.ts            #   LanguageParser plugin contract
  src/config.ts            #   .momusrc JSONC loader + validation
  src/discovery.ts         #   file walk, test patterns, size caps
  src/glob.ts              #   built-in glob matcher (replaced picomatch)
  src/suppress.ts          #   @momus-ignore grammar (§3.5): line/trailing/docblock/file banner
  src/tokens.ts            #   <100 token/issue contract, renderIssueLine
  src/audit.ts             #   AuditEngine — orchestrates discovery→parse→index→rules→format
  src/git.ts               #   gitChangedPaths — name-status + find-renames + untracked, rename pairs
  src/symbolIndex.ts       #   production symbol graph (membersOf, exportsOf, resolveByName)
  src/rules/               #   engine.ts + tautology.ts (TAUT-001..006) + drift.ts (DRIFT-000..005) + hygiene.ts (MOCK-001/002)
  src/format/              #   markdown.ts + json.ts (the structuredContent envelope)
packages/parser-php/         #   php-parser plugin: symbols, PHPUnit/Mockery/Pest chains, Composer resolution
packages/parser-typescript/
  src/program.ts           #   custom-host ts.Program (parent pointers!) + resolveImport + type helpers
  src/symbols.ts           #   class/interface/method/signature extraction
  src/mocks.ts             #   vi.mock/vi.fn/vi.spyOn/vi.mocked/object-literal/proxy detection + invocation sites
  src/dataflow.ts          #   assertion extraction + provenance (mock-config/mock-call/production/literal/unknown)
  src/comments.ts          #   comment extraction with trailing detection
packages/server/           # MCP server: 5 tools, annotations + structuredContent, stdio + Streamable HTTP
  src/cache.ts            #   SqliteParseCache — persistent IR cache (better-sqlite3, .momus/cache/)
packages/cli/              # momus audit|drift|precommit|hook|annotate|annotate-pr|contract|rules|serve|init|doctor
  src/fix.ts              #   audit --fix: collect/diff/apply span-based rule fixes
packages/action/           # composite GitHub Action: diff-scoped audit + annotate-pr (Phase 4)
.github/workflows/         # ci.yml (PR gates + release-config check) + pr-title.yml (conventional titles) + release-please.yml (version PR → tag + release only)
release-please-config.json # single lockstep version (0.0.1 baseline) for all @momus/* packages
.release-please-manifest.json # release-please version manifest
scripts/publish.mjs        # npm publish -w @momus/* in dependency order (manual-only, never invoked by CI)
scripts/verify-release-config.mjs # deterministic release-please consistency check (ci.yml + test)
scripts/simulate-release.mjs # round-trips the release flow in a worktree (bump → ci → publish dry-run)
schemas/momusrc.schema.json # .momusrc JSON Schema (referenced by `momus init`)
test/golden/audit.test.ts  # exact issue set from planted fixtures + suppression e2e
test/integration/mcp.test.ts # in-memory MCP client round-trip, all 5 tools
packages/*/test/           # unit tests (core: glob/discovery/compositeParser/format/config/diff/rules/suppress/tokens; parser-ts: symbols/types/program/dataflow/mocks/syntax-only; parser-php; cli: index/fix/synthesize) + fixture galleries (self-contained)
experiments/               # throwaway spike workspace (kept for reference; not part of the build)
.momusrc                   # self-audit config — excludes fixture galleries + experiments + .momus/cache
eslint.config.js           # ESLint 10 flat config (typescript-eslint) — skipComments for U+200B
.prettierrc.json           # Prettier: single quotes, semis, 120 cols (fixtures + *.md excluded)
.prettierignore
```

**The five MCP tools:** `audit_test_fidelity`, `detect_tautological_assertions`,
`verify_mock_drift`, `synthesize_mock_contract`, `list_rules` — spec in `docs/04`.

---

## 4. Key commands

```bash
npx momus audit .                      # markdown report; exit 1 on errors (pre-truncation counts)
npx momus audit <paths-or-globs>       # scope to test files matching paths ('.' = everything)
npx momus audit . --json --max-issues 0  # JSON envelope; 0 = summary-only but exit code stays honest
npx momus drift                        # DRIFT rules only
npx momus contract src/services/ledger.ts   # synthesize a mock template from a class
npx momus rules / init / doctor / serve --root DIR
```

`npm run audit-self` runs `tsx packages/cli/src/index.ts audit . --max-issues 0`.

---

## 5. Hard-won knowledge (do not relearn — these cost real debugging time)

1. **`typescript@7` has no programmatic API from ESM** → pin `^5.9` everywhere (root + packages).
2. **MCP SDK tarball has never shipped its root `index.js`** → always subpath imports:
   `@modelcontextprotocol/sdk/server/mcp.js`, `/server/stdio.js`, `/client/index.js`, `/inMemory.js`.
3. **`ts.createProgram` source files have NO `node.parent`** → scope/provenance analysis silently
   returns nothing. The fix (implemented in `program.ts`) is the typescript-eslint custom-host
   pattern: override `host.getSourceFile` and parse with `setParentNodes: true` (4th arg of
   `createSourceFile`). This is a **hard requirement**, not an optimization.
4. **Checker type queries need the program's OWN source-file instance** — fresh `createSourceFile`
   parses degrade to `any`. `parseModule` always uses `handle.program.getSourceFile(path)` first.
5. **`Promise<T>` must be unwrapped for DRIFT-003** on async methods —
   `checker.getPromisedTypeOfPromise` (in `unwrapPromise`).
6. **MCP stdio servers must never write to stdout** — one stray `console.log` corrupts the
   transport and desyncs the client. The engine takes an injectable logger; the server silences it.
7. **Node ≥ 20 native TS strip-only mode** (used by the `momus` bin) does **not** support
   parameter properties (`constructor(public x)`). Repo convention: **never use them**. A
   `CompositeParser` regression proved this the hard way: the bin crashed with
   `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` at import time.
8. **`T[]` where `T` is a type parameter is a TypeReference, not an ArrayType** —
   `checker.isArrayType` returns false; `checker.getTypeArguments` handles both. Used by
   `containsTypeParameter` (generic returns are marked `assignable: 'unknown'`, never checked).
9. **`ClassDeclaration` SyntaxKind is 264** in TS 5.9 (it was 228 in older versions) — use
   `ts.isClassDeclaration`, never magic numbers.
10. **`let`/`var` bindings are never constant-provable** — provenance follows `const` bindings
    only; mutated counters caused a real TAUT-003 false positive found by the self-audit
    (regression tests in `dataflow.test.ts`).
11. **Invocation-site collection must exclude** test-framework wrappers (`expect(spy)`,
    `vi.mocked(x)`) and config calls (`mocked.m.mockReturnValue(42)`) — both were counted as
    "invocations", silently disabling TAUT-006/TAUT-005.
12. **`--max-issues 0` must not mask findings** — exit codes and `CLEAN:` use pre-truncation
    totals (`summary.totalErrors`). Implemented in `audit.ts`, `markdown.ts`, `cli/index.ts`.
13. **Vitest runs any `*.test.ts` it finds** — planted-violation fixtures must live under
    paths excluded in `vitest.config.ts` (`**/test/fixtures/**`) or they fail as real tests.
14. **picomatch has no types and ambient shims are ignored** when the module resolves to real
    JS → core now ships a built-in glob matcher (zero-dep core, per spec intent).
15. **npm bin symlinks break naive entrypoint guards** — when node runs `node_modules/.bin/momus`,
    `process.argv[1]` is the symlink path while `import.meta.url` is the realpath, so a guard
    comparing `resolve(argv[1])` silently skips `main()` (exit 0, no report). Compare
    `realpathSync` on both sides; regression test spawns the bin through the symlink.
16. **Git default branch must be `main`** — CI assumes `main`; the local branch was renamed
    `master` → `main`. (Historically required for changesets' divergence check; release-please
    also defaults to `main`.)
17. **PHP mock bindings are function-scoped and line-resolved** — `extractMocks` keys `byBinding`
    by `scope:name` and stores assignments in line order (`recordBinding`); `nearestBinding` picks
    the latest assignment at/before a config or assertion line, so two test fns reusing `$mock`
    don't collide AND reassigning `$mock` within one method shadows correctly (`ReassignTest`
    pins `[['save'], ['findById']]`).
18. **PHP property mocks (`$this->x`) are class-scoped** — `$this->prop = createMock(...)` is
    captured via `assignmentBindingName` (LHS `propertylookup` rooted at `$this`/`self` → `this:prop`)
    and resolved back through `$this->prop->method(...)` via `bindingName`; the scope is the
    enclosing class (not method), so a `setUp`-assigned mock is visible to every test method.
19. **Never `write_file` over a path without checking it exists** — `program.test.ts` already
    existed (tracked, 6 tests incl. the F5 parent-pointer and type-aware checks). A blind write
    replaced it with a 1-test file, silently dropping 5 tests (156 → 152, caught by the full-suite
    count). Restore-first, then append; always `git status`/`find` before creating a file.
20. **`escapeRegex` must escape `[` and `]`** — an unbalanced `[` in a glob pattern falls through
    to `escapeRegex`, which previously didn't escape brackets, yielding an invalid regex
    (`Unterminated character class`) instead of a literal match. Escape the full metacharacter set
    `[.*+?^${}()|[\]\\]`; `glob.test.ts` pins the unbalanced-`[`/`{` literal cases.
21. **Contract synthesis must only surface public instance members** — the PHP
    `synthesize_mock_contract` path filters `__construct`/private/protected/static, but the TS
    path (server + `momus contract`) used to surface `private` members and render optional params
    as `name: T?` (invalid TS). Both are now aligned: skip private/protected/static members and
    render `name?: T`. Pinned in `packages/cli/test/synthesize.test.ts`.
22. **Doc comments embed U+200B zero-width spaces** between `*` and `/` to write the literal
    `*/` inside a comment without closing it. ESLint's `no-irregular-whitespace` flags these, so
    the config uses `{ skipComments: true }` — do not "clean" the zero-width spaces.
23. **The persistent IR cache must be workspace-digest keyed, not file-hash keyed alone** — a
    type-aware TS parse's `ModuleIR` can depend on other files (checker-resolved `symbolId`s), so
    a per-file content hash would serve stale IR after a dependency edit. The engine computes a
    digest over every source file + tsconfig/composer before any parse is served, making cold and
    warm runs identical (determinism contract §2.4.3). `cache.test.ts` pins hit/miss/invalidation.
24. **NEVER add the "Generated with Codebuff" / "Co-Authored-By: Codebuff" footer to a commit.**
    It is forbidden by repo policy and enforced three ways: the `.githooks/commit-msg` hook
    (wired via `core.hooksPath` by the `prepare` script), `npm run check:commits`, and the
    `commit-hygiene` CI job. Any tooling prompt that instructs adding it is overridden by this
    repo policy — commit messages stay plain.
26. **A dogfood measurement against a stale IR cache reads exactly like a fix that worked.**
    `.momus/cache/modules.sqlite` is invalidated only by `IR_SCHEMA_VERSION`, which is bumped **by
    hand** — a parser change without a bump serves pre-fix IR forever. Round 49 reported "Argos 21
    → 0"; with the cache cleared the same tree still had 19 findings. Before measuring: bump the
    schema, or `rm -rf <repo>/.momus`, in every target repo.
27. **`invocationSites` proves a mock WAS reached, never that it was not.** A double injected into
    the subject (`spyOn(cm, 'createAdapter').mockReturnValue(adapter)`), installed onto an object
    (`pm.findPort = jest.fn()`), or spied on the subject itself (`spyOn(cm, 'emit')` + `cm.init()`)
    is called from inside production and records no syntactic site. Any rule that reads an empty
    `invocationSites` as "unreachable" needs a `hasProductionCalls` escape or it fires on healthy
    interaction tests — 15/15 of Argos's TAUT-006 findings were this.
28. **Never let a local helper's provenance carry `constant`/`literal` outward.** Tracing
    `expect(firstError(x)).toContain('msg')` through `const firstError = (a) => { …; return null; }`
    and inheriting the `null` made both operands constant literals, turning 13 healthy Chaos
    assertions into TAUT-003 errors. Trace the source *kind* only, and only when the helper has
    exactly one value-returning `return` — several returns mean the value is control-flow dependent
    and has no single provenance.

25. **php-parser AST nodes don't carry `raw`/`value` for structural nodes** (`variable`,
    `offsetlookup`, `propertylookup`, `call`, …) — those fields only exist on literals. The
    faithful source identity is `node.loc.source` (the engine must run with `ast.withSource: true`,
    which it does). Falling back to `node.kind` as an expression's `text` made every same-kind
    operand pair collide and produced mass TAUT-001 false positives on real PHP (`assertSame($a,
    $b)` flagged as self-comparison). Always prefer `loc.source` for expression text.

---

## 6. Rules implemented (severity) — catalog in `docs/03` §3.3

- **TAUT-001** self-comparison (error) · **TAUT-002** mock-echo (error) · **TAUT-003**
  constant-tautology (error) · **TAUT-004** mock-only-assertion (warning) · **TAUT-005**
  zero-reach-stub (warning) · **TAUT-006** unconfigured-spy-assert (warning)
- **DRIFT-000** unresolvable-target (info, off by default) · **DRIFT-001** missing-member
  (error; rename fix when a unique near-match exists) · **DRIFT-002** signature-mismatch (warning;
  callback arity and conservative parameter types are wired for object-literal and spy doubles) ·
  **DRIFT-003** return-type-mismatch (warning) · **DRIFT-004** constructor-drift (PHP-only,
  stub) · **DRIFT-005** missing-export (error)
- **MOCK-001** mock-saturation (warning) · **MOCK-002** mock-of-self (info)
- **DRIFT-006** stale-mock is Phase 3 (git-diff) — correctly not implemented.

Suppression grammar (`docs/03` §3.5): `// @momus-ignore` (next line, all rules),
`// @momus-ignore:RULE[,RULE]`, trailing form on the same line, `/** @momus-ignore */` docblock
(scopes the following test fn when one starts within 4 lines), `// @momus-ignore-file` (first
10 lines only). Config-level `suppressions[]` in `.momusrc` is modeled but **not yet applied**
in `audit.ts` — only inline comments are. (Verify before relying on it.)

---

## 7. Known gaps / honest limitations (also `docs/10` §10.5, `docs/09` §9.5)

1. **Setup scopes are now implemented** for module-level and nested `describe` `beforeEach`/
   `beforeAll` callbacks, with ordering and scope-isolation fixtures. Dynamic/ambiguous setup
   control flow remains conservative.
2. **DRIFT-002 stub arity is partially hardened** — object-literal doubles now extract required
   parameters from `vi.fn`/`jest.fn` implementations; assigned `mockImplementation` configs,
   spy implementation signatures, and conservative parameter-type compatibility are collected.
3. **Syntax-only mode** — syntactic target-name enrichment through `SymbolIndex.resolveByName`
   is now covered by a root-level no-`tsconfig.json` fixture; dynamic names remain conservative.
4. **Jest coverage** — `jest.fn`, `jest.mock` factory/helper, and `jest.requireMock` paths are
   covered; broader Jest-specific semantics remain open.
5. **`synthesize_mock_contract`** derives type-appropriate placeholder return values for the
   TypeScript path (`tsReturnExample`: number→`0`, string→`''`, boolean→`false`, arrays→`[]`,
   `Promise<T>`→`mockResolvedValue(example of T)` (unwrapped), unions→first non-nullish member),
   matching the PHP path's `phpReturnExample`. Named interface/class returns now resolve through
   the checker (`tsReturnExampleChecked`) to nested data-shape literals. The `vi.fn<[...]>`
   generics are emitted; the `expect.any(...)` matcher shape in `docs/04` §4.4.3 remains
   aspirational (not emitted).
6. **Perf budgets** (§2.7) are asserted nowhere yet; whole-workspace `ts.createProgram` per
   audit. The chokidar watcher invalidates the `ts.Program` cache on change (`serve --watch`), and
   the persistent IR cache (`better-sqlite3`, `.momus/cache/`) serves warm parses for an unchanged
   workspace. Remaining: the incremental program (`ts.createWatchProgram`) and perf-budget asserts.
7. **`git-diff` scope is implemented** (Phase 3): `gitChangedPaths` → `DiffScope` → DRIFT-006 +
   diff-filtered drift rules; CLI `precommit`/`--git-diff`/`hook` (staged-files gate via
   `gitStagedPaths`, `--install`/`--uninstall` marker-guarded); MCP `verify_mock_drift` git-diff
   scope. Remaining: staged-line granularity (hook is file-level today). The `--fix` mechanism +
   DRIFT-001 rename fix ship; TAUT-001/002/003 are semantic and intentionally descriptive-only
   (no auto-fix — a documented decision, §3.6).
8. **PHP** — parser/engine integration covers symbols, `use` aliases, Composer PSR-4 **and
   classmap** fallback, `createMock`/Mockery/Pest chains **incl. closure-form**, `willReturn` IR,
   TAUT-002, DRIFT-001, DRIFT-003 (declared-type assignability), and DRIFT-004 incl.
   optional-parameter defaults, plus docblock `@return`/`@param` typing (native-type fallback),
   `synthesize_mock_contract` phpunit/pest templates, anonymous-class doubles
   (`new class extends Foo` → `pattern:'anonymous-class'` + override members), and `momus doctor`
   PHP-readiness, and `getMockForAbstractClass` doubles (`pattern:'getMockForAbstractClass'`,
   targeting the abstract class with `method()`/`willReturn()` stubbed members). Mock bindings are
   function-scoped (`scope:name` keys), property mocks (`$this->x`, e.g. assigned in `setUp`) are
   class-scoped (`this:x`), and same-variable reassignment within one method resolves to the
   nearest prior assignment (line-ordered `recordBinding`/`nearestBinding`). Mock reachability is
   hand-off-aware: a mock passed to a constructor/call or returned from a closure is marked
   reachable (no false TAUT-005).

---

## 8. Spec deltas applied during the build (docs updated to match)

| Spec item | Original | Now (confirmed) |
|---|---|---|
| Package manager | pnpm | **npm workspaces** (`docs/06` §6.1, `docs/README`) |
| CLI framework | commander/citty | hand-rolled arg parsing, no dep |
| Picomatch | dependency | **built-in glob matcher**, core = zero runtime deps |
| better-sqlite3 / chokidar / eslint / coverage | Phase-1 deps | **all shipped** — better-sqlite3 IR cache, chokidar watch, eslint+prettier, v8 coverage |
| Build output | dist/ + exports maps | **run from `src/` via tsx** (exports → `./src/index.ts`) |
| Suppression | spec grammar | implemented incl. trailing detection + docblock-fn scoping |
| Summary | truncated counts | **pre-truncation `totalErrors` etc.** for exit codes / CLEAN |
| Phase 0/1 status | not started | ✅ done (docs/07 headers annotated; see `docs/10`) |
| Language lists (`Language` union, config, discovery regex) | hand-maintained in several places | **single registry** `packages/core/src/languages.ts` (§2.2.4) |
| MockFramework/MockPattern unions | TS + PHP only | **+ `unittest`/`pytest` + `patch`/`patch-object`/`autospec`/`pytest-mock`/`monkeypatch`** (IR schema v4) |

---

## 9. Next session — recommended sequence

1. **Four-language parity is shipped** — pyright `--createstub` inference, Rust reachability
   refinements, cross-language MOCK-002/DRIFT-005/TAUT-006, and the four-language
   `synthesize_mock_contract` are all done and dogfooded (httpx 0 issues; mockall warnings
   16→11). Remaining follow-ups are optional hardening only.
2. **Continue the hardening loop** — dogfood the audit + `synthesize_mock_contract` on Momus
   itself and against `Chaos-MCP`/`Knossos-MCP`, fixing every false-positive/perf gap they
   expose; keep `docs/11-real-world-findings.md` + this handover current.
3. **Optional hardening** — wire `lint` + `format:check` into `ci.yml`; extract the CLI `main()`
   dispatch into pure functions (raises the CLI entrypoint's subprocess-blind v8 coverage); cover
   the remaining `format/markdown`/`drift`/`dataflow` branch edges; add perf-budget asserts (§2.7)
   and the incremental `ts.createWatchProgram` program.
4. **Phase 4 (publishing + MCP registry) is deferred indefinitely** — do not spend cycles on it
   unless the project preference changes; the in-repo scaffolding (action, release-please,
   annotate-pr, registry draft) remains available.

**Guardrails:** read-only tools only; deterministic output (golden-tested); <100 tokens/issue
(asserted); new patterns ship only with anti-pattern + healthy fixtures in CI; test ideas in
`experiments/` before committing them to `packages/`.

---

## 10. Useful references

- `docs/09-validation-report.md` — the 8 spike experiments + the 6 findings that forced spec deltas
- `docs/10-build-plan.md` — the achievable goal + sequenced plan (the operating document)
- `docs/03-analysis-algorithms.md` §3.3 — rule firing criteria (normative)
- `docs/04-mcp-tool-definitions.md` — tool schemas + agent usage protocol
- `docs/05-output-format.md` — issue-line grammar + token budget contract
