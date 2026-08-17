# Four-language parity — design

**Date:** 2026-08-17 · **Status:** approved for planning · **Branch:** `feat/language-parity`

Momus now ships four language families — TypeScript/JS, PHP, Python, and Rust — but they
are not at the same capability level. TypeScript is the most mature (real type checker,
spy + module-mock rules, contract synthesis); PHP is structural (native + docblock types);
Python is annotations-first (type inference deferred); Rust is semantic (`syn`) but has a
documented reachability gap. This spec captures the decisions and the §1–§6 design that
bring all four languages to parity, plus the consistency fixes that make the shipped surface
truthful. It is the normative input to the `writing-plans` step; implementation does not
begin until the written spec is user-reviewed.

## 0. Decisions (locked)

1. **Scope — all four parity buckets.** The plan covers (a) tool-surface parity, (b)
   cross-language rule coverage, (c) detection-depth parity, and (d) consistency fixes.
   Each is a section below (§4, §3, §1–§2, §5).
2. **Python type depth — full `pyright` integration.** `@momus/parser-python` runs
   pyright's type evaluator in-process to resolve real types for symbols/parameters/returns
   and writes them into `SignatureIR`, so DRIFT-002/003 fire on unannotated code like TS/Rust.
3. **Rust reachability — bounded fix.** Trace wrapper re-bindings (`Box::new`/`Arc::new`/
   `Rc::new`/`Pin::new`) and treat by-value consumption (`block_on(mock)`, `fn(mock)`) as
   reached. No full interprocedural dataflow.
4. **Rule porting is semantic, not forced.** A rule is ported only where its concept is
   meaningfully present in a language; DRIFT-004 stays PHP-only (§3).
5. **Synthesis reaches all four.** `synthesize_mock_contract` gains pytest/unittest and
   mockall/mockito/wiremock paths (§4).

## 1. Python type depth — pyright inference

**Problem.** DRIFT-002/003 are the only drift rules that degrade on Python unannotated
signatures (SYS-003). TypeScript has the real checker, Rust has `syn`, PHP has structural
native/docblock types — Python is the laggard.

**Approach.** Add `pyright` as a dependency of `@momus/parser-python`. pyright is
TypeScript, so it runs in-process (no WASM/FFI like `syn`); the integration is a library
call, not a subprocess.

- **Type resolution.** For each Python production module, run pyright's type evaluator over
  the workspace (bounded search path: the workspace root, `site-packages`, stdlib stubs).
  Walk the AST with type info and write resolved types into the existing `SignatureIR` /
  `ParamIR.type` / `returnType` — the same `TypeIR` contract every rule already consumes,
  so DRIFT-002/003 fire unchanged.
- **Symbol index.** Resolve `patch('app.mod.Member')` dotted paths through a Python symbol
  index (module → class/function → member → signature) — the Rust crate-index analog,
  reusing core's `SymbolIndex`. External/venv imports that cannot be resolved degrade to
  SYS-003 (annotations-only), the same honest boundary Rust uses for external crates.
- **Cost.** pyright cold-start is absorbed by the existing `better-sqlite3` parse cache
  (content-hash + workspace-digest keyed). The workspace digest folds a
  `pyproject.toml`/venv signal so an environment change forces a reparse.
- **Graceful degradation.** `pyright` is loaded lazily; if it is unavailable at runtime the
  parser falls back to annotations-only (SYS-003) rather than throwing.
- **Spike gate.** Phase 4 opens with a throwaway spike confirming the programmatic API
  (which package entry point, how to bind types to AST nodes, cold-start cost on a real
  pytest repo) — the same discipline as the syn→wasm32 spike. The spike decides the exact
  import surface; it does not decide the architecture, which is fixed above.

## 2. Rust reachability — bounded TAUT-005 fix

**Problem.** `invocationSites` in `@momus/parser-rust` is populated only for direct
invocations on the bound variable (with field/deref/paren recursion). It misses (a) receiver
re-bindings — `let boxed: Box<dyn Foo> = Box::new(mock); boxed.foo()` — and (b) by-value
consumption — `block_on(mock)`, `Arc::new(mock).bean()`, `Pin::new(Box::new(mock)).booz()`.

**Fix (bounded, in `@momus/parser-rust/src/mocks.ts`):**

1. **Wrapper re-bindings.** When a mock (or alias) is re-bound through a wrapper
   constructor into a new variable — `Box::new`, `Arc::new`, `Rc::new`, `Pin::new`
   (possibly nested), optionally with a cast (`let boxed: Box<dyn Foo> = Box::new(mock)`)
   — register the new variable as an alias of the mock, so a later `boxed.foo()` /
   `alias.foo()` records an invocation site.
2. **By-value consumption.** When the mock (or an alias) is passed as a call argument by
   value to anything — a function (`block_on(mock)`) or a wrapper constructor
   (`Arc::new(mock)`) — mark the mock reached. This is conservative in exactly one
   direction: it can only *remove* false positives (a mock that is consumed but internally
   never invoked becomes a silent miss, which is the accepted documented boundary), never
   create them.

**Result.** The mockall receiver-wrapper (`mock_box_self.rs`, `automock_auto_impl.rs`) and
by-value (`automock_generic_future.rs` `block_on`) warnings clear. The `mock_cfg.rs`
cfg-gated compile-only tests (mock configured, genuinely never invoked) remain — those are
true zero-reach stubs, and their remaining warnings are correct.

## 3. Cross-language rule coverage (semantic mapping)

The mapping below ports each currently-single-language rule only where its concept is
meaningful. **DRIFT-004 stays PHP-only** (constructors are compiler-checked in TS/Python/
Rust; PHPUnit's `disableOriginalConstructor`/`enableOriginalConstructor` is the unique
semantic) — documented, no code change.

| Rule | Today | Add | Skip (documented) |
|---|---|---|---|
| TAUT-006 unconfigured-spy | TS (`vi.spyOn`/`jest.spyOn`) | Python: `Mock`/`MagicMock`/`AsyncMock` with `assert_called*`/`assert_not_called` and no `return_value`/`side_effect` and no invocation. PHP: Mockery `spy()` + `shouldHaveReceived()` with no `shouldReceive` config | Rust — mockall has no separate spy (its `expect_*` is the config) |
| DRIFT-005 missing-export | TS (`vi.mock`/`jest.mock` factory keys) | Python: `patch('mod.missing_attr')` string-path form patching a non-existent module attribute | Rust/PHP — no module-mock idiom |
| MOCK-002 mock-of-self | TS (`.test.ts` filename) | Python: `test_foo.py` that patches `foo`. Rust: `#[cfg(test)] mod tests` mocking its own struct. PHP: `FooTest.php` mocking `Foo` | — |
| DRIFT-004 constructor-drift | PHP | — | TS/Python/Rust — compiler-checked |

**Mechanics.** `Mock002MockOfSelf` currently derives the subject via a TS-only
`testSubject()` regex (`foo.test.ts` → `foo`). Generalize to a per-language subject
derivation: Python `test_<name>.py` → `<name>`; PHP `<Name>Test.php` → `<Name>`; Rust the
enclosing module name of a `#[cfg(test)] mod tests`. TAUT-006's `isSpy` gate and
DRIFT-005's `mockFactoryKey` gate gain per-language equivalents in the respective parsers
(the parsers already emit `pattern`/`api` values the rules filter on).

## 4. Contract synthesis for all four languages

`packages/server/src/index.ts` `synthesize_mock_contract` (and the CLI `momus contract`
path) today accepts `framework ∈ {vitest, jest, phpunit, pest}`. Extend to:

- **Python — `pytest` / `unittest`.** Parse the production module with parser-python
  (members + signatures already flow into `SymbolIR`), emit a `Mock(spec=)` /
  `patch.object` template with `return_value`/`side_effect` placeholders derived from the
  return types. Return values become real literals once §1 lands (before §1, annotations
  drive them and unannotated degrades to `None`/`Mock()`).
- **Rust — `mockall` / `mockito` / `wiremock`.** Parse production with parser-rust + the
  crate index (trait/struct members), emit `mock!`/`#[automock]` + `expect_*().returning(...)`
  for `mockall`, or `mock("GET", "/p")…create()` / `Mock::given(…)…respond_with(…)` for the
  HTTP frameworks.

This reuses the existing `synthesizeContract` dispatch (it already branches TS vs PHP);
two new `synthesizePythonContract` / `synthesizeRustContract` functions join it. The MCP
tool's `framework` zod enum and the CLI `--framework` help text are updated together.

## 5. Consistency fixes

1. **Rule catalog drift.** `packages/cli/src/catalog.ts` lists 12 rules (missing DRIFT-004,
   DRIFT-006) while `packages/server/src/index.ts` `RULE_LIST` lists 14. Move the catalog to
   a single shared export in `@momus/core` (e.g. `RULES_CATALOG`) and have both the CLI
   `rules` command and the MCP `list_rules` tool read it — the real fix for the drift, not a
   one-off re-sync.
2. **Watcher.** `watchWorkspace`'s `SOURCE_RE` omits `rs`; add it, and extend the ignored
   set with `.venv`, `venv`, `__pycache__`, `target` so Rust/Python builds don't churn the
   watcher. (Rust/Python don't use the memoized ts.Program, but `onChange` should still fire
   for their files for consistency.)
3. **Default ignores.** `DEFAULT_CONFIG.ignorePatterns` add `**/__pycache__/**`,
   `**/.venv/**`, `**/target/**` — the Knossos `**/vendor/**` precedent (docs/11 row 12):
   Python/Rust audits must not scan venv/build dirs.

## 6. Phasing, acceptance, risks

Five independently-shippable phases, each a reviewable PR, each keeping the full gate green:

1. **Consistency** (§5) — smallest, lowest risk, test-pinned.
2. **Rust reachability** (§2) — self-contained parser change + re-dogfood mockall.
3. **Rule porting** (§3) — TAUT-006/DRIFT-005/MOCK-002 semantic mapping + DRIFT-004 doc.
4. **Python pyright** (§1) — the largest; spike-gated, unblocks richer synthesis.
5. **Contract synthesis** (§4) — builds on §1 + the existing Rust parser.

**Acceptance per phase.** TDD: parser/rule/golden/MCP tests pin each change (planted
unannotated Python drift that fires under pyright; the Rust re-binding + by-value fixtures;
a missing `patch()` attr; a `mock-of-self` in each new language; a pytest/mockall/mockito/
wiremock synthesis snapshot). Dogfood after phases 2–5: re-run mockall (0 errors, warnings
drop to the genuine cfg-gated set), a mock-heavy pytest repo (httpx or flask) to exercise
pyright inference, and re-run Knossos (PHP) + Chaos (TS) to confirm no regressions. Full
gate green throughout: typecheck, lint, format, self-audit.

**Risks.** (1) pyright's programmatic API is less stable than its CLI — the spike retires
this before commitment. (2) pyright dependency weight/cold-start — mitigated by the parse
cache + lazy load. (3) Over-eager by-value reachability (§2) could hide a genuine zero-reach
stub — accepted: a silent miss is strictly better than a false positive, and the bounded
scope was chosen precisely to avoid the false-positive risk of full dataflow.

## 7. Open questions

1. **pyright entry point** — resolved by the §1 spike (`pyright` vs `pyright-internal`);
   the architecture above is independent of that choice.
2. **Dogfood repo for Python** — httpx vs flask vs another mock-heavy pytest project;
   confirmed before phase 4/5 dogfooding (the requests clone was too mock-light to exercise
   drift rules — docs/11 §4c).
3. **Out of scope (explicit).** A PHP type checker (phpstan/psalm) — PHP's native +
   docblock structural model is treated as at-parity for this plan. New MCP tools for agent
   ergonomics are a *separate* brainstorm/spec, not part of this parity work.
