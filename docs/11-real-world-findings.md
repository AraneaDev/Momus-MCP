# Momus-MCP — Real-World Validation Findings

> **Live report.** Updated as we validate Momus against two real, independent AraneaDev
> repositories plus Momus itself (dogfooding). This is the honest record of (a) what Momus
> reports about those codebases and (b) the bugs we found in Momus while doing so.
> Non-normative (see `docs/README`).

**Last updated:** 2026-08-16

## 1. Targets

| Repo | Language | Scale | Test stack | Momus config used |
|---|---|---|---|---|
| `/root/Chaos-MCP` | TypeScript (ESM, NodeNext) | 320 files, 97 test files | Vitest (`vi.*`), Stryker mutation testing | default TS |
| `/root/Knossos-MCP` | PHP ≥ 8.3 | 154 src + 221 test files | PHPUnit 12, Infection | `.momusrc` → `{languages:{php:true}}` (temp) |
| `Momus-MCP` (self) | TypeScript + PHP | 59 audited files | Vitest | `.momusrc` (fixtures excluded) |

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
| 14 | *(this round)* | PHP mocks handed to production via `new Foo($mock)`, passed as a call argument, or returned from a `willReturnCallback` closure were never marked reachable | 5 false TAUT-005 "zero-reach" on Knossos-MCP |
| 15 | *(this round)* | `productionCalls` did not count dynamic `import()` as executing production code | 1 false TAUT-004 on Chaos-MCP `sandbox.test.ts` (signal-handler re-import pattern) |
| 16 | *(dogfood)* | `synthesize_mock_contract` synthesized `{ length: 0 }` for string-literal union aliases (`Language`/`MockFramework`/`SymbolKind`) because `getPropertiesOfType` returns the primitive `String`'s intrinsic `length` | garbage mock contracts for Momus's own `ModuleIR`/`SymbolIR` |
| 17 | *(dogfood)* | inline type literals (`{ lang: Language }`) recursed through the non-checker `tsReturnExample`, so named union members emitted `undefined` | `{ lang: undefined, sev: undefined }` for a union-field return |

## 3. Findings about `/root/Chaos-MCP` (TypeScript)

Verified against source after fixes; working tree at commit `a65faae`.

- **DRIFT-006** (git-diff `HEAD~10`): 6 stale-mock warnings — `estimate-handler.test.ts` and
  `handler-container.test.ts` mock `estimateAudit`/`estimateNeedsSandbox`/`createExecutionSession`
  from `core/estimate.ts`, `estimate-handler.ts`, `utils/execution.ts`, which changed in that
  range while the test files did not. **True positives.**
- **Remaining warnings (0 errors):** MOCK-001 (4, mock-heavy unit tests — heuristic, working as
  intended: `handler-container`, `index`, `python-interpreter-memo`, `triage-discover-targets`).
- **Resolved false positives:** TAUT-005 (scope-aware hand-off, **107 → 0**), TAUT-006
  (spied-object hand-off, **5 → 0**), the TAUT-001 determinism test
  (`expect(f(x)).toBe(f(x))` — a re-evaluating call, now correctly not flagged), and TAUT-004
  (**21 → 0** — `productionCalls` now sees SUT instances assigned in `beforeEach`, traces local
  helper functions that wrap the SUT, collects `it.each`/`test.each` tests, and counts a dynamic
  `import()` as executing production code).

## 4. Findings about `/root/Knossos-MCP` (PHP)

Verified against source after fixes; working tree at commit `3ff6b0c` (now with a `vendor/` dir).

- **TAUT-001 / TAUT-003** (`tests/phpunit/Cli/CliHelpersTest.php:322,530,568`):
  `assertSame(true, true)` with the author's own `// sentinel` comments — **true positives**
  (no-op smoke assertions).
- **TAUT-005** (0 warnings, was 8 → 5 → 0): `createStub(PDO::class)` / `PDOStatement` configured
  then passed into the SUT (`new ProjectWriterLease($pdo, …)`, `new ProjectWriterLock($pdo)`)
  or returned from a `willReturnCallback` closure (`return $stmt;`). After wiring
  constructor/call/return hand-off reachability, all were correctly marked reachable.
- **Drift:** CLEAN. Mocks target `LanguageWorkerPool` (own class, resolves via PSR-4 to
  `src/Scan/LanguageWorkerPool.php`) and `PDO`/`PDOStatement` (PHP built-ins, correctly skipped).
- **`willThrowException` now recognized** as a config call (like `willReturnCallback`), which
  removed 3 of the TAUT-005 warnings (the throw-configured `$pool`/`$pdo` mocks are now marked
  reachable instead of zero-reach).
- **Remaining findings are the 6 genuine `assertSame(true, true)` sentinels** — true positives
  (the author's own `// sentinel` comments).
- **DRIFT-001 / DRIFT-003 drill-down: 0 issues** on the full corpus — the drift rules produce no
  false positives (and no true positives: Knossos genuinely has no planted drift).
- **MCP round-trip verified** against Knossos with all 5 tools, twice: once over the in-memory
  transport and once over a **real stdio subprocess** (temp `.momusrc` with PHP enabled + cache
  disabled, removed after). Both give: `listTools` → 5, `list_rules` → 14, `verify_mock_drift` →
  0, `detect_tautological_assertions` → 6 sentinels, `audit_test_fidelity` on
  `CliHelpersTest.php` → 6, `synthesize_mock_contract` on `LanguageWorkerPool.php` → correct
  `phpunit` template.
- **Sentinel decision:** the 6 `assertSame(true, true)` hits are correct true positives, not a
  Momus bug. The author uses them as no-op smoke/skip markers (`// sentinel` — `assertTrue` is
  absent from `Support/Assertions.php`). Recommendation for Knossos (not a Momus change): add
  `assertTrue` to the assertion shim, or use PHPUnit's `expectNotToPerformAssertions()` / a
  proper `markTestSkipped` for the pcntl-guard case — the current lines give false confidence.

## 4b. Self-dogfooding (Momus on Momus)

- **Full audit incl. DRIFT-000: 0 issues** on 59 files (all 23 test files + production source).
  The tool's own test suite genuinely exercises the drift/tautology rules (36 `vi.fn`, 20
  `vi.spyOn`, 6 `vi.mock`) and stays clean.
- **git-diff drift (`--base HEAD~15`): CLEAN** — no DRIFT-006 stale-mock.
- **`momus contract` on its own classes** surfaced two real synthesis bugs (fixed, rows 16–17):
  string-literal union aliases emitted `{ length: 0 }`, and inline type literals didn't recurse
  through the checker. Post-fix, `momus contract packages/core/src/audit.ts` produces a fully
  correct nested literal for `AuditResult` (`summary: { … truncated: false }`, `issues: []`,
  `indexStats: { modules: 0, symbols: 0, mocks: 0 }`).

## 5. Open / candidate improvements

1. PHP: consider recording `willThrowException`'s exception value in the IR (currently marked
   reachable only, consistent with `willReturnCallback`).
2. ✅ TS synthesis now resolves **named** interface/class returns through the type checker
   (`tsReturnExampleChecked`), so `User` / `Promise<User>` emit data-shape literals
   (`mockResolvedValue({ id: 0, … })`) instead of `undefined`. Remaining nuance: optional members
   are included with their example value (`zip?: number` → `zip: 0`), and method-only inline
   types emit `{}`.
3. MOCK-001 (over-mocking) remains a heuristic warning — it intentionally flags mock-heavy unit
   tests; tuning its threshold or production-assertion counting is a judgment call, not a bug.
4. TAUT-004's last survivor is a dynamic-`import()` + indirect signal-handler invocation
   (`(sigCall[1])()` from a spy's `.mock.calls`) — statically untraceable without full
   interprocedural analysis.
