# 10. Build Plan — Achievable Goal & Sequenced Work

> Status: **Phase 1 is built and green.** This document states the achievable goal, what
> already exists (verified by tests, not aspiration), what remains, and the exact sequence
> to reach a shippable v0.1. It replaces the roadmap's optimistic framing with
> "confirmed" / "unconfirmed" labels per the project's build policy: ideas are tested
> before they are committed to.

## 10.1 The achievable goal

**Goal (v0.1):** a local-first, deterministic, read-only MCP server + CLI that statically
audits TypeScript test suites for tautological assertions and mock-contract drift, with
**zero false positives on the reference healthy suite** and **every finding under 100
tokens**, runnable by `npx momus` and connectable as `momus-mcp` by any MCP client.

This goal is **already met in the working tree** — verified by 96 passing tests, a clean
self-audit, and end-to-end CLI + MCP round-trips. The remaining work is packaging,
hardening, and the confirmed next phases.

**Deliberately NOT in v0.1** (unconfirmed or out of scope — do not start):
- PHP support (Phase 2; parser choice was spike-proven but the engine integration is new work)
- git-diff scoping + DRIFT-006 (Phase 3; needs git plumbing + `changedSymbolIds`)
- CI GitHub Action + MCP registry publishing (Phase 4)
- `better-sqlite3` IR cache, file watcher, HTTP transport (perf/deployment niceties)

## 10.2 What is built and verified (do not rebuild)

| Area | Where | Verification |
|---|---|---|
| Monorepo (npm workspaces) | root `package.json`, `tsconfig.base.json`, `vitest.config.ts` | `npm ci` + `npm test` + `npm run typecheck` green |
| `@momus/core` — IR, config (JSONC), discovery, built-in glob, suppression, token budget, `SymbolIndex`, 14 rule classes, markdown/JSON formatters | `packages/core/src/` | 58 unit tests |
| `@momus/parser-typescript` — custom-host program (parent pointers, F5), symbols/signatures, mock detection (vi.mock / vi.fn / vi.spyOn / vi.mocked / object-literal), dataflow provenance (const-aware, F5/F6), comments with trailing detection | `packages/parser-typescript/src/` | 23 unit tests + fixture gallery |
| `@momus/mcp-server` — 5 tools (audit_test_fidelity, detect_tautological_assertions, verify_mock_drift, synthesize_mock_contract, list_rules), annotations + structuredContent, no stdout writes | `packages/server/src/` | 8 integration tests (in-memory client round-trip) |
| `@momus/cli` — audit / drift / contract / rules / serve / init / doctor, honest exit codes (pre-truncation) | `packages/cli/src/` | golden audit tests + smoke |
| Self-audit gate | `.momusrc` + `npm run audit-self` | clean on 30 repo files |
| CI | `.github/workflows/ci.yml` | typecheck + test + self-audit + fixture-smoke |

**Confirmed during the build (spec deltas already applied):** npm workspaces over pnpm;
`core` has zero runtime deps (built-in glob replaced picomatch); no parameter properties in
source (Node strip-only mode); TAUT-003/TAUT-006 and invocation-site analysis are
`let`-mutation and helper-call aware (fixed two false positives found by the self-audit).

## 10.3 Sequenced work plan

### Step 1 — Ship v0.1 (small, days) · `confirmed`

1. `README.md` at repo root: quickstart (`npx momus audit .`), MCP client config snippet
   (Claude Desktop / Cursor / generic), links into `docs/`.
2. `.gitignore` audit + remove `experiments/` spikes or move to `test/fixtures` (they were
   throwaway; the real fixtures now live in `packages/*/test/fixtures`).
3. Wire the `npm` bin links properly for `npx momus` **without** the `--prefix` dance:
   `npm link` check or `bin` + `files` fields in `packages/cli/package.json`.
4. Publish dry-run (`npm pack --dry-run` in each package) and fix packaging.
   **Acceptance:** fresh clone → `npm ci && npm test && npm run audit-self` → green;
   `npx momus audit` on a real TS repo reports findings; `momus-mcp` connects to a client.

### Step 2 — Harden the engine (this is where the value lives) · `confirmed`

1. **BeforeEach/BeforeAll scope support** (unconfirmed spike gap, §9.5): mocks configured in
   `beforeEach` currently attach to the file scope; make them test-function scoped.
2. **More mock patterns**: `vi.fn()` assigned and used via `mockImplementation`,
   `jest.fn().mockImplementation`, `jest.mock` with factory, `partialMock`, `proxy`-style
   doubles. Each pattern needs a fixture + a test.
3. **DRIFT-002 (signature arity)** — rule exists, but stubs rarely carry signatures;
   extract stub arity from `vi.fn((a, b) => ...)` implementations.
4. **Loose name-based resolution fallback** (syntax-only mode when no tsconfig) — the
   `SymbolIndex.resolveByName` path is untested end-to-end.
   **Acceptance:** each item has a planted-violation fixture and a healthy twin; self-audit stays clean.

### Step 3 — Phase 2: PHP (unconfirmed until the first integration spike) · `sequenced`

1. Spike: port the engine's mock model to `php-parser` output (E6 proved parsing works;
   the open question is `shouldReceive`/`willReturn` chain → `ConfiguredValueIR` fidelity).
2. Implement `packages/parser-php` with `phpunit` + `pest` detection; wire
   `Drift004ConstructorDrift`.
3. Extend `.momusrc` languages.`php` (already modeled), CLI `--language`, fixtures + golden.
   **Acceptance:** PHP fixture gallery green; `momus audit` on a PHPUnit repo finds
   `createMock('X')` with a stale member (DRIFT-001) and a `willReturn` that echoes (TAUT-002).

### Step 4 — Phase 3: git-diff scoping + hooks · `sequenced`

1. `git diff --name-status` + `--find-renames` plumbing → `changedPaths`; DRIFT-006
   (stale-mock) with `changedSymbolIds` (§3.3.2).
2. `momus precommit` (fast, drift-only on the diff) + `momus serve` file-watching mode.
   **Acceptance:** on a repo where a production member was renamed, `precommit` flags the
   stale mock in < 500 ms for 10k LOC (perf budget §2.7).

### Step 5 — Phase 4: distribution · `sequenced`

1. GitHub Action `momus/action` (composite: install → audit → annotate PR).
2. Publish `@momus/*` to npm; register `momus-mcp` in the MCP registry.
   **Acceptance:** a PR on any TS repo shows Momus annotations; `npx -y momus-mcp` serves.

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
| `beforeEach`-configured mocks produce wrong scopes | Step 2.1; fixtures will pin the semantics before rules depend on them |
| PHP chain-fidelity assumptions | Step 3.1 spike gates the whole phase |
| Node version skew (20 vs 22 vs 25 native TS) | `engines: >=20`; CI runs 22; no parameter properties in source |
