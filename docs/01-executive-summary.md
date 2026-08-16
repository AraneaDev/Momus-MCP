# 1. Executive Summary & Design Principles

> Normative. This document defines *why* Momus-MCP exists and the constraints every later
> design decision must respect.

## 1.0 Naming

**Momus** (Μῶμος) is the ancient Greek spirit and personification of **satire, mockery, blame,
and harsh criticism** — the one deity whose entire office was to find fault, and who was cast out
of Olympus for doing it too well. His name literally translates to **"blame"** or **"censure"**.

The name is deliberate and doubly apt:

- Momus is the **ultimate critic among the deities**, and this project is an *unsparing
  fault-finder* for test suites — see principle P5 (*unsparing but fair*).
- Momus is the god of **mockery**, and the subject of this tool is **mock objects** — the test
  doubles that stand in for production code.

## 1.1 Vision

Coding agents routinely declare tasks finished on the strength of tests that cannot fail in the
ways that matter. Momus-MCP gives agents and developers a **deterministic, local-first static
auditor** that answers one question about any test suite:

> **"If this test suite passes, what has actually been proven about the production code?"**

Momus-MCP is positioned as the *test-integrity counterpart* to linters and type checkers:
where ESLint enforces style and `tsc` enforces types, Momus enforces **the contract between a
test double and the production code it stands in for**. It is not a coverage tool (that asks
"was this line executed?") and not a mutation tester (that asks "would a fault fail this test?").
It asks a cheaper, earlier question: *"could this test fail at all, for the right reason?"*

### 1.1.1 Positioning statement

> Momus-MCP is the unsparing fault-finder for test doubles: it statically verifies that mocks
> match their production contracts, detects assertions that cannot fail, and surfaces drift
> before code is committed — local-first, deterministic, and token-efficient.

### 1.1.2 Non-goals (explicit)

- **Not a test runner.** Momus never executes tests. All analysis is static (AST-level).
- **Not a coverage tool.** No instrumentation, no runtime hooks.
- **Not a mutation tester.** No code rewriting or execution.
- **Not a mocking library.** It analyzes mocks; it does not provide them.
- **Not a network service.** No cloud component, no telemetry, no phone-home.
- **Not a dynamic analyzer.** Data-flow analysis is intra-procedural and conservative;
  it may miss cases that require runtime information (documented limitations in §3.7 of `03-analysis-algorithms.md`).

## 1.2 The problem: false-green test suites

### 1.2.1 Failure modes

When coding agents encounter failing tests, the observed failure modes are:

1. **Over-mocking** — dependencies are stubbed out so aggressively that the buggy path being
   fixed is itself replaced by a stub. The test then passes because the bug is no longer reachable.
2. **Tautological assertions** — assertions that re-assert mock wiring instead of business
   outcomes: `expect(mock.getTotal()).toBe(42)` where `mock.getTotal` was configured with
   `mockReturnValue(42)` a line earlier.
3. **Mock drift** — test doubles return shapes, types, or signatures that no longer match the
   production AST definitions. Tests pass against a fictional version of the API.
4. **Zero-reach mocks** — stubs and spies that are configured or asserted but never influence
   any observable outcome (the SUT never calls them; no assertion consumes them).

Each failure mode produces the same observable symptom: **green suite, unproven code**.

### 1.2.2 Why static analysis is the right tool

- Tests and their mocks are **code artifacts**; contract violations are statically visible in
  most cases (missing methods, wrong arity, mismatched shapes).
- Static analysis is **deterministic and fast** — no test execution, no flakiness, no network.
- Static analysis can run **in the agent's editing loop** (MCP tools) and **in CI/pre-commit**
  with identical results, because results depend only on file contents.

## 1.3 Design principles

| # | Principle | Consequence |
|---|---|---|
| P1 | **Local-first** | Everything runs in-process on the user's machine. No accounts, no servers, no egress. The MCP server speaks `stdio` by default; `--transport http` (Streamable HTTP) is an explicit opt-in for remote use. |
| P2 | **Deterministic** | Identical workspace state ⇒ identical output. No randomness, no timestamps in output, no dependence on ambient environment beyond the files themselves. Rule order, issue order, and IDs are stable. |
| P3 | **Token-efficient** | Every issue renders in **< 100 tokens**; tool descriptions are written to fit prompt budgets; reports cap at a configurable number of issues (`maxIssuesPerReport`, default 50). See `05-output-format.md`. |
| P4 | **Zero framework boot** | Analysis is pure static parsing. Momus never imports, evaluates, or executes the user's modules or test frameworks. No `jest`/`vitest`/`phpunit` bootstrap, no `ts-node`, no project module loading. This is also a security boundary (§1.5). |
| P5 | **Unsparing but fair** | Rules are precise and conservative: they must have **near-zero false positives** on clean code (target < 1% on the clean corpus, §3.6 of `03-analysis-algorithms.md`). Uncertainty is reported as `info`, not `error`. |
| P6 | **Auditable exemptions** | Suppressions are explicit, visible comments/config — never silent heuristics. Every suppressed finding can be listed with `momus rules --show-suppressed`. |
| P7 | **Extensible by design** | Language support is a plugin interface (`LanguageParser`), rules are composable units (`Rule`), output is a pure formatter over a stable `Issue` model. |
| P8 | **Read-only by default** | All MCP tools are `readOnlyHint: true`, `destructiveHint: false`. Nothing writes outside `.momus` cache unless a future mutation tool is explicitly approved (see §1.5). |
| P9 | **Dogfooded** | The Momus repository runs Momus on itself in CI. Zero findings allowed. |
| P10 | **Fail loudly, fail locally** | Parse errors and unresolvable imports are reported as structured diagnostics (`severity: "error"`, rule `SYS-001`), never silently skipped. |

## 1.4 Scope

### 1.4.1 Supported languages and frameworks (matrix)

| Phase | Language | Test frameworks | Mocking patterns detected |
|---|---|---|---|
| 1 | TypeScript / JavaScript | Vitest, Jest | `vi.mock`, `vi.spyOn`, `vi.fn`, `jest.mock`, `jest.spyOn`, `jest.fn`, `jest.requireMock`, `vi.mocked`, manual object-literal and `Proxy`-based doubles |
| 2 | PHP | PHPUnit, Pest | `createMock`, `createStub`, `createConfiguredMock`, `createPartialMock`, `getMockBuilder`, `getMockForAbstractClass`, Mockery (`Mockery::mock`/`spy`, `shouldReceive`), Pest `mock()`/`spy()` helpers, anonymous-class stubs |
| 3+ (extensible) | Rust, Python, Go (candidate, via new `LanguageParser` plugins) | — | — |

**Framework detection:** per-file, by import surface (`vitest`, `@jest/globals`, `PHPUnit\Framework\TestCase`, Pest functions). A file may declare multiple frameworks; rules apply per-detected framework.

### 1.4.2 Supported test styles (Phase 1)

- `*.test.ts`, `*.spec.ts`, `*.test.tsx`, `*.spec.tsx`, `*.test.js`, `*.spec.js`, `*.test.mjs`
- Test files located under any directory matching `**/__tests__/**`, or named with the above suffixes.
- Configurable via `.momusrc` `testFilePatterns` (defaults above).

## 1.5 Threat model & hard constraints

Momus-MCP parses **untrusted workspace code** (the user's project) inside its own process.
Threat model:

| Threat | Mitigation |
|---|---|
| Malicious/accidental code execution during parse | Parsers are **pure AST builders**: TypeScript compiler API and `php-parser` do not evaluate code. Momus never `import()`s project modules, never calls `require`, never spawns the project's toolchain. Enforced by an import-statement lint rule in the Momus codebase (no dynamic require of project paths outside the parser sandbox). |
| Data exfiltration | **No network APIs** in the runtime path. All tools are pure functions of the workspace. The only network-touching code is the optional Streamable HTTP transport, which serves the same read-only tools. |
| Destructive writes | All MCP tools are read-only (`destructiveHint: false`). The CLI's future `--fix` / `momus apply` mode (Phase 3) **must** (a) print a full diff, (b) require `--yes`, and (c) refuse to run when `CI=true` without `--yes`. Default: no writes at all. |
| Resource exhaustion (huge files, symlink loops) | File discovery honors `.gitignore`; maximum file size (default 2 MB) and maximum workspace size (default 500k LOC indexed per run) with explicit `SYS-002` warnings; symlink loops are pruned. |
| Cache poisoning | The `.momus` cache is keyed by content hash (`sha256` of file bytes); any content change invalidates the entry. Cache is advisory only — results are always recomputable. |
| Prompt-injection via code comments | Suppression directives are **syntactically strict** (regex-validated, e.g. `@momus-ignore(?:[:=][A-Z0-9-]+)?`) and only suppress specific rules/spans — never arbitrary text. They cannot alter tool behavior beyond scoped suppression. |

**Zero-destructive-writes rule (canonical):** *Momus must never modify a user file without an
explicit, interactive confirmation of the exact diff.* In the MCP surface this is trivially
satisfied: all tools are read-only. In the CLI, `apply`/`--fix` is gated as above.

## 1.6 Success metrics

| Metric | Target | Measured by |
|---|---|---|
| False-positive rate on clean code | < 1% of clean-corpus files report any issue | Clean corpus in `test/fixtures/clean/**` must yield 0 issues |
| Precision on anti-pattern gallery | 100% of planted violations detected in Phase 1 corpus | `test/fixtures/gallery/**` golden outputs |
| Single-file audit latency | < 200 ms (cold, first run) | benchmark suite (`bench/`) |
| Workspace index (10k LOC) | < 1 s cold, < 100 ms incremental | benchmark suite |
| Issue rendering | < 100 tokens per issue (mean ≈ 30) | `tokens` field assertion in golden tests |
| Zero self-findings | CI fails if `momus audit .` reports any issue on the Momus repo | CI job `self-audit` |

## 1.7 License & distribution

- MIT license, source-available from day one.
- Distribution: npm packages (`@momus/core`, `@momus/mcp-server`, `@momus/cli`, `@momus/parser-typescript`, `@momus/parser-php`), GitHub Action (`momus-mcp/action`), and public MCP registry listings (Phase 4).

---

**Next:** [`02-architecture.md`](./02-architecture.md) — parsing strategy, IR, symbol index, mock identification.
