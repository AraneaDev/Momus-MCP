# 6. Repository Layout & Tech Stack

> Normative. The physical layout of the `momus-mcp` repository, dependency choices, build
> setup, CI/CD, and the test strategy (including the anti-pattern fixture gallery).

## 6.1 Tech stack decision

| Concern | Choice | Rationale |
|---|---|---|
| Language | TypeScript (strict), Node.js ≥ 20, ESM | Shares ecosystem with the Phase-1 target language; the MCP SDK is TS-first; fastest iteration for a rules engine. Rust was evaluated: better perf, but plugin model + MCP SDK maturity favor TS; performance-critical paths are isolated behind `SymbolIndex` and can be swapped to native later without API change. |
| Monorepo | `npm` workspaces (confirmed in env; pnpm was unconfirmed, so the spec now mandates npm — swap is a drop-in if a project prefers pnpm) | Zero extra tooling; `npm ci` everywhere (CI, contributors). |
| MCP SDK | `@modelcontextprotocol/sdk@^1.29` via **subpath imports** | Canonical; stdio + Streamable HTTP; `McpServer` class. The published tarball has never shipped the root `index.js` its exports map points at (validated 1.12–1.30 — `09-validation-report.md` F2): import `@modelcontextprotocol/sdk/server/mcp.js`, `/server/stdio.js`, `/client/index.js`, `/client/stdio.js`. `zod` is a required peer for tool schemas. |
| TS parsing | `typescript@^5.9` (compiler API) | Type-aware analysis, zero extra deps (§2.2.2). Pin `^5.9`: TS7's npm package exposes no programmatic API from ESM (F1). |
| PHP parsing | `php-parser` (glayzzle) | Pure JS, no PHP runtime (§2.2.3). |
| Index cache | `better-sqlite3` (shipped — `.momus/cache/`, keyed by file content hash + workspace digest) | Synchronous, embedded, fast for IR cache. |
| Watcher | `chokidar` (shipped — `momus serve --watch` invalidates the `ts.Program` cache on source add/change/unlink) | File watching for `momus serve`. |
| CLI framework | none (hand-rolled arg parsing, implemented) | Only 7 subcommands; avoids a dep. |
| Test runner | `vitest` | Same ecosystem; fast; snapshot support. |
| Lint/format | shipped — ESLint 10 (flat config, typescript-eslint) + Prettier (`lint`, `lint:fix`, `format`, `format:check` scripts) | Consistent authoring style; fixtures/`experiments` excluded. |
| Releases | `release-please` (single lockstep version, Knossos-style) | Conventional-commit → version PR → npm publish + GitHub Release. |
| CI | GitHub Actions | Free, ubiquitous; action artifact in-repo. |
| License | MIT | Chosen in §1.7. |

**Explicit non-dependencies (all confirmed in the build):** no test framework is ever imported
at runtime (P4). No `tree-sitter` in v1 (see §2.2.2 rationale). **`@momus/core` has ZERO runtime
dependencies** — a built-in glob matcher replaced picomatch (whose `types` are untyped and whose
ambient shim is ignored when the module resolves to real JS), and JSONC stripping is built in.
`server` is the only package that brings the MCP SDK + `zod`. No network client in core; only
`server` optionally brings the HTTP transport.

**Node ≥ 20 note (confirmed on Node 25):** `momus`/`momus-mcp` bins execute raw `.ts` via Node's
native strip-only mode, which does **not** support TS parameter properties (`constructor(public x)`)
— the codebase avoids them (see `packages/core/src/config.ts`).

## 6.2 Repository tree

```
momus-mcp/
├─ package.json                     # root: workspaces, scripts, engines
├─ tsconfig.base.json               # strict: true, verbatimModuleSyntax, etc.
├─ .momusrc                         # Momus configures Momus (self-audit)
├─ eslint.config.js
├─ .prettierrc
├─ .github/
│  ├─ workflows/
│  │  ├─ ci.yml                     # unit + integration + self-audit + benchmarks (smoke)
│  │  ├─ pr-title.yml               # conventional-commit PR title gate (release-please input)
│  │  └─ release-please.yml         # release-please → npm publish + GitHub Release
│  └─ actions/momus/                # the Phase-4 GitHub Action (composite)
├─ packages/
│  ├─ core/                         # @momus/core — engine (no MCP, no CLI)
│  │  ├─ src/
│  │  │  ├─ ir.ts                   # §2.3 IR types
│  │  │  ├─ parser.ts               # LanguageParser, ParseContext
│  │  │  ├─ index.ts                # SymbolIndex, resolution, incremental updates
│  │  │  ├─ discovery.ts            # file walk, .gitignore, caps
│  │  │  ├─ rules/
│  │  │  │  ├─ rule.ts              # Rule, RuleContext, engine
│  │  │  │  ├─ tautology/           # TAUT-001…006
│  │  │  │  ├─ drift/               # DRIFT-000…006
│  │  │  │  ├─ hygiene/             # MOCK-001…002
│  │  │  │  └─ dataflow.ts          # §3.2 provenance pass
│  │  │  ├─ assignability.ts        # §3.4 structural comparison
│  │  │  ├─ suppress.ts             # §3.5 suppression parsing & filtering
│  │  │  ├─ config.ts               # .momusrc load + schema validation
│  │  │  ├─ format/
│  │  │  │  ├─ markdown.ts          # §5.3
│  │  │  │  └─ json.ts              # §5.4 envelope
│  │  │  └─ audit.ts                # AuditEngine: discovery→parse→index→rules→format
│  │  └─ test/                      # unit tests per module
│  ├─ parser-typescript/            # @momus/parser-typescript — TS API → IR
│  │  ├─ src/index.ts               # implements LanguageParser
│  │  └─ test/
│  ├─ parser-php/                   # @momus/parser-php — php-parser → IR
│  │  ├─ src/index.ts
│  │  └─ test/
│  ├─ server/                       # @momus/mcp-server — the MCP daemon
│  │  ├─ src/
│  │  │  ├─ index.ts                # McpServer wiring, capabilities, tool registry
│  │  │  ├─ tools/                  # one module per tool (§4.2)
│  │  │  └─ session.ts              # warm SymbolIndex + watcher lifecycle
│  │  └─ test/
│  ├─ cli/                          # @momus/cli — `momus` binary
│  │  ├─ src/
│  │  │  ├─ index.ts                # command dispatch (audit, drift, contract, rules, serve, hook, doctor, init)
│  │  │  └─ commands/
│  │  └─ test/
│  └─ action/                       # @momus/action — composite GitHub Action (Phase 4)
│     └─ action.yml
├─ test/
│  ├─ fixtures/
│  │  ├─ clean/                     # must produce ZERO findings (false-positive gate)
│  │  │  ├─ ts-vitest/  ts-jest/  php-phpunit/  php-pest/
│  │  ├─ gallery/                   # anti-pattern gallery: one deliberate violation per fixture
│  │  │  ├─ taut-001-self-compare/  … per rule per framework
│  │  │  └─ drift-001-missing-member/
│  │  └─ synth/                     # fixtures for synthesize_mock_contract goldens
│  ├─ golden/                       # expected outputs (markdown + json) per fixture
│  ├─ integration/                  # end-to-end: CLI invocations + MCP client sessions
│  └─ corpus/                       # optional: real-world OSS repos for perf/precision soak (git submodule, CI-only)
├─ bench/                           # perf budgets §2.7
├─ schemas/
│  └─ momusrc.schema.json
└─ docs/                            # this specification
```

## 6.3 Package boundaries & dependency direction

```
cli ──▶ core · server
server ──▶ core, parser-typescript, parser-php, @modelcontextprotocol/sdk
core ──▶ (no package deps; parsers injected)
parser-typescript ──▶ core (types only)
parser-php ──▶ core (types only)
action ──▶ (wraps cli via npx)
```

Rules:

1. `core` never imports parsers or the SDK; language plugins are registered at composition
   root (server/cli). This keeps rules language-agnostic (IR-only, invariant §2.3.3.3).
2. `server` holds all MCP-specific code; `core` knows nothing about MCP. The same
   `AuditEngine` serves CLI and MCP — guaranteed identical output (P2).
3. `parser-typescript`/`parser-php` depend on `core` **types only** (`import type`), so the
   engine can't accidentally leak parser-specific behavior.

## 6.4 Build & dev scripts

Root `package.json` scripts (normative — **the implemented scripts**):

```jsonc
{
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "test": "vitest run",
    "test:watch": "vitest",
    "audit-self": "tsx packages/cli/src/index.ts audit . --max-issues 0",
    "serve": "tsx packages/cli/src/index.ts serve"
  }
}
```

Packages run **directly from `src/`** via `tsx` and Node's native TS support (no `dist/` build
in Phase 1 — `exports` maps point at `./src/index.ts`). `engines: { node: ">=20" }`.

### 6.4.1 Exit codes and CI honesty

`momus audit`/`momus drift` exit `1` when **errors** exist, `0` when clean, `2` usage/config
error, `3` internal. Exit codes and the report's `CLEAN:` flag use the **pre-truncation**
counts (`summary.totalErrors`), so `--max-issues 0` (summary-only) never masks findings.

## 6.5 CI/CD

### 6.5.1 `ci.yml` + `pr-title.yml` (every PR)

`ci.yml` jobs (`test` includes typecheck, tests, lint, format, self-audit, and the CLI fixture
smoke — see `.github/workflows/ci.yml`):

| Job | Gate |
|---|---|
| `commit-hygiene` | full-history scan: no Codebuff attribution footer in any commit |
| `release-config` | `scripts/verify-release-config.mjs` — release-please config/version/dep lockstep |
| `test` | typecheck 0 errors + vitest (all packages) + lint + format:check + `audit-self` CLEAN + CLI fixture smoke (planted violations → exit 1) |

`pr-title.yml` (`pull_request_target`, payload-only, `permissions: {}`):

| Job | Gate |
|---|---|
| `conventional-title` | PR title matches Conventional Commits (`feat`/`fix`/`!` cut a release) |

**Branch protection on `main` (live):** no direct pushes (enforced for admins too — every
change goes through a PR); required checks `commit-hygiene` + `conventional-title` +
`release-config` + `test`, branches must be up to date with `main` (strict); no review
required (solo repo); force-push and branch deletion blocked. The release-please bot's
version PRs pass the same gates.

### 6.5.2 `release-please.yml` (shipped in-repo)

`release-please` reads Conventional Commits on `main` and opens/updates a version PR; on merge
it creates the `vX.Y.Z` tag + GitHub Release, then the workflow's `release_created` steps run
the same CI gate (typecheck + test). A publish step (`scripts/publish.mjs` → `npm publish -w
@momus/*` in dependency order, `access: public` from each package's `publishConfig`) is
**dormant during pre-release**: it only activates when an `NPM_TOKEN` secret exists, so 0.0.x
tags never auto-publish. All five
packages share **one lockstep version** (`release-please-config.json` bumps every workspace
`package.json` via `json` extra-files; internal `@momus/*` deps use `~0.0.1` ranges so they
track in lockstep). npm provenance is pre-wired (`id-token: write`); enable it per package via
`publishConfig.provenance`. Publishing is blocked until an `NPM_TOKEN` secret exists. The
action (`momus-mcp/action`) is published as a separate release artifact pointing at
`@momus/cli@<tag>`. Versioned from **0.0.1** (`.release-please-manifest.json`).

### 6.5.3 The GitHub Action (Phase 4, shipped in-repo)

`packages/action/action.yml` — composite action (implemented):

```yaml
name: 'Momus Mock & Test Integrity Audit'
description: 'Run the Momus static audit on the diff and post PR check annotations.'
inputs:
  base:       # base ref; defaults to PR base SHA, then main
  fail-on:    # error | warning | none (default error)
runs:
  using: 'composite'
  steps:
    - run: npx -y @momus/cli@latest audit . --git-diff --base "${{ inputs.base || github.event.pull_request.base.sha || 'main' }}" --json --max-issues 50 || true
    - run: npx -y @momus/cli@latest annotate-pr --base "${{ inputs.base || github.event.pull_request.base.sha || 'main' }}"
      env: { GITHUB_TOKEN: ${{ github.token }}, MOMUS_FAIL_ON: ${{ inputs.fail-on || 'error' }} }
```

Behavior contract (implemented in `momus annotate-pr`): reads `GITHUB_TOKEN`,
`GITHUB_REPOSITORY`, `GITHUB_SHA`; posts a GitHub Checks API run with annotations at exact
file:line (`failure` for errors, `warning` otherwise, ≤ 50 per run); conclusion fails when
`error`-severity findings exist (or `warning` with `fail-on: warning`); never writes to the
user's repo. Depends on `@momus/cli` being published (`npx -y @momus/cli@latest`).

## 6.6 Testing strategy

### 6.6.1 Unit tests

- Per module: IR builders, resolution (tsconfig paths, composer `use`), dataflow provenance
  (each `SourceKind`), assignability table (§3.4 every row), suppression parser (regex table),
  formatters (grammar invariants §5.4.2).
- **Table-driven:** each rule gets a table of (input snippet → expected rule/severity/span).

### 6.6.2 Fixture gallery (integration)

`test/fixtures/gallery/<rule-id>/` contains a minimal but realistic pair: production module +
test file with **exactly one** deliberate anti-pattern. `test/golden/<rule-id>/*.md|*.json`
pins byte-exact expected output. Adding a rule ⇒ adding its gallery fixture is mandatory.

The `clean/` corpus mirrors the gallery structure but with correct tests — the false-positive
gate: `audit` must return zero issues.

**Mutation-style drift tests:** the drift fixtures are run twice — once against a
"current" production tree and once against a tree where the production API was mutated
(member renamed, param added, return type changed); the second run must report the
corresponding DRIFT rule. This proves the detector tracks *changes*, not just static mismatches.

### 6.6.3 MCP integration tests

Drive the server over its stdio transport with a real MCP client (`@modelcontextprotocol/sdk`
client) against fixture workspaces:

- `tools/list` returns exactly the 5 tools, deterministic order, < 4 KB.
- Each tool's happy path, error path (`NOT_FOUND`, `INVALID_BASE_REF`), and annotation fields
  (`readOnlyHint` etc.) match §4.2.
- Statelessness: two identical `tools/call` sequences return identical results.

### 6.6.4 Golden determinism

Byte-exact snapshot tests run on linux CI (line endings normalized on Windows/macOS jobs via
`.gitattributes`). Golden files are updated only by explicit `vitest -u` commits with review.

### 6.6.5 Soak & precision (optional, CI-only)

`test/corpus/` clones 2–3 well-known OSS repos (e.g. a mid-size vitest project) and asserts:
(a) perf budgets §2.7 hold; (b) findings on the corpus are triaged into a tracked
`corpus-expected.json` so regressions in precision are visible diffs, not silent changes.

## 6.7 Release process (normative)

1. PRs merge to `main` with Conventional Commit titles (`pr-title.yml` gates them;
   `feat`/`fix`/`!` cut a release).
2. `release-please.yml` on `main`: release-please bumps the lockstep version → `CHANGELOG.md`
   → tag `vX.Y.Z` + GitHub Release → the workflow publishes `@momus/core`,
   `@momus/parser-typescript`, `@momus/parser-php`, `@momus/mcp-server`, `@momus/cli`
   (all at the same version) via `npm run publish` — **dormant until an `NPM_TOKEN`
   secret exists** (pre-release 0.0.x tags never auto-publish).
3. `@momus/cli` is the only package with a `bin` (`momus`).
4. The MCP server is registered on public registries (Phase 4) with install command
   `npx -y @momus/mcp-server@latest` (stdio) and a documented `claude_desktop_config.json` /
   equivalent snippet for the major MCP clients.

---

**Next:** [`07-roadmap.md`](./07-roadmap.md) — phased implementation plan.
