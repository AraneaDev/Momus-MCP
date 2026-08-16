# Momus-MCP — Session Handover

**Date:** 2026-08-16 · **State:** Phases 1–3 built & green; Phase 4 release scaffolding in-repo; persistent IR cache (better-sqlite3), ESLint+Prettier, and coverage tooling shipped — 214 tests passing, ~84% statements / ~82% branches,
typecheck clean, lint clean, format clean, self-audit clean, fixture smoke passing, pack dry-runs clean.
**Next session: MCP registry listing draft; publishing blocked on credentials. Real-codebase validation done against `/root/Chaos-MCP`.**

## Current checkpoint — 2026-08-16

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
- **Last verified:** Phase 4 release scaffolding is complete in-repo: `@changesets/cli` +
  `.changeset/config.json` (`baseBranch: main`, `access: public`, `patch`-level internal bumps),
  root `changeset`/`release` scripts, `publishConfig.access: public` on all five packages, and
  `.github/workflows/release.yml` (version-PR via `changesets/action`, `changeset publish`,
  `v*` tag + GitHub Release). Actual npm/MCP publish remains blocked on credentials.
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
  aligning it with `ci.yml`/`release.yml`/`action.yml`. This unblocked the changesets flow:
  `changeset status` now reports "packages changed, no changesets" (expected pre-release) instead
  of the `HEAD diverged from "main"` error.
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
- **Active task:** real-world validation against a large external TypeScript codebase is complete;
  the functional build (Phases 1–3), persistent IR cache, ESLint+Prettier, coverage tooling, and the
  footer-free/identity-standardized history are shipped and green. Phase 4 publishing (npm/MCP
  registry) remains the only item, blocked on credentials (no `NPM_TOKEN`). Next: MCP registry
  listing draft + install snippets, and triaging the TAUT-001 determinism-test pattern (a
  legitimate-looking false-positive class worth a suppression/refinement decision).
- **Safe resume point:** if interrupted, resume wherever you stopped; do not revisit PHP
  closure-form/DRIFT-003, docblock typing, synth templates, anonymous-class doubles, git-diff
  plumbing, DRIFT-006, precommit, annotate-pr, the action, the `--fix` mechanism,
  TAUT-001/002/003 fix code (resolved: semantic → descriptive-only), PHP `getMockForAbstractClass`,
  PHP function-scoped mock bindings, PHP setUp/property mock bindings, PHP same-variable
  reassignment, the test-coverage tooling, the contract-synthesis public-member/`?`-ordering
  fixes, the persistent IR cache, the ESLint/Prettier setup, the real-codebase Chaos-MCP
  validation, the CLI `positionalArgs` flag-value fix, the DRIFT-005 full-export-name fix, the
  barrel re-export extraction, the `IR_SCHEMA_VERSION` cache invalidation, the
  `tsReturnExample` type-derived synthesize return values, the `filterResult` drift-summary fix,
  or the `promiseTypeArg` `mockResolvedValue` synthesis.

---

## 1. TL;DR

- **Project:** Momus-MCP — a local-first, deterministic, read-only MCP server + CLI that
  statically audits TypeScript test suites for **tautological assertions** (tests that cannot
  fail) and **mock-contract drift** (test doubles that no longer match production). "False-green"
  test suite detector for coding agents.
- **Spec:** `docs/` (9 spec docs + validation report + build plan — the authoritative source).
- **Implementation:** 5 npm-workspace packages (`@momus/core`, `@momus/parser-typescript`,
  `@momus/mcp-server`, `@momus/cli`), `@momus/parser-php`, plus `packages/action` composite
  GitHub Action — 214 vitest tests, GitHub Actions CI, self-audit gate.
- **Git.** Six commits on `main`, no remote: `066ac32` (initial scaffold) → `0f09dfa` (full build
  through Phase 3 + Phase 4 scaffolding) → `8552277` (docs: etymology/handover) → `8d3ef61`
  (enforce a footer-free commit history) → `77df24a` (Node globals for the verify script) →
  `072a76a` (handover). Every commit is authored **and** committed by
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
npm test                 # 23 files, 214 tests, all pass
npm run test:coverage    # v8: ~85% statements / ~82% branches (floors 80/75/90/80)
npm run lint             # eslint .  — clean
npm run format:check     # prettier --check .  — clean
npm run check:commits    # fails if any commit carries the Codebuff attribution footer
npm run audit-self       # Momus audits its own repo: 36 files, CLEAN:true
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
.github/workflows/         # ci.yml (PR gates) + release.yml (changesets version→publish)
.changeset/                # changesets config + pending changeset markdown files
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
16. **changesets `baseBranch` must exist in git history** — `changeset status`/`version` fail
    with `Failed to find where HEAD diverged from "main"` when the local branch isn't named
    `main`. `ci.yml`/`release.yml`/`action.yml` all assume `main`; the local branch was renamed
    `master` → `main` (verified: `changeset status` now reports changed packages, no divergence
    error).
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
   `Promise<T>`→`mockResolvedValue(example of T)` (unwrapped), unions→first non-nullish member;
   class/interface/unknown→`undefined`), matching the PHP path's `phpReturnExample`. The rich
   `vi.fn<[...]>` generics / `mockResolvedValue({...})` / `expect.any(...)` shape shown in
   `docs/04` §4.4.3 is still aspirational (not emitted).
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
   nearest prior assignment (line-ordered `recordBinding`/`nearestBinding`).

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

---

## 9. Next session — recommended sequence

1. **MCP registry listing draft** — write the `momus-mcp` registry entry (name, description,
   install command `npx -y @momus/mcp-server@latest`, tool manifest) + install snippets; no
   credentials needed, ready for the publish step.
2. **Phase 4 publishing** — run `npx changeset version` + `changeset publish` and register
   `momus-mcp` once `NPM_TOKEN` is available; e2e-test the composite action via `act`.
3. **Optional hardening** — wire `lint` + `format:check` into `ci.yml`; extract the CLI `main()`
   dispatch into pure functions (raises the CLI entrypoint's subprocess-blind v8 coverage); cover
   the remaining `format/markdown`/`drift`/`dataflow` branch edges; add perf-budget asserts (§2.7)
   and the incremental `ts.createWatchProgram` program.

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
