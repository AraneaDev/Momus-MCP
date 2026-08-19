# Agent tool surface — design

**Date:** 2026-08-18 · **Revised:** 2026-08-19 · **Status:** approved for planning ·
**Branch:** `feat/agent-tool-surface`

> **Revision note (2026-08-19).** The spec was written against the tree at v0.0.7 and
> re-verified against v0.0.8 before implementation. Three corrections, marked **[revised]**
> below: phase 3 gains a prerequisite (§1.2), phase 4's SDK risk is resolved (§2), and a
> documentation defect it surfaced is recorded (§2). Everything else was checked and still
> holds: the server registers exactly the five tools listed, and every fixer function named
> in §1.2/§1.3 exists as described.
>
> **Phase-1 implementation notes (2026-08-19).** Two further gaps surfaced while building
> `explain_issue` and `get_ir`, both recorded inline: the `tools/list` size budget could not
> hold the planned surface (§1.0), and `issueId` is not reachable over MCP (§1.1).

### 1.0 The `tools/list` budget had to move first **[revised]**

`docs/02` §2.7 capped the serialized `tools/list` payload at **< 4 KB**. The five pre-existing
tools measured **4080 B** — 99.6% of it — so any sixth tool broke the budget no matter how lean
it was, and six new tools could not fit at any plausible density (the five range 437–972 B
each). A narrow-tool design and a 4 KB cap are not compatible.

The cap is now **< 12 KB total and < 1 KB per tool**. The per-tool half carries the intent the
original figure was protecting — no single tool may bloat — and unlike a total it does not need
revisiting every time a tool is added. Both are asserted in `test/integration/mcp.test.ts`.
After phase 1 the surface is seven tools / 5600 B.

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

> **[revised] `issueId` is not reachable over MCP, so the tuple is the primary key.**
> `Issue.id` exists in core (`rule:file:line:col:message-slice`) but `buildJsonEnvelope` never
> projects it — every MCP result carries `rule`, `file`, `line`, `column`, `message`, never
> `id`. An agent therefore cannot obtain an `issueId` to pass back. The shipped input is
> `{path, rule, line?}`: `line` disambiguates a rule that fired more than once (Argos-MCP had
> 15 `TAUT-006` in one file), and it is no less stable than the id, which embeds line and
> column anyway. Exposing `id` in the envelope stays open as a separate change — it would
> re-golden every tool's output — and is not needed for phases 1–3.

Resolve one issue to a root-cause chain. Input: `path` (workspace-relative test
file) + `rule` + optional `line`. The server re-runs a narrow
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

> **[revised] Prerequisite: the fixer must move to `@momus/core` first.** The pipeline lives
> in `packages/cli/src/fix.ts`, and `@momus/cli` already depends on `@momus/mcp-server`
> (it imports `serve`). Having the server import the CLI closes a package-level cycle —
> tolerable under npm workspaces' symlinks and tsx resolution, but a cycle in the published
> dependency graph, which this repo cannot ship. `collectFixable`, `editsByFile`,
> `applyFixes`, `buildFixDiff`, `unifiedDiff` and `applyFixToFiles` therefore move to
> `@momus/core` (which both packages already depend on) with `packages/cli/src/fix.ts`
> re-exporting them, so the CLI's imports and tests are untouched. This is a pure move, not a
> rewrite, and it is the first commit of phase 3 — it does **not** widen §7's "no engine
> changes" (no rule, parser, or engine behaviour changes), but it does mean phase 3 touches
> `@momus/core`.

Input: `path` + `issueId`. Re-runs the narrow audit, resolves the issue's
`FixSuggestion` via the shared `collectFixable`/`editsByFile`/`buildFixDiff` pipeline
(one fixer, used by both the CLI and MCP), and returns the unified diff
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
(`mocks`, `symbols`, `assertions`, `all`; **[revised]** `invocations` is not a separate slice —
`invocationSites` ship inside each mock, which is where the reachability question is asked). Returns the parser IR for the
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
`momus://issues/latest`. Agents that hold subscribed resources refresh on the
notification; agents that don't use the read tool.

> **[revised] The phase-4 spike is already answered: the SDK supports this.**
> `@modelcontextprotocol/sdk` 1.30.0 exposes `Server.sendResourceUpdated(params)` and
> `McpServer.registerResource`, so the degrade path (doc-noted manual refresh) is a fallback
> for older SDKs, not the expected outcome. Phase 4 keeps the graceful-degrade wording in the
> tool descriptions but no longer needs a spike to start.

> **[revised] Capability declaration is a real gap, not just a new feature.** `docs/04` §4.1
> documents the server as advertising `"resources": { "subscribe": false, "listChanged": false }`,
> but `createMomusServer` declares only `{ tools: { listChanged: true } }`. The documented
> capability set is therefore wrong *today*, independent of this spec. Phase 4 adds the real
> declaration (with `subscribe: true`, which the notification channel requires) and corrects
> `docs/04` in the same commit.

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

1. **Sight** — `explain_issue`, `get_ir` (read-only; no write surface). **Shipped** —
   the `DRIFT-*` real-dependency snippet moved to phase 2, where the symbol index is already
   loaded for `audit_workspace`.
2. **Sweep** — `audit_workspace` + dedupe, `doctor_status`. **Shipped**, including the
   `DRIFT-*` real-dependency snippet deferred from phase 1. **[revised]** Phase 2 needed the
   same package-cycle fix phase 3 was scheduled to make: the `doctor` project-signal readers
   lived in `@momus/cli`, so `@momus/core` gained `projectSignals.ts` and the CLI re-exports
   from it. The pattern is now established for the phase-3 `fix.ts` move. The dependency
   snippet needed no index plumbing after all — `target.symbolId` is
   `<production file>#<Symbol>`, so a second cache-backed single-file parse answers it.
3. **Fix** — the `fix.ts` move to `@momus/core` (§1.2, first commit, no behaviour
   change), then `preview_issue_fix` / `apply_issue_fix` (the only write surface) +
   the stale-span guard tests. **Shipped.** **[revised]** The freshness guard is a
   `contentHash` the agent carries from preview to apply, and it is a *required* input —
   optional, it would let an agent skip preview and apply blind, which is not the two-phase
   design decision §0.2 locked. One further step the spec did not have: the type-aware TS
   program is cached per workspace, so an apply must call `invalidateProgramCache()` before
   re-auditing or the re-audit re-reports the finding it just fixed.
4. **Notify** — resources + watcher notifications + the corrected capability
   declaration and `docs/04` fix (§2); degrades to doc-noted refresh on SDKs
   older than 1.30. **Shipped.** **[revised]** Two things the spec did not have: the SDK's
   `McpServer` declares the resources capability but does not answer `resources/subscribe`
   itself, so those handlers are registered explicitly (without them a subscribe returns
   "Method not found" and no notification ever arrives); and the watcher is now **owned by the
   server** rather than started beside it — `momus serve --watch` previously started a
   detached `watchWorkspace` that invalidated the `ts.Program` cache but could not notify
   anyone. Watching is opt-in (`watch: true`), because a watcher is a real fs handle and a
   caller that only makes tool calls should not pay for one.

Acceptance after 3: an agent can take `audit_test_fidelity` output and
`preview`/`apply` — and after 4: an agent react to file changes without polling.

**Risks.** (1) Issue-id stability across re-runs — the id is
`rule:file:line:col:message-slice`, so it moves the moment a fix shifts line numbers, which
is exactly when `apply_issue_fix` re-audits. Mitigated by the `{path, rule}` tuple fallback,
and `apply_issue_fix` returns the re-audited issue list so the agent re-reads ids rather than
carrying stale ones. (2) ~~`notifications/resources/updated` SDK support~~ — **[revised]**
resolved: SDK 1.30.0 ships `sendResourceUpdated`. (3) Write-path undo — mitigated by
per-issue diffs surfaced to the agent (the agent's own file-VCS history is the undo).
(4) Narrow single-file audits re-parse only the target file — cached, so re-resolution stays
cheap. (5) **[revised]** Phase 3 now touches `@momus/core`; the mitigation is that the move
is mechanical and the CLI's existing `fix` tests re-run against the re-export unchanged.

## 7. Out of scope (explicit)

- MCP sampling, prompts, and tool results pagination.
- Agent-initiated `.momusrc` writes (config is read-only over MCP).
- New rules, parsers, or engine behaviour changes (this spec is purely tool surface;
  rule work continues under the parity spec). **[revised]** The phase-3 `fix.ts` move into
  `@momus/core` is a file move plus a re-export, not a behaviour change, and is in scope.
- The CLI stays the source of truth for fix application — MCP shares the
  engine, it does not fork it.