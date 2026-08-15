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

> Engine, parser, MCP server, CLI, and test suites are **implemented and green** (96 tests).
> Remaining Phase-1 items: v0.1 packaging (Step 1 of `10-build-plan.md`), `better-sqlite3`
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

## Phase 2 — PHP Support & Multi-language Normalizer (L, ~4 weeks)

**Goal:** parity for PHP (PHPUnit/Pest) with the same rules, one shared engine.

**Deliverables:**
- `parser-php` implementing `LanguageParser` via `php-parser` (§2.2.3): namespaces/`use`
  resolution to FQCN, constructor promotion, docblock `@return`/`@param` typing, anonymous
  classes, Mockery/Pest patterns (§2.5.2).
- PHP galleries + clean corpus + goldens for all rules; DRIFT-004 constructor-awareness;
  PHPUnit constructor-bypass exemption (§3.5.3).
- `synthesize_mock_contract` gains `phpunit`/`pest` templates.
- `momus doctor` reports PHP-language readiness; `languages.php.enabled` in `.momusrc`.

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

## Phase 3 — Git-Diff Awareness, Hooks & Interactive CLI (M–L, ~3 weeks)

**Goal:** Momus in the developer/agent loop *before* commit, not just on demand.

**Deliverables:**
- **Diff scoping:** `verify_mock_drift --scope git-diff` with `baseRef`; `DiffScope`
  (§3.1) feeding DRIFT-006 + diff-filtered rule runs (`changedPaths` restriction) for
  sub-second pre-commit runs.
- **Pre-commit hook:** `momus hook` — reads staged files, runs diff-scoped audit, exits 1 on
  `error` findings touching staged lines; emits `momus hook --install`/`--uninstall`
  (writes `.git/hooks/pre-commit` after confirmation — the one sanctioned write, gated by
  `--yes` per §1.5).
- **CLI companion:** `momus audit --fix` (dry-run by default, prints diff, requires
  `--yes`; refused when `CI=true` without `--yes`), `momus annotate` (machine-readable
  JSONL for editor plugins), `--json` flag parity with structuredContent envelope.
- **Editor/agent ergonomics:** `momus serve --transport http` (Streamable HTTP) for remote
  clients; server reports `protocolVersion` + deterministic tool order per §4.1.

**Acceptance criteria:**
- Hook on a fixture repo with a planted drift violation: commit blocked; `git diff`-scoped
  run completes < 500 ms on 10k-LOC workspace.
- `--fix` on TAUT-001/002/003 fixtures produces correct, minimal diffs; dry-run output is
  byte-identical to `--fix --dry-run` preview.
- `DRIFT-006` fires only when target changed and mock file untouched (no false positives on
  untouched-but-stale mocks outside the diff).

**Exit:** "commit-time" and "agent-loop" paths both enforced; findings converge to zero
before merge. **Top risks:** git plumbing edge cases (renames, merge commits) — mitigate with
`git diff --name-status` + `--find-renames`, fallback to workspace scope with `SYS-003` note.

---

## Phase 4 — CI/CD Action & Public Distribution (M, ~2–3 weeks)

**Goal:** Momus as a standard part of the pipeline and discoverable by any agent.

**Deliverables:**
- **GitHub Action** (`packages/action/action.yml`, spec §6.5.3): diff-scoped audit, PR
  annotations at exact file:line, `fail-on` severity policy.
- **Registry publishing:** npm packages (`@momus/*`), MCP registry listings (official MCP
  servers list + community registries) with `npx -y @momus/mcp-server` install snippet;
  README quickstart for Claude Desktop / other clients.
- **Docs site** (docs/ rendered) + changelog-driven releases (§6.7).
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
