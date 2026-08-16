# 7. Phased Implementation Roadmap

> Normative. The build order for Momus-MCP. Each phase lists goals, deliverables, acceptance
> criteria, exit criteria, and top risks. Sizes are relative (S/M/L) for scheduling.

## Phase 0 — Scaffold (S, ~1 week) · ✅ DONE (see `10-build-plan.md`)

> Implemented with **npm workspaces** (pnpm was unconfirmed in the build environment and the
> spec now mandates npm — drop-in swap if a project prefers pnpm).

**Goals:** repository skeleton per §6.2; CI green; the spec itself is the first artifact.

**Deliverables:**
- npm workspaces monorepo with `core`, `parser-typescript`, `server`, `cli` packages
  (implemented, running from `src/` via `tsx` — no `dist/` build in Phase 1).
- `ci.yml` unit job + lint + typecheck running.
- `schemas/momusrc.schema.json` + `.momusrc` parser with `SYS-005` diagnostics.
- `docs/` (this specification) committed; `docs/README.md` is the entry point.

**Acceptance:**
- `pnpm build && pnpm typecheck && pnpm test && pnpm lint` pass on a clean checkout.
- `.momusrc` schema validates; invalid config produces `SYS-005` with a precise message.

**Exit:** repo builds in CI; skeleton merged.

---

## Phase 1 — Minimal Viable Daemon + TS/Vitest Engine (L, ~4–6 weeks) · ✅ CORE DONE (see `10-build-plan.md`)

> Engine, parser, MCP server, CLI, and test suites are **implemented and green** (130 tests).
> All Phase-1 items complete: v0.1 packaging (Step 1 of `10-build-plan.md`), `better-sqlite3`
> IR cache, `chokidar` watcher, eslint/prettier, coverage gate.

**Goal:** `momus serve` + CLI running the full Phase-1 rule set on TypeScript/Vitest/Jest with
deterministic, token-budgeted output.

**Deliverables:**

1. **Parser (`parser-typescript`)** — TS compiler API → IR (§2.3): symbols, imports, mocks
   (catalog §2.5.1), assertions, dataflow (§3.2). Type-aware mode via incremental
   `ts.Program` **built over a custom host with parent-enabled source files** (§2.2.2
   constraints F5/F6 — non-negotiable: default program files have no `node.parent`, and
   checker queries need the program's own file instances) when `tsconfig.json` exists;
   syntax-only fallback with `SYS-003` notes.
2. **Engine (`core`)** — `SymbolIndex` with resolution (§2.4), cache via `better-sqlite3`
   (§2.4.3), rule engine (§3.1), rules **TAUT-001…006, DRIFT-000…005, MOCK-001, MOCK-002**
   (TS), assignability (§3.4), suppression (§3.5).
3. **Formatters** — Markdown + JSON envelope (§5), token budgets enforced + asserted.
4. **MCP server (`server`)** — `audit_test_fidelity`, `detect_tautological_assertions`,
   `verify_mock_drift` (workspace scope only), `synthesize_mock_contract`, `list_rules`;
   capabilities + annotations per §4.1/§4.2; `chokidar` watcher keeps the index warm.
5. **CLI (`cli`)** — `momus serve`, `momus audit <paths>`, `momus contract <target>`,
   `momus rules`, `momus init`, `momus doctor`; exit codes (0 clean / 1 findings / 2 config /
   3 internal).
6. **Test suites** — unit + gallery fixtures for every Phase-1 rule + clean corpus +
   golden outputs + MCP session tests (§6.6).

**Acceptance criteria:**
- Every §3.3.1/§3.3.2/§3.3.3 Phase-1 rule has a gallery fixture with pinned golden output,
  and the clean corpus yields **zero** findings.
- `audit_test_fidelity` single-file < 200 ms; index 10k LOC cold < 1 s (§2.7).
- `tools/list` matches §4.2 exactly; all tools are read-only per annotations.
- The false-green scenarios from §1.2.1 (over-mock, tautology, drift, zero-reach) are each
  detected end-to-end through the MCP surface.
- Self-audit: `momus audit .` on the Momus repo reports 0 issues.

**Exit criteria:** a coding agent can be pointed at the Phase-1 server and reliably blocked
from declaring "done" on a false-green TS suite. **Top risks:** dataflow precision on
`beforeEach`-configured mocks (mitigate: conservative scope linking, §3.7); TS program memory
on huge repos (mitigate: incremental program + file caps).

---

## Phase 2 — PHP Support & Multi-language Normalizer (L, ~4 weeks) · ✅ COMPLETE (see `10-build-plan.md` Step 3)

**Goal:** parity for PHP (PHPUnit/Pest) with the same rules, one shared engine.

**Deliverables:**
- `parser-php` implementing `LanguageParser` via `php-parser` (§2.2.3): namespaces/`use`
  resolution to FQCN, constructor promotion, ✅ docblock `@return`/`@param` typing, ✅ anonymous
  classes, ✅ `getMockForAbstractClass` as a distinct pattern, ✅ setUp/property mock bindings
  (`$this->prop = createMock(...)`), Mockery/Pest patterns (§2.5.2).
- PHP galleries + clean corpus + goldens for all rules; DRIFT-004 constructor-awareness;
  PHPUnit constructor-bypass exemption (§3.5.3).
- ✅ `synthesize_mock_contract` gains `phpunit`/`pest` templates.
- ✅ `momus doctor` reports PHP-language readiness; `languages.php.enabled` in `.momusrc`.

**Acceptance criteria:**
- Rule parity matrix (rule × framework) fully green in CI: `TAUT-*`, `DRIFT-*`, `MOCK-*`
  behave identically across vitest/jest/phpunit/pest fixtures (outputs differ only in
  framework-appropriate code spans).
- PHP fixtures parse with zero `SYS-001`; clean PHP corpus: zero findings.

**Exit:** both language families audited by one binary with identical rule semantics.
**Top risks:** `php-parser` typing fidelity (mitigate: docblock parsing + documented nikic
sidecar upgrade path); Mockery closure-form mocks (`Mockery::mock('Foo', fn($m) => …)`) —
handle via closure-body member extraction.

---

## Phase 3 — Git-Diff Awareness, Hooks & Interactive CLI (M–L, ~3 weeks) · ✅ COMPLETE

**Goal:** Momus in the developer/agent loop *before* commit, not just on demand.

**Deliverables (implemented):**
- ✅ **Diff scoping:** `gitChangedPaths` (`--name-status` + `--find-renames`, untracked files
  and rename pairs) → `DiffScope` feeding DRIFT-006 (stale-mock) and diff-filtered drift
  rules. Wired through `momus audit|drift --git-diff --base REF`, `momus precommit`
  (default base HEAD), and MCP `verify_mock_drift` with `scope: git-diff` + `baseRef`
  (git errors surface as tool errors).
- ✅ **Pre-commit companion:** `momus precommit` — drift-only run vs the diff; exits 1 on
  error findings. `momus hook` git-hook installer is also implemented: `hook --install`/
  `--uninstall` (marker-guarded, `--yes`-gated) and `hook` runs the staged-files drift gate.
  (Staged-line granularity remains a later sub-slice.)
- ✅ **annotate-pr:** `momus annotate-pr` posts GitHub Checks API annotations from the
  diff-scoped audit (dependency-free; reads `GITHUB_TOKEN`/`GITHUB_REPOSITORY`/`GITHUB_SHA`,
  `MOMUS_FAIL_ON` policy).
- ✅ **Streamable HTTP transport:** `momus serve --transport http [--port N]` serves the same
  five tools over Streamable HTTP (stateful per-session transports, stateless tools); covered by
  an end-to-end `StreamableHTTPClientTransport` round-trip.
- ✅ **JSONL annotate mode:** `momus annotate [paths...] [--git-diff --base REF]` emits one JSON
  object per finding (workspace-relative file/line/column, rule/severity/message, deterministic
  key order) for editor plugins; exits 1 on error findings.
- ✅ **`--fix` mechanism:** `momus audit --fix` (dry-run unified diff by default) with `--yes` to
  apply and a CI-refusal gate (§1.5); `collectFixable`/`applyFixes`/`unifiedDiff` unit-tested.
  DRIFT-001 emits a real rename fix (unique near-match, quoted per stub api); a planted stale spy
  is diffed, applied, and re-audits clean. TAUT-001/002/003 are semantic tautologies — no safe
  mechanical fix exists — so they stay descriptive-only (a documented decision, §3.6).
- ✅ **File watching:** `momus serve --watch` (chokidar) invalidates the `ts.Program` cache on
  source add/change/unlink, so watch-mode audits reflect on-disk edits without a restart.

**Acceptance criteria:**
- Hook on a fixture repo with a planted drift violation: commit blocked; `git diff`-scoped
  run completes < 500 ms on 10k-LOC workspace.
- `--fix` on the planted stale-spy fixture produces a correct, minimal rename diff; dry-run output
  is byte-identical to `--fix --dry-run` preview. (TAUT-* findings are semantic and intentionally
  not auto-fixed — see §3.6.)
- `DRIFT-006` fires only when target changed and mock file untouched (no false positives on
  untouched-but-stale mocks outside the diff).

**Exit:** "commit-time" and "agent-loop" paths both enforced; findings converge to zero
before merge. **Top risks:** git plumbing edge cases (renames, merge commits) — mitigate with
`git diff --name-status` + `--find-renames`, fallback to workspace scope with `SYS-003` note.

---

## Phase 4 — CI/CD Action & Public Distribution (M, ~2–3 weeks) · IN PROGRESS

**Goal:** Momus as a standard part of the pipeline and discoverable by any agent.

**Deliverables:**
- ✅ **GitHub Action** (`packages/action/action.yml`, spec §6.5.3): composite action with
  diff-scoped audit + `annotate-pr` check annotations, `fail-on` input, base defaulting to
  the PR base SHA. (Not yet end-to-end CI-tested via `act`; publish + registry listing
  blocked on credentials.)
- ✅ **Release scaffolding:** `@changesets/cli` + `.changeset/config.json`, root
  `changeset`/`release` scripts, `publishConfig.access: public` on all five packages, and
  `.github/workflows/release.yml` (version-PR via `changesets/action`, `changeset publish`,
  `v*` tag + GitHub Release). Actual publish still blocked on `NPM_TOKEN`.
- Registry publishing: npm packages (`@momus/*`), MCP registry listings (official MCP
  servers list + community registries) with `npx -y @momus/mcp-server` install snippet;
  README quickstart for Claude Desktop / other clients. — pending credentials
- **Docs site** (docs/ rendered) + changelog-driven releases (§6.7). — changelog scaffolding
  shipped via changesets; docs-site rendering pending
- **Soak corpus CI** (optional but enabled): OSS corpus precision/perf triage (§6.6.5).

**Acceptance criteria:**
- Action runs on a demo PR: annotations posted, check fails on error findings, passes after
  fixes (end-to-end test in CI against a fixture repo via `act` or a GitHub-hosted fixture).
- `npm view @momus/cli` resolves; `npx -y @momus/cli audit .` works in a clean container.
- Registry listings link to working install commands; server passes a smoke `tools/list` +
  `tools/call` against the published package.

**Exit:** a repository can adopt Momus in under five minutes (action or CLI), and any MCP
client can attach `momus-mcp` the same way it attaches any other server.

---

## Cross-cutting concerns (all phases)

| Concern | Requirement |
|---|---|
| Determinism | Byte-identical output for identical workspace state; golden-tested (§5.5). |
| Token budgets | Enforced from Phase 1; authoring lints in CI (§5.1). |
| Security | Threat model §1.5 holds in every phase; the `--fix`/hook writes are the only writes and are gated. |
| Dogfooding | Self-audit CI job from Phase 1 onward (P9). |
| Docs | Spec updates ship with the code change that contradicts them; `docs/README.md` index always current. |

## Sequencing notes

- Phase 1 is the critical path and is self-contained: the MCP server alone already delivers
  the core value ("agents can't claim false-green anymore").
- Phase 2 can proceed in parallel with Phase 3 only if the `core` rule surface is frozen —
  the rule interface (§3.1) is the freeze boundary; treat any change to `RuleContext` as a
  breaking change (major version bump).
- Phase 4 depends on all earlier phases' acceptance criteria; registry listings must not
  ship before `tools/list` output is stable (prompt-cache stability requirement, §4.1).
