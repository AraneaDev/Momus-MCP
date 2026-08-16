# Momus-MCP — Real-World Validation Findings

> **Live report.** Updated as we validate Momus against two real, independent AraneaDev
> repositories. This is the honest record of (a) what Momus reports about those codebases and
> (b) the bugs we found in Momus while doing so. Non-normative (see `docs/README`).

**Last updated:** 2026-08-16

## 1. Targets

| Repo | Language | Scale | Test stack | Momus config used |
|---|---|---|---|---|
| `/root/Chaos-MCP` | TypeScript (ESM, NodeNext) | 320 files, 97 test files | Vitest (`vi.*`), Stryker mutation testing | default TS |
| `/root/Knossos-MCP` | PHP ≥ 8.3 | 154 src + 221 test files | PHPUnit 12, Infection | `.momusrc` → `{languages:{php:true}}` (temp) |

## 2. Bugs found in Momus (and fixed)

| # | Commit | Bug | Symptom on real code |
|---|---|---|---|
| 1 | `33b9847` | CLI space-separated flag values leaked into positional paths | `momus audit --max-issues 50` treated `50` as a path |
| 2 | `33b9847` | DRIFT-005 checked symbol-only exports, not all named exports | false `missing-export` for `const`/`type`/`enum` exports (`TOOL_DEFINITION` etc.) |
| 3 | `33b9847` | `extractSymbols` ignored barrel re-exports | `export { X } from '...'` names treated as missing |
| 4 | `33b9847` | IR cache not invalidated by tool version | stale cached IR served after a parser change |
| 5 | `0504b57` | TS contract synthesis always emitted `undefined` | useless `mockReturnValue(undefined)` |
| 6 | `1620215` | `momus drift` (and precommit/hook) didn't recompute summary | drift-only scan printed full-audit counts + wrong `CLEAN` |
| 7 | `1620215` | TS synthesis used `mockReturnValue(Promise.resolve(...))` | wrong async semantics |
| 8 | `f08bec6` | PHP `valueText()` fell back to AST node `kind` | **50 false TAUT-001 "self-comparison" errors** on Knossos |
| 9 | *(this round)* | TS `instanceIds` was a flat name→id map, so a name reused across test scopes (`mockRun`) resolved every use to the **last** binding | 82 false TAUT-005 on Chaos-MCP `handler.test.ts` |
| 10 | *(this round)* | Chained-config initializers (`const f = vi.fn().mockReturnValue(1)`) and inline `vi.fn().mockXxx(...)` inside object/array literals were never marked reachable | more false TAUT-005 (see #9's fix — folded into the same change) |
| 11 | *(this round)* | `momus contract` on PHP reimplemented TS-only synthesis, ignoring `--framework phpunit` | emitted `satisfies Partial<...>` garbage for a PHP class |
| 12 | *(this round)* | Default `ignorePatterns` omitted `**/vendor/**` (Composer deps) | Knossos audit scanned 3,808 files incl. 3,915 vendor `.php` files (70s) instead of 403 files (8.5s) |
| 13 | *(this round)* | `productionCalls` missed a SUT assigned in `beforeEach`, local helpers wrapping the SUT, and `it.each` parameterized tests | 21 false TAUT-004 "mock-only-assertion" on Chaos-MCP |

## 3. Findings about `/root/Chaos-MCP` (TypeScript)

Verified against source after fixes; working tree at commit `a65faae`.

- **DRIFT-006** (git-diff `HEAD~10`): 6 stale-mock warnings — `estimate-handler.test.ts` and
  `handler-container.test.ts` mock `estimateAudit`/`estimateNeedsSandbox`/`createExecutionSession`
  from `core/estimate.ts`, `estimate-handler.ts`, `utils/execution.ts`, which changed in that
  range while the test files did not. **True positives.**
- **Remaining warnings (0 errors):** TAUT-004 (1, a dynamic-`import()` + indirect handler
  invocation Momus can't statically trace) + MOCK-001 (4, mock-heavy unit tests — heuristic,
  working as intended).
- **Resolved false positives:** TAUT-005 (scope-aware hand-off, **107 → 0**), TAUT-006
  (spied-object hand-off, **5 → 0**), the TAUT-001 determinism test
  (`expect(f(x)).toBe(f(x))` — a re-evaluating call, now correctly not flagged), and TAUT-004
  (**21 → 1** — `productionCalls` now sees SUT instances assigned in `beforeEach`, traces local
  helper functions that wrap the SUT, and collects `it.each`/`test.each` tests).

## 4. Findings about `/root/Knossos-MCP` (PHP)

Verified against source after fixes; working tree at commit `3ff6b0c` (now with a `vendor/` dir).

- **TAUT-001 / TAUT-003** (`tests/phpunit/Cli/CliHelpersTest.php:322,530,568`):
  `assertSame(true, true)` with the author's own `// sentinel` comments — **true positives**
  (no-op smoke assertions).
- **TAUT-005** (5 warnings, was 8): `createStub(PDO::class)` / `PDOStatement` configured then
  passed into the SUT (`ProjectWriterLease`, `ProjectWriterLock`) — conservative; the stubs are
  exercised through the SUT but the call path isn't statically visible.
- **Drift:** CLEAN. Mocks target `LanguageWorkerPool` (own class, resolves via PSR-4 to
  `src/Scan/LanguageWorkerPool.php`) and `PDO`/`PDOStatement` (PHP built-ins, correctly skipped).
- **`willThrowException` now recognized** as a config call (like `willReturnCallback`), which
  removed 3 of the TAUT-005 warnings (the throw-configured `$pool`/`$pdo` mocks are now marked
  reachable instead of zero-reach).

## 5. Open / candidate improvements

1. PHP: consider recording `willThrowException`'s exception value in the IR (currently marked
   reachable only, consistent with `willReturnCallback`).
2. TS synthesis: `mockResolvedValue({...})` object shapes for **named** interface/class returns
   (currently only inline type literals like `{ ok: boolean }` get a literal; named types still
   resolve via the checker, which syntax-only synthesis doesn't load).
3. MOCK-001 (over-mocking) remains a heuristic warning — it intentionally flags mock-heavy unit
   tests; tuning its threshold or production-assertion counting is a judgment call, not a bug.
4. TAUT-004's last survivor is a dynamic-`import()` + indirect signal-handler invocation
   (`(sigCall[1])()` from a spy's `.mock.calls`) — statically untraceable without full
   interprocedural analysis.
