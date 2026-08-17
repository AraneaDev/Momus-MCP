# Agent tool surface — design

**Date:** 2026-08-18 · **Status:** approved for planning · **Branch:** `feat/agent-tool-surface`

Momus's MCP server exposes five read-only tools (`audit_test_fidelity`,
`detect_tautological_assertions`, `verify_mock_drift`, `synthesize_mock_contract`,
`list_rules`). Agents that consume findings must re-read source files to act on
them: there is no per-issue explanation, no fix path (the CLI's `audit --fix`
engine is not exposed over MCP), no whole-workspace sweep, no IR inspection for
false-positive debugging, and no environment-readiness check. This spec captures
the decisions and design for the agent-facing surface: six new tools, three
resources, and watcher-driven notifications, composed so that existing tools stay
unchanged. It is the normative input to the `writing-plans` step; implementation
does not begin until the written spec is user-reviewed.

## 0. Decisions (locked)

1. **Approach — narrow tools + supplementary resources.** Six focused tools (each
   one intent, discoverable via `tools/list`), with MCP resources as the
   notification/read channel. No generic dispatch tool, no resources-only design.
2. **Write path — two-phase, one issue at a time.** `preview_issue_fix` is read-only;
   `apply_issue_fix` applies exactly one span-precise fix per call and refuses when
   the file changed since preview. The call itself is the gate (the CLI `--yes`
   analog), so no extra confirmation flag.
3. **The server stays stateless across sessions.** All issue state is re-derivable
   from workspace files + caches; an in-memory per-workspace fix-session registry
   only holds preview hashes for the stale-span guard and is cleared by watcher
   events.
4. **Synthesis/audit tools are extended, not duplicated.** `audit_workspace` reuses
   the existing engine paths (including `git-diff` scope); no new parse surface.
5. **Notifications degrade gracefully.** If the MCP SDK in use cannot express
   `notifications/resources/updated`, the tool path still works; a note in the
   tool descriptions tells agents to refresh resource reads instead. Verified in
   the phase-4 spike.

## 1. The six new tools

### 1.1 `explain_issue` (read-only)

Resolve one issue to a root-cause chain. Input: `path` (workspace-relative test
file) + `issueId` (stable dedupe id from a prior audit result), or the
`{path, rule}` tuple when the id is unavailable. The server re-runs a narrow
single-file audit (parse cache makes this fast), matches the issue, and returns:

- the rule atom that fired, its severity, and the canonical one-line message;
- the mock/assertion statement snippet (span ± 1 line, source text);
- the real-dependency snippet: for DRIFT-* the matched production member/signature
  from the symbol index; for TAUT-* the stub configuration lines; for MOCK-* the
  subject derivation;
- a plain-language cause sentence composed per rule (a per-rule explainer map,
  not free text), plus the same data as structured `astContext` (paths, spans,
  snippets) so agents can jump without re-reading files.

### 1.2 `preview_issue_fix` (read-only)

Input: `path` + `issueId`. Re-runs the narrow audit, resolves the issue's
`FixSuggestion` via the CLI `collectFixable`/`editsByFile`/`buildFixDiff` pipeline
(unchanged — the CLI and MCP share the same fixer), and returns the unified diff
for **that one issue only**, plus the fix description. Returns a clear
"not-fixable" response (with the reason: no span / no code / delete-without-span)
instead of an error when there is nothing to apply.

### 1.3 `apply_issue_fix` (the only writer)

Input: `path` + `issueId`. Applies exactly one fix via `applyFixes` to the single
target file, then re-audits that file and returns the before/after diff **and** the
delta list of remaining issues (`issuesBefore` vs `issuesAfter`). Refusals, each a
distinct typed reason:

- file changed since `preview_issue_fix` (content hash mismatch) → re-preview first;
- target resolves outside the workspace root → path escape;
- no fix / no span → not fixable.

Per-issue granularity is deliberate: each call is one auditable change, and a
broken fix can be reverted by reference to the returned diff. The write path is
line-gated to workspace files (same as the CLI) and never touches config.

### 1.4 `audit_workspace`

Whole-repo sweep without per-file round-trips. Input: optional `languages`
(array over the registry), `scope` (`workspace` | `git-diff` + `baseRef`, reusing
`gitChangedPaths`), `maxIssues` (default 100, cap 500), `includeSuppressed`,
`dedupe` (default true). Output: the standard `AuditResult` envelope **plus** a
`dedupe` section collapsing issues that share a root cause across files (same
rule + same evidence + same cause key), with a `causes` array counted once; the
full list is still present for line-level work. Summary counts stay truthful
(they describe the shown/filtered set, as today).

### 1.5 `get_ir`

Debug surface for false positives. Input: `path`, optional `kind` filter
(`mocks`, `symbols`, `assertions`, `invocations`). Returns the parser IR for the
file — the same shapes the rules consume (`MockIR`, `SymbolIR`, `AssertionIR`,
`invocationSites`) as structured content — plus parse diagnostics when the file
failed. This is the "why didn't this fire / why did this fire" tool; it is
read-only and cheap.

### 1.6 `doctor_status`

Structured version of the CLI's readiness summaries: per language
(`phpReadiness`/`pythonReadiness`/`rustReadiness`/TS/JS signals), the
`RuleId` catalog status, and cache health. One call tells an agent "audit this
workspace now" vs "it lacks a `pyproject.toml`/`composer.json` — expect degraded
coverage" before it burns tool calls on a useless sweep.

## 2. Resources and notifications

- `momus://rules` — the shared 14-rule catalog (same data as `list_rules`).
- `momus://config` — merged `.momusrc` (severities, ignores, token budget,
  languages) as JSON.
- `momus://issues/latest` — last audit result snapshot (JSON, any tool that ran
  an audit writes here; bounded to `MAX_ISSUES` + summary + diagnostics).

Notifications: the server starts the workspace watcher (existing
`watchWorkspace`, extended ignores from the parity work) for the session and,
on add/change/unlink of source files, (a) invalidates the parse cache (already
the behavior) and (b) emits `notifications/resources/updated` for
`momus://issues/latest` if the SDK supports it (spike-gated). Agents that hold
subscribed resources refresh on the notification; agents that don't use the
read tool.

## 3. Write-path safety summary

| Layer | Rule |
|---|---|
| Prevent | only `apply_issue_fix` writes; read-only tools never write |
| Scope | target must resolve within `root` after normalization |
| Granularity | exactly one fix per call, described by the diff |
| Freshness | content-hash guard: apply without fresh preview refuses |
| Accountability | every apply returns the diff + re-audit; CLI parity means one shared fixer |

## 4. Data flow

all tools are stateless over MCP sessions: `audit`-family calls return issues
carrying stable `id`s; `explain/preview/apply` re-resolve by id through a narrow
single-file audit (parse cache) or the symbol index. The fix-session registry
(fix hash per path) lives in `createMomusServer`'s closure, keyed by
workspace root, cleared by watcher events and on server close.

## 5. Testing

- integration harness (`test/integration/mcp.test.ts` pattern) covers all seven
  tools: happy path + refusal table for `apply_issue_fix`
  (stale-hash, path-escape, no-span).
- golden test for the unified diff formatting and the explain render.
- unit tests for dedupe grouping and per-rule explainers in `packages/core/test`.

- the write path test proves: applying a fix removes the issue on re-audit
  (delta), stale guard refuses, docs/11 details unaffected — using the project's
  own repo as the dogfood (fixture copy in /tmp, not in-tree edits).
- `doctor_status` vs the CLI `doctor` golden.

## 6. Phasing

Four independently-shippable phases, each a reviewable PR with a green gate
(typecheck, lint, format, tests, self-audit):

1. **Sight** — `explain_issue`, `get_ir` (read-only; no write surface).
2. **Sweep** — `audit_workspace` + dedupe, `doctor_status`.
3. **Fix** — `preview_issue_fix` / `apply_issue_fix` (the only write surface) +
   the stale-span guard tests.
4. **Notify** — resources + watcher notifications; degrades to doc-noted
   refresh if the SDK arithmetic fails (spike at the top of the phase).

Acceptance after 3: an agent can take `audit_test_fidelity` output and
`preview`/`apply` — and after 4: an agent react to file changes without polling.

**Risks.** (1) Issue-id stability across re-runs — mitigated by the `{path,
rule}` tuple fallback. (2) `notifications/resources/updated` SDK support —
mitigated by the phase-4 spike and the indicate refresh degrade. (3) Write-path
undo — mitigated by per-issue diffs surfaced to the agent (the agent's own
file-VCS history is the undo). (4) Narrow single-file audits re-parse only the
target file — cached, so re-resolution stays cheap.

## 7. Out of scope (explicit)

- MCP sampling, prompts, and tool results pagination.
- Agent-initiated `.momusrc` writes (config is read-only over MCP).
- New rules, parsers, or engine changes (this spec is purely tool surface;
  rule work continues under the parity spec).
- The CLI stays the source of truth for fix application — MCP shares the
  engine, it does not fork it.