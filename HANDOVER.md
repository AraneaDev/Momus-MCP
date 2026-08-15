# Momus-MCP — Session Handover

**Date:** 2026-08-15 · **State:** Phase 1 built & green; v0.1 packaging complete — 96 tests passing,
typecheck clean, self-audit clean, fixture smoke passing, README added, package dry-runs clean.
**Next session starts at Step 2 of `docs/10-build-plan.md`.**

---

## 1. TL;DR

- **Project:** Momus-MCP — a local-first, deterministic, read-only MCP server + CLI that
  statically audits TypeScript test suites for **tautological assertions** (tests that cannot
  fail) and **mock-contract drift** (test doubles that no longer match production). "False-green"
  test suite detector for coding agents.
- **Spec:** `docs/` (9 spec docs + validation report + build plan — the authoritative source).
- **Implementation:** 4 npm-workspace packages (`@momus/core`, `@momus/parser-typescript`,
  `@momus/mcp-server`, `@momus/cli`), 96 vitest tests, GitHub Actions CI, self-audit gate.
- **NOT a git repository yet.** Nothing is committed. `git init` + initial commit is the first
  thing the next session should do (or per user preference).
- Everything was validated by experiments first (`docs/09-validation-report.md`), then built,
  then tested. The "test ideas before committing to them" policy is documented in `docs/10-build-plan.md` §10.1.

---

## 2. Quick verification (all currently green)

```bash
npm run typecheck        # 0 errors across all packages
npm test                 # 10 files, 96 tests, all pass
npm run audit-self       # Momus audits its own repo: 30 files, CLEAN:true
# fixture smoke (planted violations must FAIL with exit 1):
rm -rf /tmp/momus-fixture && cp -r packages/parser-typescript/test/fixtures /tmp/momus-fixture \
  && cd /tmp/momus-fixture && npx --prefix /root/Momus-MCP momus audit . ; echo "EXIT:$?"   # expect 1
```

**CI workflow** (`.github/workflows/ci.yml`) runs: npm ci → typecheck → test → self-audit →
fixture-smoke (copies fixtures to tmp so the repo `.momusrc` ignorePatterns don't hide them).

---

## 3. What exists, where

```
docs/                      # authoritative spec: 01-07 + 09-validation + 10-build-plan
packages/core/             # engine — ZERO runtime deps (deliberate, see §5.6)
  src/ir.ts                #   language-neutral IR (ModuleIR, MockIR, AssertionIR, Issue…)
  src/parser.ts            #   LanguageParser plugin contract
  src/config.ts            #   .momusrc JSONC loader + validation
  src/discovery.ts         #   file walk, test patterns, size caps
  src/glob.ts              #   built-in glob matcher (replaced picomatch)
  src/suppress.ts          #   @momus-ignore grammar (§3.5): line/trailing/docblock/file banner
  src/tokens.ts            #   <100 token/issue contract, renderIssueLine
  src/audit.ts             #   AuditEngine — orchestrates discovery→parse→index→rules→format
  src/symbolIndex.ts       #   production symbol graph (membersOf, exportsOf, resolveByName)
  src/rules/               #   engine.ts + tautology.ts (TAUT-001..006) + drift.ts (DRIFT-000..005) + hygiene.ts (MOCK-001/002)
  src/format/              #   markdown.ts + json.ts (the structuredContent envelope)
packages/parser-typescript/
  src/program.ts           #   custom-host ts.Program (parent pointers!) + resolveImport + type helpers
  src/symbols.ts           #   class/interface/method/signature extraction
  src/mocks.ts             #   vi.mock/vi.fn/vi.spyOn/vi.mocked/object-literal detection + invocation sites
  src/dataflow.ts          #   assertion extraction + provenance (mock-config/mock-call/production/literal/unknown)
  src/comments.ts          #   comment extraction with trailing detection
packages/server/           # MCP server: 5 tools, annotations + structuredContent, stdio only
packages/cli/              # momus audit|drift|contract|rules|serve|init|doctor
test/golden/audit.test.ts  # exact issue set from planted fixtures + suppression e2e
test/integration/mcp.test.ts # in-memory MCP client round-trip, all 5 tools
packages/*/test/           # unit tests (58 core + 23 parser) + fixture galleries (self-contained)
experiments/               # throwaway spike workspace (kept for reference; not part of the build)
.momusrc                   # self-audit config — excludes fixture galleries + experiments
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
   parameter properties (`constructor(public x)`). Repo convention: **never use them**.
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

---

## 6. Rules implemented (severity) — catalog in `docs/03` §3.3

- **TAUT-001** self-comparison (error) · **TAUT-002** mock-echo (error) · **TAUT-003**
  constant-tautology (error) · **TAUT-004** mock-only-assertion (warning) · **TAUT-005**
  zero-reach-stub (warning) · **TAUT-006** unconfigured-spy-assert (warning)
- **DRIFT-000** unresolvable-target (info, off by default) · **DRIFT-001** missing-member
  (error) · **DRIFT-002** signature-mismatch (warning, stub arity extraction not yet wired) ·
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

1. **`beforeEach`-configured mocks** attach to file scope, not the test fn — planned fix,
   Step 2.1 of the build plan. Fixtures must pin semantics first.
2. **DRIFT-002** fires only when stubs carry a `signature` — extraction of stub arity from
   `vi.fn((a, b) => …)` implementations isn't wired.
3. **Syntax-only mode** (no tsconfig) — `SymbolIndex.resolveByName` loose resolution is
   untested end-to-end; type-aware mode is the tested path.
4. **Jest coverage** — `vi.*` patterns are tested; `jest.*` shares the code paths but has no
   dedicated fixtures.
5. **`synthesize_mock_contract`** returns `undefined` placeholders for return values
   (it does not yet derive literal examples from types).
6. **Perf budgets** (§2.7) are asserted nowhere yet; whole-workspace `ts.createProgram` per
   audit. Incremental program + IR cache are Phase 2.
7. **`git-diff` scope** (`verify_mock_drift`) is validated for input only — the plumbing is Phase 3.
8. **PHP** — parsing spike-proven (E6) but no engine integration (Phase 2).

---

## 8. Spec deltas applied during the build (docs updated to match)

| Spec item | Original | Now (confirmed) |
|---|---|---|
| Package manager | pnpm | **npm workspaces** (`docs/06` §6.1, `docs/README`) |
| CLI framework | commander/citty | hand-rolled arg parsing, no dep |
| Picomatch | dependency | **built-in glob matcher**, core = zero runtime deps |
| better-sqlite3 / chokidar / eslint / coverage | Phase-1 deps | **deferred** (Phase 2/3), isolated behind interfaces |
| Build output | dist/ + exports maps | **run from `src/` via tsx** (exports → `./src/index.ts`) |
| Suppression | spec grammar | implemented incl. trailing detection + docblock-fn scoping |
| Summary | truncated counts | **pre-truncation `totalErrors` etc.** for exit codes / CLEAN |
| Phase 0/1 status | not started | ✅ done (docs/07 headers annotated; see `docs/10`) |

---

## 9. Next session — recommended sequence

1. **Initialize git and create the initial commit** when the user explicitly approves it
   (the workspace is not currently a git repository; do not commit `node_modules/`).
2. **Step 2 (hardening)** — beforeEach scopes → DRIFT-002 stub arity → more mock patterns →
   syntax-only mode e2e. Each with planted + healthy fixtures.
3. Then Phase 2 (PHP), 3 (git-diff), 4 (CI action + registry) per `docs/10` Steps 3–5.

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
