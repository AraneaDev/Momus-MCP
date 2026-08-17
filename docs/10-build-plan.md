# 10. Build Plan — Achievable Goal & Sequenced Work

> Status: **Phases 1–3 are built and green; Phase 4 release scaffolding is in-repo (publishing
> credential-blocked).** This document states the achievable goal, what already exists (verified
> by tests, not aspiration), what remains, and the exact sequence to reach a shippable v0.1.

## 10.1 The achievable goal

**Goal (v0.1):** a local-first, deterministic, read-only MCP server + CLI that statically
audits TypeScript test suites for tautological assertions and mock-contract drift, with
**zero false positives on the reference healthy suite** and **every finding under 100
tokens**, runnable by `npx momus` and connectable as `momus-mcp` by any MCP client.

This goal is **already met in the working tree** — verified by 207 passing tests, a clean
self-audit, and end-to-end CLI + MCP round-trips.

**Originally out of v0.1 scope, now shipped** (kept here for history; everything below is done
except registry publishing):
- ✅ PHP support (Phase 2 — `@momus/parser-php` + engine integration)
- ✅ git-diff scoping + DRIFT-006 (Phase 3)
- ✅ CI GitHub Action + release-please release scaffolding (Phase 4; npm/MCP publishing still credential-blocked)
- ✅ `better-sqlite3` IR cache, chokidar file watcher, Streamable HTTP transport

## 10.2 What is built and verified (do not rebuild)

| Area | Where | Verification |
|---|---|---|
| Monorepo (npm workspaces) | root `package.json`, `tsconfig.base.json`, `vitest.config.ts` | `npm ci` + `npm test` + `npm run typecheck` green |
| `@momus/core` — IR, config (JSONC), discovery, built-in glob, suppression, token budget, `SymbolIndex`, 14 rule classes, markdown/JSON formatters | `packages/core/src/` | 60 unit tests |
| `@momus/parser-typescript` — custom-host program (parent pointers, F5), symbols/signatures, mock detection (vi.mock / vi.fn / vi.spyOn / vi.mocked / object-literal / proxy / automock helpers), dataflow provenance (const-aware, F5/F6), comments with trailing detection | `packages/parser-typescript/src/` | 33 unit tests + fixture gallery |
| `@momus/parser-php` — `php-parser` plugin, typed symbols, PHPUnit/Mockery/Pest mock chains, configured values, `use` aliases, Composer PSR-4 + classmap resolution, PHP assertions | `packages/parser-php/src/` | 7 integration tests + fixture gallery |
| `@momus/parser-python` — `tree-sitter-python` plugin, PEP 484/526/585/604 annotation typing, pytest/unittest mock catalog (`patch`/`patch.object`/`Mock(spec=)`/`mocker`/`monkeypatch`), assertions + provenance | `packages/parser-python/src/` | 20 unit tests + drift fixtures + golden + MCP |
| `@momus/mcp-server` — 5 tools (audit_test_fidelity, detect_tautological_assertions, verify_mock_drift, synthesize_mock_contract, list_rules), annotations + structuredContent, no stdout writes | `packages/server/src/` | 10 integration tests (in-memory client round-trip, including PHP language selection) |
| `@momus/cli` — audit / drift / contract / rules / serve / init / doctor, honest exit codes (pre-truncation) | `packages/cli/src/` | golden audit tests + smoke |
| Self-audit gate | `.momusrc` + `npm run audit-self` | clean on 30 repo files |
| CI | `.github/workflows/ci.yml` | typecheck + test + self-audit + fixture-smoke |

**Confirmed during the build (spec deltas already applied):** npm workspaces over pnpm;
`core` has zero runtime deps (built-in glob replaced picomatch); no parameter properties in
source (Node strip-only mode — a `CompositeParser` regression crashed the bin and is now
covered by a bin-symlink regression test); TAUT-003/TAUT-006 and invocation-site analysis are
`let`-mutation and helper-call aware (fixed two false positives found by the self-audit).

## 10.3 Sequenced work plan

### Step 1 — Ship v0.1 (small, days) · `done`

1. ✅ `README.md` at repo root: quickstart (`npx momus audit .`), MCP client config snippet
   (Claude Desktop / Cursor / generic), links into `docs/`.
2. ✅ `.gitignore` audit + `experiments/` decision: the E1–E8 spikes are **kept for reference**
   (documented in `docs/09-validation-report.md`); `experiments/node_modules/` is gitignored and
   `experiments/**` is excluded from self-audit via `.momusrc` ignorePatterns.
3. ✅ `npm` bin links: `bin` + `files` fields in `packages/cli/package.json`; `npx momus` resolves
   through the workspace bin symlink (regression-tested).
4. ✅ Publish dry-run (`npm pack --dry-run` in each package) clean.
   **Acceptance:** fresh clone → `npm ci && npm test && npm run audit-self` → green;
   `npx momus audit` on a real TS repo reports findings; `momus-mcp` connects to a client.

### Step 2 — Harden the engine (this is where the value lives) · `done`

1. ✅ **BeforeEach/BeforeAll scope support**: module-level and nested `describe` hooks now
   contribute configurations only to their applicable test functions, with lifecycle ordering
   and scope-isolation fixtures.
2. ✅ **More mock patterns**: assigned `vi.fn()`/`jest.fn()` values, later `mockImplementation`
   configs, and Proxy doubles with mock-returning `get` handlers are collected; `jest.mock`
   factories, Proxy doubles, and module automock helpers have key/dynamic-handler extraction.
   The ambiguous TS `partialMock` helper stays deferred (no concrete convention exists; the
   named partial-mock form is PHP `createPartialMock`).
3. ✅ **DRIFT-002 (signature arity, first slice)**: object-literal doubles extract required
   arity from `vi.fn((a, b) => ...)`, `jest.fn` implementations, and `spyOn(...).mockImplementation`
   callbacks. Conservative parameter-type compatibility and unknown-type escape hatches are
   covered; richer structural generic variance remains follow-up hardening.
4. ✅ **Loose name-based resolution fallback**: syntax-only mode now preserves syntactic target
   names and enriches them through `SymbolIndex.resolveByName`; a no-`tsconfig.json` planted and
   healthy arity fixture proves the end-to-end path.
   **Acceptance:** each item has a planted-violation fixture and a healthy twin; self-audit stays clean.

### Step 3 — Phase 2: PHP · `complete`

1. ✅ Spike and initial integration: E6 passes, and `packages/parser-php` now emits typed
   symbols, PHPUnit `createMock`/`method`/`willReturn` chains, and assertions into the shared IR.
2. ✅ Configured-mock provenance for TAUT-002, `use ... as ...` aliases, Mockery/Pest chains
   **incl. closure-form** (`Mockery::mock('F', fn($m) => $m->shouldReceive(...)->andReturn(...))`,
   both `function` and arrow forms, span-scoped param binding), Composer PSR-4 **and classmap
   fallback** resolution, and original-constructor DRIFT-004 (incl. optional-parameter defaults:
   an all-optional constructor double with 0 args stays quiet) are covered. PHP DRIFT-003
   return-type assignability is wired in the rule (declared types + cross-file class resolution;
   planted void/class/array mismatches fire, healthy twins stay quiet).
3. ✅ Extend `.momusrc` PHP language gating and CLI/server parser selection; direct CLI dispatch
   and MCP PHP report coverage are now included. Broader CLI report behavior remains.
   **Acceptance:** PHP fixture gallery green; `momus audit` on a PHPUnit repo finds
   `createMock('X')` with a stale member (DRIFT-001) and a `willReturn` that echoes (TAUT-002).
4. ✅ PHPDoc `@return`/`@param` typing: when a method has no native type, the parser reads the
   docblock into the signature (scalars, `?T` nullables, `T[]`/`array<K,V>` arrays, generics,
   union types, FQCN short-name resolution). Planted docblock-typed DRIFT-003 mismatches fire and
   the healthy twin stays quiet. `synthesize_mock_contract` now emits `phpunit`/`pest` templates
   (`createMock`/`mock` + `method`/`shouldReceive` + `willReturn`/`andReturn` with type-derived
   placeholder values) for PHP production classes; PHP templates render in a `php` code fence.
5. ✅ Anonymous-class doubles: `new class extends Foo { … }` in test files emits
   `MockIR{pattern:'anonymous-class'}` targeting the parent (resolved through `use` aliases and
   FQCN short-names) with the override methods as `StubbedMemberIR` members. DRIFT-001 flags a
   planted stale override while the healthy override stays quiet.
6. ✅ `momus doctor` PHP-readiness: reports the `languages.php` gate, `php-parser` availability,
   `composer.json` presence, and a bounded `.php` file count, summarizing as `off` / `ready` /
   `enabled (loose)`. Unit tests cover each branch.
7. ✅ `getMockForAbstractClass` doubles: `$this->getMockForAbstractClass(AbstractFoo::class)` is
   now a distinct `MockIR{pattern:'getMockForAbstractClass'}` targeting the abstract class, with
   chained `method()`/`willReturn()` configs collected as stubbed members. A planted stale
   abstract member fires DRIFT-001 and the healthy abstract member stays quiet.
8. ✅ PHP mock bindings are function-scoped: `byBinding` keys are now `scope:name` (enclosing
   class-method start line, 0 for top-level), so two test fns that reuse the same `$mock`
   variable no longer collide. The `AbstractMockTest` fixture reuses `$mock` across both fns to
   pin the behavior. Same-variable reassignment within one method is handled in item 10.
9. ✅ PHP setUp/property mocks: `$this->prop = $this->createMock(Foo::class)` (the classic
   `setUp` assignment) is now captured — `assignmentBindingName` maps the LHS to a `this:prop`
   binding and `bindingName` resolves `$this->prop->method(...)` configs / assertion operands back
   to it. Property bindings are class-scoped (visible across the class's test methods).
   `SetUpMockTest` plants a stale `deleteById` (DRIFT-001), a `findById` echo (TAUT-002 +
   DRIFT-003), and a healthy `save` control.
10. ✅ PHP same-variable reassignment: `recordBinding` stores assignments per `scope:name` key in
    line order, and `nearestBinding` resolves configs/assertion operands to the latest assignment
    at or before their line — so reassigning `$mock` within one method no longer shadows the
    earlier mock. `ReassignTest` reassigns `$mock` and pins `[['save'], ['findById']]`.

### Step 4 — Phase 3: git-diff scoping + hooks · `complete`

1. ✅ `git diff --name-status` + `--find-renames` plumbing (`gitChangedPaths`, incl. untracked
   files and rename pairs) → `DiffScope`; DRIFT-006 (stale-mock) fires when the target changed
   but the mock file did not. Drift rules are diff-filtered: in git-diff mode only mocks whose
   target changed are re-checked.
2. ✅ `momus precommit` (drift-only vs `--base`, default HEAD) and `momus audit|drift
   --git-diff --base REF`; the MCP `verify_mock_drift` tool wires `scope: git-diff` with
   `baseRef` (git errors surface as tool errors).
   **Acceptance:** on a repo where a production member was renamed, `precommit` flags the
   stale mock (DRIFT-006 + DRIFT-001) and exits 1; the healthy twin (test updated alongside)
   exits 0 — covered end-to-end by a git-repo fixture test.
3. ✅ `momus hook` pre-commit installer: `hook --install`/`--uninstall` writes/removes
   `.git/hooks/pre-commit` (marker-guarded so foreign hooks are never removed, `--yes`-gated
   per §1.5, executable); `hook` (no flags) runs the staged-files drift gate via `gitStagedPaths`
   (index-only vs HEAD) and exits 1 on error findings. End-to-end: a staged production rename
   blocks the gate (DRIFT-006 + DRIFT-001) and the staged test update clears it.
4. ✅ `momus serve --transport http [--port N]`: Streamable HTTP transport (`serveHttp` in
   `@momus/mcp-server`; SDK stateful per-session transports with stateless tools), end-to-end
   round-trip via `StreamableHTTPClientTransport` (tools/list + `verify_mock_drift`).
5. ✅ `momus annotate [paths...] [--git-diff --base REF]`: machine-readable JSONL (one JSON
   object per issue — workspace-relative file/line/column, rule/severity/message, deterministic
   key order) for editor plugins; exits 1 on error findings.
6. ✅ `momus audit --fix` mechanism: dry-run unified diff by default, `--yes` applies span-based
   fixes, refused in CI without `--yes` (§1.5). `collectFixable`/`applyFixes`/`unifiedDiff` are
   unit-tested. DRIFT-001 now emits a real rename fix (unique near-match within edit distance 2,
   quoted per stub api) and stub spans are narrowed to the name token; a planted stale spy is
   dry-run diffed, applied with `--yes`, and re-audits clean. TAUT-001/002/003 are semantic   tautologies (any rewrite invents the asserted value) so they intentionally stay descriptive-only
   — a documented decision (§3.6), pinned by rule tests, not a gap.
7. ✅ `momus serve --watch` (chokidar file-watching): `watchWorkspace(root)` in `@momus/mcp-server`
   watches TS/JS/PHP sources (ignoring node_modules/.git/dist/vendor/coverage) and calls
   `invalidateProgramCache()` (parser-typescript) on add/change/unlink, so watch-mode audits
   reflect on-disk edits without a restart. `invalidateProgramCache` + `watchWorkspace` are
   unit/integration tested.


### Step 5 — Phase 4: distribution · `in progress`

1. ✅ `packages/action/action.yml` composite action ships in-repo: diff-scoped audit
   (`audit . --git-diff --base`) + `momus annotate-pr` (GitHub Checks API annotations,
   dependency-free via built-in fetch; `fail-on` input; token/repo/sha from the Actions env).
2. ✅ `release-please` + `release-please.yml` scaffolded in-repo (Knossos-style):
   `release-please-config.json` + `.release-please-manifest.json` pin a single lockstep version
   from **0.0.1**, bumping all five workspace `package.json`s via `json` extra-files;
   `pr-title.yml` gates Conventional Commit titles; on `release_created` the workflow runs the
   CI gate. npm publishing is **manual-only** (`scripts/publish.mjs`, dependency order) —
   not part of CI by project decision; run it deliberately when publishing is sanctioned.
   Registering `momus-mcp` in the MCP registry remains pending, but drafts are in `docs/12-registry-listing.md`.
3. ✅ **Docs site** (`docs/` rendered via VitePress) + changelog-driven releases (§6.7).
   **Acceptance:** a PR on any TS repo shows Momus annotations; `npx -y momus-mcp` serves.

### Step 6 — Python support (third language family) · `complete`

1. ✅ Single language registry (`packages/core/src/languages.ts`) drives `Language`, config
   defaults, test-file patterns, and the discovery extension regex; the audit engine's language
   gate is `config.languages[module.language]` (no hardcoded per-language checks).
2. ✅ `@momus/parser-python` parses `pytest`/`unittest` via `tree-sitter-python` (native) +
   textual PEP 484/526/585/604 annotations into the same `ModuleIR`: `patch`/`patch.object`/
   `Mock(spec=)`/`mocker`/`monkeypatch` mocks, `assert`/`pytest.raises` assertions, provenance.
3. ✅ Annotated drift: DRIFT-001 (missing patched member) and DRIFT-002/003 fire only on
   annotated signatures (unannotated degrades with `SYS-003`); DRIFT-004 stays PHP-only.
4. ✅ Wired through CLI/server, `momus doctor` Python-readiness, schema flag, release/publish
   config; golden + MCP round-trip tests pin the planted drift fixtures.
   **Acceptance:** `momus audit` on a pytest repo reports drift; self-audit clean; pyright
   inference remains a follow-up.

### Step 7 — Rust support (fourth language family) · `complete`

1. ✅ `rust` registry entry (`extensions: ['rs']`, structural test detection — no filename
   patterns) + `mockall`/`mockito`/`wiremock` IR members (`IR_SCHEMA_VERSION = 5`) + schema /
   release/publish config.
2. ✅ `syn` → `wasm32-unknown-unknown` wrapper exposes a synchronous `parse_file → JSON AST` FFI
   (committed `.wasm` artifact); `@momus/parser-rust` loads it in-process and does all extraction
   in TypeScript (thin WASM, fat TS).
3. ✅ Crate-wide semantic index resolves `use`/`mod` paths + trait method signatures through the
   existing `SymbolIndex`; `mockall` (`#[automock]`/`mock!`/`expect_*().returning()`),
   `mockito`, and `wiremock` mock detection; `assert!`/`assert_eq!`/`assert_ne!`/`assert_matches!`
   assertions + provenance.
4. ✅ `rustReturnAssignable` (numeric/str/bool primitives, `Option`/`Result`/`Vec`, tuples,
   generics) wires DRIFT-002/003; wired through CLI/server, `momus doctor` Rust-readiness, and
   golden + MCP round-trip tests pin the planted DRIFT-001/003 + TAUT-005 findings.
   **Acceptance:** `momus audit` on a Rust crate reports drift; self-audit clean.

## 10.4 Rules of engagement (hard constraints from §1)

- Read-only: no tool/command writes to the audited workspace.
- Deterministic: byte-identical output for identical workspace (golden-tested).
- < 100 tokens per issue line (unit-tested via `assertTokenBudget`).
- New language/pattern support ships **only** with a planted anti-pattern fixture + a
  healthy twin, both in the gallery, both asserted in CI.
- Nothing unconfirmed ships as "done": each Step above names its verification.

## 10.5 Risks (honest)

| Risk | Mitigation |
|---|---|
| `ts.createProgram` cost on large repos (whole-workspace per audit) | Perf budgets §2.7; incremental program + IR cache are Phase 2 work, isolated behind `SymbolIndex` |
| `beforeEach`-configured mocks produce wrong scopes | ✅ Step 2.1; fixtures pin the semantics |
| PHP chain-fidelity assumptions | Step 3.1 spike gates the whole phase |
| Node version skew (20 vs 22 vs 25 native TS) | `engines: >=20`; CI runs 22; no parameter properties in source |
