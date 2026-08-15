# Momus-MCP — Technical Specification

**Momus-MCP** is a production-ready, open-source Model Context Protocol (MCP) server that acts as an
unsparing, deterministic, local-first **mock and test integrity auditor** for coding agents.
Named after Momus, the classical god of sharp critique and fault-finding, it exists to stop
"false-green" test suites — suites that pass while proving nothing.

This directory is the authoritative specification. It is written so that **agents and engineers
can be pointed at it** and implement the system without further clarification. Every module,
interface, rule, schema, and phase below is normative unless explicitly marked *non-normative*.

---

## How to read this spec

| Document | Contents | Read when |
|---|---|---|
| [`01-executive-summary.md`](./01-executive-summary.md) | Vision, problem statement, design principles, hard constraints, threat model, scope | Before anything else |
| [`02-architecture.md`](./02-architecture.md) | Parsing strategy, normalized IR, symbol index, mock identification catalog, configuration | Implementing the engine |
| [`03-analysis-algorithms.md`](./03-analysis-algorithms.md) | Rule catalog, tautology & drift algorithms, suppression semantics, false-positive policy | Implementing rules |
| [`04-mcp-tool-definitions.md`](./04-mcp-tool-definitions.md) | Full tool manifest, JSON Schemas, example payloads, agent usage protocol | Implementing the MCP server |
| [`05-output-format.md`](./05-output-format.md) | Issue line grammar, Markdown/JSON report schemas, token budget contract | Implementing formatters |
| [`06-repository-layout.md`](./06-repository-layout.md) | Monorepo structure, tech stack, CI/CD, test strategy, release process | Scaffolding the repo |
| [`07-roadmap.md`](./07-roadmap.md) | Phased implementation plan with acceptance criteria | Scheduling work |
| [`09-validation-report.md`](./09-validation-report.md) | Spike results: what was experimentally proven buildable, and the spec deltas it forced | Before Phase 1, and whenever a spec section seems risky |
| [`10-build-plan.md`](./10-build-plan.md) | **The achievable goal**: what is already built & verified, and the sequenced plan to v0.1 → Phase 4 | Starting work today |

**Reading order for a new contributor:** `01` → `02` → `03` → `06` (build the engine), then
`04` → `05` (expose it), then `10` → `07` (what's done, what's next).

---

## Canonical facts (defined once here, referenced everywhere)

- **Project name:** Momus-MCP · binary/CLI: `momus` · npm scope: `@momus/*` · MCP server name: `momus-mcp`
- **Language of implementation:** TypeScript (Node.js ≥ 20, ESM). Rationale in §2 of `01-executive-summary.md`.
- **Package manager:** `npm` workspaces (confirmed in this environment; pnpm unconfirmed — swap is drop-in). **Test runner:** `vitest`. **License:** MIT.
- **Phase-1 languages/frameworks:** TypeScript/JavaScript with Vitest and Jest.
  **Phase-2:** PHP with PHPUnit and Pest.
- **The four primary MCP tools:** `audit_test_fidelity`, `detect_tautological_assertions`,
  `verify_mock_drift`, `synthesize_mock_contract` — plus the supporting tool `list_rules`.
- **Rule IDs:** `TAUT-00x` (tautological assertions), `DRIFT-00x` (mock contract drift),
  `MOCK-00x` (mock hygiene). The complete catalog lives in `03-analysis-algorithms.md` §3.3.
- **Hard constraints:** read-only tools, no network egress, no execution of user code,
  no destructive writes without explicit confirmation, every issue rendered in **< 100 tokens**.

---

## Glossary

| Term | Definition |
|---|---|
| **False-green** | A test suite that passes while failing to verify the behavior it claims to verify (over-mocked, tautological, or drifted). |
| **Tautological assertion** | An assertion that cannot fail — it only re-asserts what was already configured or compared against itself. |
| **Mock drift** | A test double whose shape (members, signatures, types) no longer matches the production symbol it doubles. |
| **Contract fidelity** | The degree to which a test double matches the production interface it replaces. |
| **Symbol index** | The in-memory/embedded graph of production symbols (classes, interfaces, methods, types) built from ASTs. |
| **IR** | Intermediate Representation — the language-neutral module model emitted by parser plugins. |
| **SUT** | System Under Test — the production code a test file is meant to exercise. |
| **Suppression** | An explicit, auditable opt-out (`// @momus-ignore` family) for intentional stubbing. |
| **Mock saturation** | A heuristic measure of over-mocking: the share of a test's dependencies that are test doubles. |

---

## Status

- [x] **Pre-implementation spike** (`09-validation-report.md`) — all experiments green, spec deltas applied
- [x] **Phase 1 implementation** — built and verified: `@momus/core` (rules engine, suppression, formatters), `@momus/parser-typescript` (custom-host program, mock detection, dataflow), `@momus/mcp-server` (5 tools), `@momus/cli` (audit/drift/contract/rules/serve/init/doctor). 96 tests green, self-audit clean, CI workflow in place. See `10-build-plan.md`.
- [x] **v0.1 packaging** (Step 1 of `10-build-plan.md`) — README, npm pack dry-run, `npx momus` verification
- [ ] Phase 2 (PHP support) — not started
- [ ] Phase 3 (git-diff hooks + CLI companion) — not started
- [ ] Phase 4 (CI action + registry publishing) — not started

See [`10-build-plan.md`](./10-build-plan.md) for the achievable goal and sequenced work, and
[`07-roadmap.md`](./07-roadmap.md) for the original phased plan.
