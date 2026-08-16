# 3. Core Analysis Algorithms

> Normative. Defines the rule engine, every rule's precise criteria, the suppression/exemption
> language, and the false-positive policy.

## 3.1 Rule engine

Rules are pure, deterministic functions over `(SymbolIndex, ModuleIR, RuleConfig, DiffScope?)`.
They never mutate the index, never read the filesystem directly, and never depend on wall-clock
time or randomness.

```ts
// packages/core/src/rules/rule.ts
export type RuleId =
  | 'TAUT-001' | 'TAUT-002' | 'TAUT-003' | 'TAUT-004' | 'TAUT-005' | 'TAUT-006'
  | 'DRIFT-000' | 'DRIFT-001' | 'DRIFT-002' | 'DRIFT-003' | 'DRIFT-004' | 'DRIFT-005' | 'DRIFT-006'
  | 'MOCK-001' | 'MOCK-002'
  | 'SYS-001' | 'SYS-002' | 'SYS-003' | 'SYS-004' | 'SYS-005';

export type Severity = 'error' | 'warning' | 'info';

export interface Rule {
  readonly id: RuleId;
  readonly name: string;
  readonly defaultSeverity: Severity;
  readonly phase: 1 | 2 | 3 | 4;
  readonly description: string;      // ≤ 200 chars; shown in list_rules
  readonly appliesTo: (m: ModuleIR) => boolean;   // framework/language gate
  check(ctx: RuleContext): Issue[];
}

export interface RuleContext {
  index: SymbolIndex;
  module: ModuleIR;              // the test file under audit
  config: RuleConfig;            // severity + per-rule options
  diff?: DiffScope;              // present only in git-diff mode
}

export interface DiffScope {
  baseRef: string;               // git ref the diff is computed against
  changedPaths: string[];        // files changed vs baseRef
  changedSymbolIds: Set<string>; // production symbols whose defining file changed
}

export interface RuleConfig {
  severityOverrides: Partial<Record<RuleId, Severity>>;
  options: Record<string, unknown>;      // e.g. { mockSaturationThreshold: 0.7 }
}
```

**Execution contract:**

1. Rules run in a fixed order (catalog order below); issues are collected, then sorted by
   `(severityRank, file, startLine, startCol, ruleId)` — deterministic.
2. A rule that throws is a bug: the engine catches it, records `SYS-001`-style internal error
   as an `error` issue with the rule id in the message, and continues.
3. Issues carry `id = sha256(rule + span + message).slice(0, 12)` for dedupe across runs.
4. Suppression filtering happens **after** all rules run, in one pass (§3.5).

## 3.2 Data-flow analysis (shared substrate)

Tautology rules need provenance: *where did the value in this assertion come from?* Momus
implements a small, conservative, **intra-procedural** value-flow pass per test function:

- **Definitions tracked:** variable assignments, `const` declarations, destructuring,
  function parameter bindings, `await` results, mock configuration calls
  (`mockReturnValue(x)` registers `x` as flowing from `mock-config`), and `vi.fn(impl)` bodies.
- **Forwarding:** `const a = b` ⇒ `a` inherits `b`'s provenance; `service.method()` ⇒
  provenance `production` when the callee resolves to a production symbol, `mock-call` when it
  resolves to a mock, `mock-config` when the callee is a mock and the specific invocation is
  provably the one configured (same member, no `Once` semantics outstanding).
- **Taint stops (conservative):** calls to non-resolvable functions, array/object mutation
  through indices, closures capturing loop variables, and any control flow that merges
  `mock-config` with `production` (union ⇒ `production`). When provenance is ambiguous, the
  conservative choice is *no finding* (false-negative over false-positive).

> Example: `mock.getTotal.mockReturnValue(42); expect(mock.getTotal()).toBe(42);` —
> `mock.getTotal()` resolves to a mock call whose `ConfiguredValueIR` is `42`; the RHS `42`
> is a literal equal to the configured value ⇒ `TAUT-002` fires. If the RHS were
> `service.computeTotal()` (production), no finding — correct.

## 3.3 Rule catalog

### 3.3.1 Tautological assertions (`TAUT-*`)

| ID | Name | Severity | Criteria (all must hold) |
|---|---|---|---|
| TAUT-001 | `self-comparison` | error | Assertion compares an expression with itself syntactically (`expect(a).toBe(a)`, `assertSame($x, $x)`). **Re-evaluating expressions are exempt:** a `call` or `new` operand re-executes on each side, so `expect(f(x)).toBe(f(x))` is a legitimate determinism check, not a tautology. |
| TAUT-002 | `mock-echo` | error | One operand's provenance is `mock-config` **and** the other operand is the exact configured value (`literal` equality, or same identifier bound to the configured value), **and** no production symbol appears in either operand. |
| TAUT-003 | `constant-tautology` | error | Both operands are `constant` with no mock and no production involvement (`expect(true).toBe(true)`, `expect(2+2).toBe(4)`). Excluded: `expect(null).toBeNull()` style matcher APIs that are themselves meaningful (see API allowlist). |
| TAUT-004 | `mock-only-assertion` | warning | **Every** operand of the assertion has provenance exclusively in `mock-config`/`mock-call`, **and** the test function contains **zero** calls resolving to production symbols. I.e., the test exercises nothing real. |
| TAUT-005 | `zero-reach-stub` | warning | A `MockIR` is configured (`configuredValues.length > 0`) or asserted upon, but `invocationSites` is empty **and** no assertion operand references it. The stub is decorative. |
| TAUT-006 | `unconfigured-spy-assert` | warning | Assertion uses `toHaveBeenCalled*`/`assertCalled` on a spy with **no** `ConfiguredValueIR` and **no** production call path: the only thing the assertion can prove is that the spy exists. |

**Assertion API allowlist for TAUT-003** (matcher calls that *can* be meaningful with constant
operands, excluded from `constant-tautology`): `toBeNull`, `toBeUndefined`, `toBeTruthy`,
`toBeFalsy`, `toBeInstanceOf`, `toHaveLength`, `assertNull`, `assertNotNull`, `assertInstanceOf`,
`assertCount`, `assertEmpty`, `assertNotEmpty`. The allowlist is config (`options.constantApiAllowlist`).

**Zero-reach nuance:** `invocationSites` includes call sites anywhere in the test file — a
stub used by a helper called from the test still counts as reachable. Only statically
unreachable stubs fire.

### 3.3.2 Mock contract & drift verification (`DRIFT-*`)

| ID | Name | Severity | Criteria |
|---|---|---|---|
| DRIFT-000 | `unresolvable-mock-target` | info | Mock target could not be resolved to a production symbol (missing module, untyped `any`, dynamic target). Records the span; enables downstream rules to skip silently. Not a violation per se. |
| DRIFT-001 | `missing-member` | error | A `StubbedMemberIR.name` (spyOn member, `shouldReceive`, factory key, object-literal key, `onlyMethods` entry) does not exist on the resolved target class/interface/module exports. Also fires when the target symbol exists but the member was **removed** in the current workspace version. |
| DRIFT-002 | `signature-mismatch` | warning | Stub's declared call signature diverges from production: (a) stub declares **more required parameters** than production; (b) in type-aware mode, parameter types are not assignable (mock param must accept everything production accepts); (c) `shouldReceive('m', args)` where args exceed production arity. **Escape hatches** (no finding): stub uses `...args`, `any`/`mixed`, `*` matcher, or production member itself is `unknown`/untyped. |
| DRIFT-003 | `return-type-mismatch` | warning | A configured value's static shape is **not assignable** to the production return type. Assignability is structural, per §3.4. `any`/`unknown`/`mixed` on either side ⇒ no finding. `mockImplementation`/`willReturnCallback` bodies are type-checked via their declared signature when present; otherwise skipped with `info`. |
| DRIFT-004 | `constructor-drift` | error | For `createMock(Foo::class)`-family and `new Foo(...)` double constructions: a **required** production constructor parameter has no corresponding argument **and** no default, when the constructor is statically known. (PHPUnit mocks bypass constructors — see exemption §3.5.3.) |
| DRIFT-005 | `missing-export` | error | `vi.mock('mod', factory)` / `jest.mock` factory keys (top-level) reference exports that don't exist on the resolved module; or the real module exports a name the factory omits while the test imports that name from the mocked module. Exports are matched against the module's **full named-export list** — including `const`/`type`/`enum` declarations and barrel re-exports (`export { X } from '…'` / `export * as ns from '…'`), not just class/function symbols. |
| DRIFT-006 | `stale-mock` | warning | **git-diff mode only.** The mocked target's defining file is in `changedSymbolIds` but the mock's file is **not** in `changedPaths` — the mock is a candidate for drift review. Message includes which production members changed. Implemented (Step 4): fires when the target changed and the mock file was untouched; the message lists the target class and its members. |

**DRIFT-001 object-literal nuance:** for `object-literal` mocks (`{ save: vi.fn() } as unknown as T`),
only keys whose values are mocks or functions are checked; plain data keys are treated as
fixture data and exempt (configurable: `options.checkObjectLiteralDataKeys`, default false).

### 3.3.3 Mock hygiene (`MOCK-*`)

| ID | Name | Severity | Criteria |
|---|---|---|---|
| MOCK-001 | `mock-saturation` | warning | In a test file, `mockedDeps / totalDeps ≥ threshold` (default 0.7, configurable) **and** fewer than 2 assertion operands have `production` provenance. Over-mocking heuristic — intentionally conservative, fires only at extreme saturation. |
| MOCK-002 | `mock-of-self` | info | The test file mocks a module that it also imports and exercises as the SUT (e.g. `vi.mock('../src/index')` in `index.test.ts` that imports `../src/index`), i.e. the subject itself is stubbed — the strongest form of over-mocking. |

### 3.3.4 Rule→phase matrix

| Phase | Rules shipped |
|---|---|
| 1 | TAUT-001…006, DRIFT-000…005, MOCK-001, MOCK-002 (TS/Vitest+Jest) |
| 2 | Same rules for PHP (PHPUnit/Pest), DRIFT-004 constructor-awareness, anonymous-class handling |
| 3 | ✅ DRIFT-006 (git integration shipped: `gitChangedPaths` + `DiffScope`), `momus precommit`, `hook`, `annotate-pr`, `annotate` (JSONL), `serve --transport http`, `audit --fix` mechanism + DRIFT-001 rename fix. TAUT-001/002/003 are semantic tautologies — **no auto-fix** (any rewrite would invent the asserted value); they carry descriptive suggestions only (§3.6) |
| 4 | (no new rules; distribution) |

## 3.4 Structural assignability (DRIFT-003)

Comparisons are directional: **configured-value-shape → production-return-type**.

| Production type | Configured value | Verdict |
|---|---|---|
| `unknown` / `any` / `mixed` / absent | anything | no finding (escape hatch) |
| `void` | anything non-void | finding |
| `named` (resolved) | `named` same resolvedId | pass; recurse into `typeArgs` positionally |
| `named` (resolved) | object literal shape | **structural subset check**: every production public member must be present in the literal with an assignable value type; extra keys allowed. Uses the resolved symbol's members; unresolvable members ⇒ pass (conservative). |
| `union` | any member | configured type must be assignable to **at least one** union member |
| `union` | object literal | every production union member that is a named type gets the structural subset check; pass if any passes |
| `array<T>` | array literal / `array<T'>` | element assignability `T'` → `T`; empty array literal passes |
| `tuple` | array literal | length must be ≤ tuple length; positional assignability; `...rest` production tuple passes any length |
| `literal` L | literal L' | pass iff `L' === L` |
| `null`/`undefined` | `null`/`undefined` | pass |
| `function` | `vi.fn()` with no impl | pass (deferral); with impl, param/return assignability per §3.3.2 |
| `named` (unresolved, syntax-only mode) | anything | **no finding**; `SYS-003` note emitted once per file |

**Precision guards:**

- **Async methods:** production return `Promise<T>` is unwrapped with
  `checker.getPromisedTypeOfPromise` before comparison — configured stub shapes are checked
  against `T`, not `Promise<T>` (validated, `09-validation-report.md` F7).
- `expect.objectContaining({...})` arguments are analyzed as object literal shapes (partial
  match semantics: missing production members are allowed — the matcher is partial by design).
- `mockResolvedValue(x)` compares `x` against the production **return type of the async method**
  (the promise's resolved type), not `Promise<T>`.
- PHP `willReturn($x)` where `$x` is an unresolvable variable ⇒ no finding (conservative).

## 3.5 Suppression & exemption semantics

Suppression is **explicit, scoped, and auditable**. It never hides `error`-severity *system*
diagnostics (SYS-*). Forms, in precedence order (highest first):

### 3.5.1 Inline comments (highest)

| Form | Scope | Example |
|---|---|---|
| `// @momus-ignore` | the **next line** (or the line it trails, if trailing) | `// @momus-ignore`<br>`mock.getTotal.mockReturnValue(42);` |
| `// @momus-ignore:TAUT-002` | next line, rule-scoped | `expect(mock.f()).toBe(42); // @momus-ignore:TAUT-002` |
| `// @momus-ignore:TAUT-002,DRIFT-003` | next line, multiple rules | — |
| `/** @momus-ignore */` (docblock) | the enclosing test function/class | — |
| `// @momus-ignore-file` | entire file | must appear in the first 10 lines |

**Syntax (strict regex):**
```
^//\s*@momus-ignore(?::(?<rules>[A-Z0-9-]+(?:,[A-Z0-9-]+)*))?$      // line comment
^/\*\*\s*@momus-ignore\s*\*/$                                        // docblock
^//\s*@momus-ignore-file$                                            // file banner
```

- Unknown rule ids in scoped forms are **configuration errors** (`SYS-005`), reported loudly —
  a typo must never silently disable analysis.
- Suppressed spans are reported (not hidden) when `momus rules --show-suppressed` is used or
  when `report.suppressed` is requested via tool argument (`includeSuppressed: true`).

### 3.5.2 Config suppressions (middle)

`.momusrc` `suppressions[]` entries (see §2.6) — file-glob scoped, optionally rule-scoped.
Precedence below inline comments, above severity config.

### 3.5.3 Built-in exemptions (lowest)

- **PHPUnit `createMock`/`createStub`** bypass constructors by framework design ⇒ DRIFT-004
  does not apply to them (only to `new Foo(...)` doubles and `getMockBuilder` with
  `enableOriginalConstructor`-style options).
- `expect.any(T)`, `expect.objectContaining`, `Mockery::any()`, `*` matchers are exempt from
  DRIFT-002 arity checks by definition.
- `// istanbul ignore` / `@codeCoverageIgnore`-adjacent comments do **not** suppress Momus —
  only `@momus-ignore` does. No silent cross-tool coupling.

### 3.5.4 Suppression reporting

Every suppressed finding is recorded with `(rule, span, reason?)` and appears in the JSON
report under `result.suppressed` when requested. The CLI prints a one-line summary:
`3 findings suppressed (TAUT-002 ×2, MOCK-001 ×1)`.

## 3.6 False-positive mitigation policy

1. **Clean-corpus gate:** every PR that adds or changes a rule must run the rule against the
   clean corpus (`test/fixtures/clean/**`). Any finding ⇒ PR blocked.
2. **Conservatism hierarchy:** when in doubt, a rule must *not* fire. `info` is the ceiling for
   heuristics (MOCK-*); `error` is reserved for criteria that are syntactically provable
   (TAUT-001/002/003, DRIFT-001/004/005).
3. **Escape hatches are documented per rule** (§3.3 tables) and are part of the rule's contract.
4. **Severity overrides** are per-rule, per-workspace via `.momusrc` — never per-finding
   heuristics.
5. **Golden regression:** the anti-pattern gallery (`test/fixtures/gallery/**`) pins exact
   expected output (file, line, rule, message) so behavior changes are reviewable diffs.
6. **Auto-fix conservatism:** a rule emits a mechanically-applicable `fix.code` only when the
   rewrite is unambiguous (e.g. DRIFT-001's unique near-match rename). Semantic tautologies
   (TAUT-001/002/003) have no safe rewrite — any fix would invent the asserted value — so they
   emit descriptive suggestions (`description` set, `code` empty) and are excluded from
   `momus audit --fix`.

## 3.7 Known limitations (honest bounds)

- **No cross-test data flow:** mocks configured in `beforeEach`/`beforeAll` are linked to
  module-level or enclosing `describe` scopes when statically obvious, with lifecycle ordering
  preserved; dynamic setup control flow remains conservative. Ambiguity ⇒ no finding.
- **No runtime values:** `mockReturnValue(factory())` where `factory` is a function call is
  `unknown`-provenance; TAUT-002 won't fire even if `factory()` returns a constant.
- **No PHP runtime types:** PHP is checked structurally against declared types only;
  docblock `@return` annotations are parsed when present (glayzzle comment AST) and otherwise
  ignored.
- **Jest automocks** (`jest.mock('x')` with no factory) cannot be member-checked — DRIFT-001
  is skipped with DRIFT-000 `info`.
- **Dynamic mocking** (`vi.mock(variablePath)`) is out of scope; DRIFT-000 `info` only.

---

**Next:** [`04-mcp-tool-definitions.md`](./04-mcp-tool-definitions.md) — the MCP tool surface.
