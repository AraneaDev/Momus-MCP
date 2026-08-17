# Four-Language Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring TypeScript, PHP, Python, and Rust to the same capability level — same rule coverage (where the concept is meaningful), same type depth, same contract-synthesis tool surface, and a truthful shipped catalog.

**Architecture:** Five independently-shippable phases. Phase 1 fixes catalog/watcher/ignore consistency. Phase 2 fixes Rust mock reachability (wrapper re-bindings + by-value consumption). Phase 3 ports TAUT-006/DRIFT-005/MOCK-002 across languages via the existing `ModuleIR`/`MockIR` seam (rules stay IR-only). Phase 4 integrates pyright into `@momus/parser-python` so DRIFT-002/003 fire on unannotated code. Phase 5 extends `synthesize_mock_contract` to pytest/unittest and mockall/mockito/wiremock.

**Tech Stack:** TypeScript (Node ≥ 20), vitest, tree-sitter-python, syn→wasm32 (parser-rust), pyright, `@modelcontextprotocol/sdk`.

**Spec:** `docs/superpowers/specs/2026-08-17-four-language-parity-design.md` — the plan argues from the spec, so the spec travels with it; executors read both.

## Global Constraints

- **Zero runtime dependencies in `@momus/core`** — the engine stays pure TypeScript; pyright lives only in `@momus/parser-python`.
- **Rules stay IR-only** — every ported rule reads `ModuleIR`/`MockIR`; parsers emit the fields rules filter on.
- **Gate:** `npm run typecheck` (0 errors), `npm test` (all green), `npm run lint`, `npm run format:check`, `npm run audit-self` (CLEAN) must pass after every task.
- **Commits:** conventional-commit message, **no Codebuff footer** (the `commit-msg` hook + `commit-hygiene` CI reject it).
- **Branch discipline:** `main` is protected — each phase is committed on the `feat/language-parity` branch (this repo's convention: one feature branch per spec) and PR'd before merge.
- **IR schema:** any `ModuleIR` shape change or parser-extraction change bumps `IR_SCHEMA_VERSION` in `packages/core/src/ir.ts` (currently `'5'`).
- **TDD:** every task writes the failing test first, runs it to confirm it fails, implements, then confirms green.

---

### Task 1: Single shared rule catalog

**Files:**
- Create: `packages/core/src/catalog.ts`
- Modify: `packages/core/src/index.ts` (add `export * from './catalog.ts';`)
- Modify: `packages/cli/src/catalog.ts` (replace the 12-entry list with a re-export)
- Modify: `packages/server/src/index.ts` (replace the inline `RULE_LIST` with the core import)
- Test: `packages/core/test/catalog.test.ts` (new)

**Interfaces:**
- Produces: `export const RULES_CATALOG: ReadonlyArray<{ id: RuleId; name: string; severity: Severity; description: string }>` in `@momus/core`, with exactly **14** entries — TAUT-001…006, DRIFT-001…006, MOCK-001, MOCK-002 (same order, names, severities, descriptions as the current server `RULE_LIST`).

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/catalog.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { RULES_CATALOG } from '../src/catalog.js';

describe('RULES_CATALOG', () => {
  it('lists all 14 rules including DRIFT-004 and DRIFT-006', () => {
    const ids = RULES_CATALOG.map((r) => r.id);
    expect(ids).toHaveLength(14);
    expect(ids).toContain('DRIFT-004');
    expect(ids).toContain('DRIFT-006');
    // severities match the normative catalog
    expect(RULES_CATALOG.find((r) => r.id === 'DRIFT-004')?.severity).toBe('error');
    expect(RULES_CATALOG.find((r) => r.id === 'DRIFT-006')?.severity).toBe('warning');
  });
});
```

- [ ] **Step 2: Run it, confirm FAIL** — `npx vitest run packages/core/test/catalog.test.ts` → fails (`Cannot find module '../src/catalog.js'`).

- [ ] **Step 3: Implement the catalog**

Create `packages/core/src/catalog.ts` — copy the 14-entry `RULE_LIST` verbatim from `packages/server/src/index.ts` (the server list is the complete one) as `RULES_CATALOG`. It imports `RuleId`/`Severity` types from `./ir.ts`.

- [ ] **Step 4: Wire consumers**

- `packages/core/src/index.ts`: add `export * from './catalog.ts';`.
- `packages/cli/src/catalog.ts`: replace the whole file with `export { RULES_CATALOG } from '@momus/core';`.
- `packages/server/src/index.ts`: delete the inline `RULE_LIST` const and its `import type` if now unused; add `RULES_CATALOG` to the existing `@momus/core` import; change `RULE_LIST.map(...)` in the `list_rules` handler to `RULES_CATALOG.map(...)`.

- [ ] **Step 5: Add a parity regression test** in `packages/cli/test/index.test.ts`: run `runRules` (or invoke `momus rules`) and assert its output contains `DRIFT-004` and `DRIFT-006` (14 lines), matching `RULES_CATALOG`.

- [ ] **Step 6: Run the gate** — `npm run typecheck`, `npx vitest run packages/core/test/catalog.test.ts packages/cli/test`, `npm run lint`, `npm run format:check`.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/catalog.ts packages/core/src/index.ts packages/cli/src/catalog.ts packages/server/src/index.ts packages/core/test/catalog.test.ts packages/cli/test/index.test.ts
git commit -m "refactor: single shared rule catalog (CLI + MCP, 14 rules)"
```

---

### Task 2: Watcher + default ignores for Python/Rust

**Files:**
- Modify: `packages/server/src/index.ts` (`SOURCE_RE`, `watchWorkspace` ignored list)
- Modify: `packages/core/src/config.ts` (`DEFAULT_CONFIG.ignorePatterns`)
- Test: `packages/core/test/config.test.ts` (new or extend), `packages/server/test/*` (extend)

**Interfaces:**
- Produces: `SOURCE_RE = /\.(ts|tsx|js|jsx|mts|cts|mjs|php|py|rs)$/i`; `watchWorkspace` ignores `.venv`, `venv`, `__pycache__`, `target`; `DEFAULT_CONFIG.ignorePatterns` gains `**/__pycache__/**`, `**/.venv/**`, `**/target/**`.

- [ ] **Step 1: Write the failing test**

In `packages/core/test/config.test.ts` (create if absent):

```ts
import { expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';

it('default ignores exclude Python/Rust build + venv dirs', () => {
  for (const p of ['**/__pycache__/**', '**/.venv/**', '**/target/**']) {
    expect(DEFAULT_CONFIG.ignorePatterns).toContain(p);
  }
});
```

- [ ] **Step 2: Run, confirm FAIL** — the three patterns are absent.

- [ ] **Step 3: Implement**

- `packages/core/src/config.ts` `DEFAULT_CONFIG.ignorePatterns`: append the three patterns.
- `packages/server/src/index.ts`: change `SOURCE_RE` to include `rs`; extend the `watchWorkspace` `ignored` array with `/(^|[\\/])\.venv[\\/]/`, `/(^|[\\/])venv[\\/]/`, `/(^|[\\/])__pycache__[\\/]/`, `/(^|[\\/])target[\\/]/`.

- [ ] **Step 4: Add a server watcher test** (in the existing `packages/server/test/` watcher test) asserting a `.rs` add fires `onChange` and a `.venv/` path does not.

- [ ] **Step 5: Gate + commit**

```bash
git add packages/server/src/index.ts packages/core/src/config.ts packages/core/test/config.test.ts packages/server/test
git commit -m "fix: include rs in watcher and ignore Python/Rust build dirs"
```

---

### Task 3: Rust reachability — wrapper re-bindings + by-value consumption

**Files:**
- Modify: `packages/parser-rust/src/mocks.ts` (`walkExpr` + a new `resolveMockRef` helper)
- Test: `packages/parser-rust/test/mocks.test.ts` (extend)

**Interfaces:**
- Produces: within `extractMocks`, a mock's `invocationSites` now also gains entries when (a) its variable is re-bound through `Box::new`/`Arc::new`/`Rc::new`/`Pin::new` and then method-called, or (b) the mock/alias is passed by value to any call. `RustExpr` fields used: `kind`, `callee.text`, `receiver`, `args`, `method`, `binding`, `text`.

- [ ] **Step 1: Write the failing tests** (append to `packages/parser-rust/test/mocks.test.ts`)

```ts
it('marks a Box re-bound mock reached when invoked on the alias', () => {
  const file = parseRust(
    `#[test]
    fn t() {
      let mock = MockRepo::new();
      mock.expect_fetch().returning(|| 1);
      let boxed: Box<dyn Repo> = Box::new(mock);
      assert_eq!(1, boxed.fetch());
    }`,
  );
  const mocks = extractMocks(file, '/c/src/t.rs');
  expect(mocks[0]!.invocationSites.length).toBeGreaterThan(0);
});

it('marks a mock reached when consumed by value', () => {
  const file = parseRust(
    `#[test]
    fn t() {
      let mock = MockRepo::new();
      mock.expect_fetch().returning(|| 1);
      block_on(mock);
    }`,
  );
  const mocks = extractMocks(file, '/c/src/t.rs');
  expect(mocks[0]!.invocationSites.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run, confirm FAIL** — `invocationSites` is empty for both (current code only records direct `m.foo()` calls on the bound variable).

- [ ] **Step 3: Implement**

In `packages/parser-rust/src/mocks.ts`, add a helper that resolves any expression to the mock that flows into it:

```ts
const WRAPPERS = new Set(['Box::new', 'Arc::new', 'Rc::new', 'Pin::new']);

/** The mock a path/wrapper-call/argument flows from, or undefined. */
function resolveMockRef(e: RustExpr | undefined, bindings: Map<string, MockIR>): MockIR | undefined {
  if (!e) return undefined;
  if (e.kind === 'path') return bindings.get(e.text);
  if (e.kind === 'call' && e.callee?.text && WRAPPERS.has(e.callee.text)) {
    return resolveMockRef(e.args?.[0], bindings);
  }
  return undefined;
}
```

Then in `walkExpr`, after the existing `MockFoo::new()` and method-call handling, add two branches (inside the `if (e.kind === 'call' …)` and `if (e.kind === 'method-call')` blocks, before the recursive walk):

1. **Re-binding:** when `e.kind === 'call'`, `e.callee?.text` is in `WRAPPERS`, `resolveMockRef(e.args?.[0], bindings)` returns a mock, and `e.binding` is set → `bindings.set(e.binding, thatMock)` (a nested `Pin::new(Box::new(mock))` re-binds the outer binding to the inner mock).
2. **By-value consumption:** for any `call` or `method-call`, for each arg `a` of `e.args`, if `resolveMockRef(a, bindings)` returns a mock, push `spanOf(path, e.span)` into that mock's `invocationSites` (deduped by line+column as elsewhere). Also apply the same to the *receiver* of a method-call when it is a wrapper call (`Arc::new(mock).bean()`).

- [ ] **Step 4: Run, confirm PASS** — `npx vitest run packages/parser-rust/test/mocks.test.ts`.

- [ ] **Step 5: Re-dogfood mockall**

```bash
cd /tmp/mockall-dogfood && rm -rf .momus && cat > .momusrc <<'EOF'
{ "languages": { "rust": true } }
EOF
cd /root/Momus-MCP && npx tsx packages/cli/src/index.ts audit --root /tmp/mockall-dogfood --json > /tmp/mockall-t3.json
node -e "const r=require('/tmp/mockall-t3.json').result; console.log(r.summary);"
```

Expected: warnings drop from 16 toward 12 (the 4 `mock_cfg.rs` cfg-gated compile-only tests remain, genuinely zero-reach).

- [ ] **Step 6: Gate + commit**

```bash
git add packages/parser-rust/src/mocks.ts packages/parser-rust/test/mocks.test.ts
git commit -m "feat(parser-rust): trace wrapper re-bindings and by-value mock consumption"
```

---

### Task 4: MOCK-002 subject derivation across languages

**Files:**
- Modify: `packages/core/src/rules/hygiene.ts` (`Mock002MockOfSelf` — replace the TS-only `testSubject` with a per-language derivation)
- Test: `packages/core/test/rules.test.ts` (or the hygiene rule test) — extend

**Interfaces:**
- Produces: `function testSubject(module: ModuleIR): string | undefined` (module-scoped, exported for tests) deriving the subject by language: TS `foo.test.ts`→`foo`; Python `test_foo.py`→`foo` / `foo_test.py`→`foo`; PHP `FooTest.php`→`Foo`; Rust: the module name of the enclosing `mod` for a `#[cfg(test)]` path (see Step 3).

- [ ] **Step 1: Write the failing test**

In `packages/core/test/rules.test.ts` (the hygiene rule describe block), add:

```ts
it('derives the mock-of-self subject per language', () => {
  expect(testSubject({ language: 'typescript', path: '/x/ledger.test.ts' } as ModuleIR)).toBe('ledger');
  expect(testSubject({ language: 'python', path: '/x/test_ledger.py' } as ModuleIR)).toBe('ledger');
  expect(testSubject({ language: 'python', path: '/x/ledger_test.py' } as ModuleIR)).toBe('ledger');
  expect(testSubject({ language: 'php', path: '/x/LedgerTest.php' } as ModuleIR)).toBe('Ledger');
});
```

- [ ] **Step 2: Run, confirm FAIL** — `testSubject` is not exported and only handles the TS regex.

- [ ] **Step 3: Implement**

In `packages/core/src/rules/hygiene.ts`, export `function testSubject(module: ModuleIR): string | undefined` and branch on `module.language`:

- `typescript`: existing regex on `module.path` basename (`(.+?)\.(test|spec)\.[cm]?[jt]sx?$` → group 1).
- `python`: `^test_(.+)\.py$` → `$1`; else `^(.+)_test\.py$` → `$1`.
- `php`: `^(.+)Test\.php$` → `$1`.
- `rust`: return `undefined` (Rust uses the symbol-name signal below, not a filename).

Then widen `Mock002MockOfSelf.check` to fire in two cases (keep the existing TS module-path branch byte-identical):

1. **Filename case (TS/Python/PHP):** existing `module`-target check, but use `testSubject(module)` instead of the TS-only regex. For Python/PHP also fire when a *class*-target mock's target `exportName` (case-insensitively, `Ledger` vs `ledger`) equals the subject — `patch.object(Ledger, …)` in `test_ledger.py`, or `LedgerTest.php` mocking `Ledger`.
2. **Rust case:** fire when `module.language === 'rust'` and a mock's `target.exportName` equals the name of a `class`/`interface` symbol declared in the *same file* (`module.symbols.some((s) => (s.kind === 'class' || s.kind === 'interface') && s.name === m.target?.exportName)`). `extractSymbols` already walks the whole `.rs` file including items outside the `#[cfg(test)] mod`, so `Foo` is present in `module.symbols` when `#[cfg(test)] mod tests` mocks `Foo`.

- [ ] **Step 4: Run, confirm PASS** — `npx vitest run packages/core/test/rules.test.ts` plus the full rule suite.

- [ ] **Step 5: Gate + commit**

```bash
git add packages/core/src/rules/hygiene.ts packages/core/test/rules.test.ts
git commit -m "feat: derive mock-of-self subject per language"
```

---

### Task 5: Python DRIFT-005 — `patch('mod.missing_attr')`

**Files:**
- Modify: `packages/core/src/rules/drift.ts` (`Drift005MissingExport` — add a Python string-path branch)
- Test: `packages/parser-python/test/drift.test.ts` (extend)

**Interfaces:**
- Consumes: Python `patch('mod.attr')` mocks already carry `target: { kind: 'module', specifier: 'mod.attr', span }` (from `makeMock` in `packages/parser-python/src/mocks.ts`).
- Produces: `Drift005MissingExport.check` now, for `module.language === 'python'`, resolves the dotted `specifier` (`mod.attr`) against the production index and flags a missing final attribute (the `patch` module path resolves; the patched name does not exist in the module's `exports`).

- [ ] **Step 1: Write the failing test**

Add two fixtures under `packages/parser-python/test/fixtures/drift/`:

`prod_missing.py`:
```python
def ok():
    return 1
```

`test_patch_missing.py`:
```python
from unittest.mock import patch


def test_it():
    with patch('prod_missing.missing'):
        pass
```

Then add to `packages/parser-python/test/drift.test.ts` (which already runs `engine().run()` over that fixtures dir — see its `engine()` helper):

```ts
it('DRIFT-005 fires when patch() targets a missing module attribute', () => {
  const result = engine().run();
  expect(result.issues.some((i) => i.rule === 'DRIFT-005')).toBe(true);
});
```

- [ ] **Step 2: Run, confirm FAIL** — DRIFT-005 currently only handles TS `mockFactoryKey` stubs.

- [ ] **Step 3: Implement**

In `Drift005MissingExport.check`, add a `module.language === 'python'` branch before the existing TS logic: for each mock with `target.kind === 'module'` and a `specifier` of the form `mod.attr`, resolve `mod` to a production module path via `index.getModule`/`resolveByName`, and if the module is indexed but `attr` is not in its `exports` (and not a member of any symbol), emit the `DRIFT-005` error `missing-export: '${specifier}' does not resolve to a real attribute`. Reuse the existing `issue(...)` helper.

- [ ] **Step 4: Run, confirm PASS** — `npx vitest run packages/parser-python/test/drift.test.ts`.

- [ ] **Step 5: Gate + commit**

```bash
git add packages/core/src/rules/drift.ts packages/parser-python/test/drift.test.ts
git commit -m "feat: Python DRIFT-005 for patch of a missing module attribute"
```

---

### Task 6: Python TAUT-006 — unconfigured `assert_called*`

**Files:**
- Modify: `packages/parser-python/src/assertions.ts` (recognize `m.assert_called*`/`assert_not_called` as assertions)
- Modify: `packages/core/src/rules/tautology.ts` (`Taut006UnconfiguredSpyAssert` — recognize the Python api prefix + mock patterns)
- Test: `packages/parser-python/test/assertions.test.ts`, `packages/core/test/rules.test.ts`

**Interfaces:**
- Consumes: Python `Mock`/`MagicMock`/`AsyncMock` mocks carry `pattern: 'autospec'` (or `'patch'`) and `configuredValues`/`stubbedMembers`.
- Produces: Python assertions with `api` in `assert_called`/`assert_called_once`/`assert_called_with`/`assert_called_once_with`/`assert_not_called`, whose first operand's `mockRefs` points at the mock.

- [ ] **Step 1: Write the failing tests**

In `packages/parser-python/test/assertions.test.ts`:

```ts
import { PythonParser } from '../src/index.ts';

it('extracts assert_called assertions with the mock ref', () => {
  const mod = new PythonParser().parseModule(
    'test_x.py',
    "from unittest.mock import Mock\n\ndef test_it():\n    m = Mock()\n    m.assert_called()\n",
    { config: undefined, resolveImport: () => null },
  );
  expect(
    mod.assertions.some((a) => a.api === 'assert_called' && a.operands[0]?.mockRefs.length === 1),
  ).toBe(true);
});
```

In `packages/core/test/rules.test.ts`:

```ts
it('TAUT-006 fires on a Python mock asserted but never configured or invoked', () => {
  const module = makePythonTestModule({
    mocks: [{ id: 'm1', pattern: 'autospec', framework: 'unittest', configuredValues: [], stubbedMembers: [], invocationSites: [], isAutomock: false, ...span }],
    assertions: [{ api: 'assert_called', operands: [{ kind: 'call', text: 'm.assert_called()', mockRefs: ['m1'], provenance: 'mock-call', constant: false }], fnId: 'f' }],
  });
  expect(runTaut006(module).map((i) => i.rule)).toContain('TAUT-006');
});
```

- [ ] **Step 2: Run, confirm FAIL** — Python parser doesn't emit `assert_called` assertions; TAUT-006 only matches `toHaveBeenCalled`.

- [ ] **Step 3: Implement**

- In `packages/parser-python/src/assertions.ts`, extend `CALL_ASSERTIONS` (or add a second set `SPY_ASSERTIONS`) with `assert_called`, `assert_called_once`, `assert_called_with`, `assert_called_once_with`, `assert_not_called`. In `assertionFromCall`, when the name is in the spy set, produce an `AssertionIR` whose first operand is `exprIR` of the *base object* (the mock variable `m`, so `mockRefs` resolves via `mockAccess`) and `api` is the method name. (For the existing `assertEqual`-style calls the operands are the args; for spy calls the operand is the receiver.)
- In `packages/core/src/rules/tautology.ts` `Taut006UnconfiguredSpyAssert`, change the gate from `a.api.startsWith('toHaveBeenCalled')` to `a.api.startsWith('toHaveBeenCalled') || a.api.startsWith('assert_called') || a.api === 'assert_not_called'`, and change `isSpy` from the TS-only predicate to: TS `vi.spyOn`/`jest.spyOn` OR Python `pattern === 'autospec' | 'patch' | 'patch-object'`.

- [ ] **Step 4: Run, confirm PASS** — both test files.

- [ ] **Step 5: Gate + commit**

```bash
git add packages/parser-python/src/assertions.ts packages/core/src/rules/tautology.ts packages/parser-python/test/assertions.test.ts packages/core/test/rules.test.ts
git commit -m "feat: Python TAUT-006 for unconfigured assert_called mocks"
```

---

### Task 7: PHP TAUT-006 — Mockery `spy()`

**Files:**
- Modify: `packages/core/src/ir.ts` (add `MockPattern` value `'mockery-spy'`; bump `IR_SCHEMA_VERSION` `'5'`→`'6'`)
- Modify: `packages/parser-php/src/index.ts` (emit `'mockery-spy'` for `Mockery::spy`)
- Modify: `packages/core/src/rules/tautology.ts` (add `'mockery-spy'` to `isSpy`)
- Test: `packages/parser-php/test/*` (spy extraction), `packages/core/test/rules.test.ts`

**Interfaces:**
- Produces: `MockPattern` gains `'mockery-spy'`; PHP `Mockery::spy(Foo::class)` mocks emit `pattern: 'mockery-spy'` (vs `'mockery'` for `Mockery::mock`); TAUT-006's `isSpy` includes it.

- [ ] **Step 1: Write the failing test** (in the PHP parser test):

```php
// fixture: a test using Mockery::spy(Foo::class) and $spy->shouldHaveReceived('m') with no shouldReceive config
```

assert the parsed mock's `pattern === 'mockery-spy'`.

- [ ] **Step 2: Run, confirm FAIL** — both `mock` and `spy` map to `'mockery'`.

- [ ] **Step 3: Implement**

- `packages/core/src/ir.ts`: add `'mockery-spy'` to the `MockPattern` union; bump `IR_SCHEMA_VERSION` to `'6'` with a comment.
- `packages/parser-php/src/index.ts` (line ~496–500): when the Mockery factory is `spy` (the `name` in `MOCKERY_FACTORIES`), emit `pattern: 'mockery-spy'` instead of `'mockery'`.
- `packages/core/src/rules/tautology.ts`: `isSpy` becomes `mock.pattern === 'vi.spyOn' || mock.pattern === 'jest.spyOn' || mock.pattern === 'mockery-spy' || mock.pattern === 'autospec' || mock.pattern === 'patch' || mock.pattern === 'patch-object'` (fold Task 6's Python patterns here too if not already merged).

- [ ] **Step 4: Run, confirm PASS** — PHP parser test + rule test.

- [ ] **Step 5: Gate + commit**

```bash
git add packages/core/src/ir.ts packages/parser-php/src/index.ts packages/core/src/rules/tautology.ts packages/parser-php/test packages/core/test/rules.test.ts
git commit -m "feat: PHP TAUT-006 for unconfigured Mockery spies"
```

---

### Task 8: pyright spike (throwaway)

**Files:**
- Create: `experiments/pyright-spike/` (gitignored, throwaway — never committed)

**Interfaces:**
- Produces (report only, no committed API): the confirmed pyright entry point (which npm package + import), how to bind resolved types to tree-sitter AST nodes, and cold-start cost on a real pytest repo.

- [ ] **Step 1: Check the toolchain** — `npm view pyright version` (confirm it installs on Node ≥ 20 in this environment).

- [ ] **Step 2: Write a probe script** in `experiments/pyright-spike/probe.mjs` that installs `pyright`, loads its programmatic API (`pyright-internal`), runs the evaluator over a small two-file fixture (an unannotated `def get() -> ...` with a literal return + a call site), and prints the resolved return type. Goal: answer "can we resolve a function's return type without source annotations, in-process, synchronously?"

- [ ] **Step 3: Record cold-start + memory** on a mock-heavy pytest repo (e.g. a shallow clone of httpx) — one number for `first-run analyze` and one for `cached` (the `better-sqlite3` IR cache absorbs repeat cost).

- [x] **Step 4: Report findings** — **DONE (2026-08-17).** `pyright-internal` is unpublished (npm 404 since 2024-05-11); `basedpyright-internal` does not exist. The `pyright` npm package (1.1.413) bundles the analyzer only as an undocumented webpack module registry (`dist/pyright-internal.js` exports `{ ids, modules }`), not a clean CJS API. The LSP server (`pyright-langserver`) responds to `initialize` (~110ms) but `textDocument/hover`/`documentSymbol`/`definition` time out under Node 25 (no `publishDiagnostics` after `didOpen`). **Decision:** use the `pyright` CLI `--createstub` subprocess instead — verified it infers unannotated types (`def get_count()` → `# -> Literal[42]:`, `def get_name(flag)` → `# -> Literal['hello'] | None:`), cold start ~180ms. Task 9 is revised to parse `--createstub` output (whole-file stub with inferred types as comments) rather than an in-process evaluator.

---

### Task 9: pyright type inference in `@momus/parser-python`

> **REVISED (2026-08-17):** per Task 8 findings, this task uses the `pyright` CLI `--createstub` subprocess (parsing the generated `.pyi` stub's `# -> Type:` / param-type comments) rather than an in-process `pyright-internal` evaluator. `inferTypes` therefore runs one subprocess per production module, memoized per workspace root; it is async and degrades to annotations-only on any failure.

**Files:**
- Modify: `packages/parser-python/package.json` (add `pyright` dependency)
- Create: `packages/parser-python/src/pyright.ts`
- Modify: `packages/parser-python/src/symbols.ts` (enrich signatures with resolved types)
- Modify: `packages/parser-python/src/index.ts` (lazy-load pyright; degrade to annotations-only on failure)
- Test: `packages/parser-python/test/pyright.test.ts` (new)

**Interfaces:**
- Produces: `inferTypes(root: string, sources: Array<{ path: string; source: string }>): Map<string, SignatureIR>` — keyed by symbol id (`${path}#${name}` / `${parentId}.${name}`), with `returnType`/`param.type` resolved by pyright (the exact pyright call confirmed in Task 8). `undefined`/missing entries → annotations-only.

- [ ] **Step 1: Write the failing test** (new `pyright.test.ts`):

```ts
import { PythonParser } from '../src/index.js';

it('resolves an unannotated return type via pyright', () => {
  const prod = new PythonParser().parseModule(
    '/repo/service.py',
    'def get_count():\n    return 42\n',
    { config: undefined, resolveImport: () => null },
  );
  const fn = prod.symbols.find((s) => s.name === 'get_count')!;
  expect(fn.signature?.returnType?.kind).toBe('named');
  expect(fn.signature?.returnType?.name).toBe('int');
});
```

- [ ] **Step 2: Run, confirm FAIL** — `returnType` is `undefined` (no annotation).

- [ ] **Step 3: Implement**

- `packages/parser-python/package.json`: add `"pyright": "<version from Task 8>"` to `dependencies`.
- `packages/parser-python/src/pyright.ts`: implement `inferTypes` using the Task-8-confirmed entry point. It takes the workspace root + the set of `.py` sources, runs the evaluator once (memoized per root, like `getCrateIndex`), and returns the `Map<string, SignatureIR>` of resolved signatures.
- `packages/parser-python/src/symbols.ts`: add an optional `inferred?: Map<string, SignatureIR>` parameter to `extractSymbols`; when present and a symbol has no source annotation, use the inferred `returnType`/param types (and set `type` on params that lack it). Keep the source-annotation path authoritative when both exist.
- `packages/parser-python/src/index.ts`: in `parseModule`, lazily `import('./pyright.js')` inside `try/catch`; on success pass `inferTypes(root, sources)` to `extractSymbols`; on any failure fall back to the current annotations-only extraction (never throw). `root` is derived from `path` (walk up to `pyproject.toml`/`setup.py`, else the file's dir).

- [ ] **Step 4: Run, confirm PASS** — `npx vitest run packages/parser-python/test/pyright.test.ts packages/parser-python/test/`.

- [ ] **Step 5: Add a drift regression** in `packages/parser-python/test/drift.test.ts`: an unannotated production method returning `int` whose `patch.object` stub returns `'nope'` now fires DRIFT-003 (previously SYS-003 skipped).

- [ ] **Step 6: Gate + commit**

```bash
git add packages/parser-python/package.json packages/parser-python/src/pyright.ts packages/parser-python/src/symbols.ts packages/parser-python/src/index.ts packages/parser-python/test/pyright.test.ts packages/parser-python/test/drift.test.ts
npm install
git add package-lock.json
git commit -m "feat(parser-python): pyright type inference for unannotated signatures"
```

---

### Task 10: Python contract synthesis (pytest/unittest)

**Files:**
- Modify: `packages/server/src/index.ts` (`synthesize_mock_contract` framework enum + a new `synthesizePythonContract`)
- Modify: `packages/cli/src/index.ts` (help text `--framework`)
- Test: `test/integration/mcp.test.ts` (extend), `packages/cli/test/index.test.ts`

**Interfaces:**
- Produces: `synthesizeContract(root, targetPath, symbolName, framework, includeReturnValues)` accepts `framework: 'pytest' | 'unittest'` and routes `.py` targets to `synthesizePythonContract(abs, source, targetPath, symbolName, framework, includeReturnValues)`.

- [ ] **Step 1: Write the failing test** (in the MCP integration test):

```ts
it('synthesizes a pytest mock from a Python class', async () => {
  const out = await callTool('synthesize_mock_contract', {
    targetPath: 'fixtures/py/service.py', symbolName: 'Service', framework: 'pytest',
  });
  expect(out.template).toContain("patch.object(Service");
  expect(out.template).toContain('return_value');
});
```

- [ ] **Step 2: Run, confirm FAIL** — `framework` zod enum rejects `'pytest'`.

- [ ] **Step 3: Implement**

- Widen the `framework` zod enum to `['vitest','jest','phpunit','pest','pytest','unittest','mockall','mockito','wiremock']`.
- Add `synthesizePythonContract`: parse the production module with `new PythonParser().parseModule(...)` (as the PHP path does), pick the class (by `symbolName` or first class), iterate public methods, and emit a `unittest.mock.patch.object` template — `with patch.object(Service, 'get_count', return_value=0):` lines — with return placeholders from `pyReturnExample(signature.returnType)` (reuse the `phpReturnExample` shape: `int`→`0`, `str`→`''`, `bool`→`False`, `None`/untyped→`None`, `list`→`[]`). Emit a `// Generated by momus …` header and a member count, matching the TS/PHP template style.
- Route `.py` files in `synthesizeContract` to it (alongside the existing `.php` branch).

- [ ] **Step 4: Run, confirm PASS** — MCP + CLI tests.

- [ ] **Step 5: Gate + commit**

```bash
git add packages/server/src/index.ts packages/cli/src/index.ts test/integration/mcp.test.ts packages/cli/test/index.test.ts
git commit -m "feat: synthesize pytest/unittest mock contracts"
```

---

### Task 11: Rust contract synthesis (mockall/mockito/wiremock)

**Files:**
- Modify: `packages/server/src/index.ts` (`synthesizeRustContract`)
- Test: `test/integration/mcp.test.ts` (extend)

**Interfaces:**
- Produces: `synthesizeContract` routes `.rs` targets to `synthesizeRustContract(abs, source, targetPath, symbolName, framework, includeReturnValues)` for `framework ∈ {mockall, mockito, wiremock}`.

- [ ] **Step 1: Write the failing test**

```ts
it('synthesizes a mockall mock from a Rust trait', async () => {
  const out = await callTool('synthesize_mock_contract', {
    targetPath: 'fixtures/rs/repo.rs', symbolName: 'Repo', framework: 'mockall',
  });
  expect(out.template).toContain('mock!');
  expect(out.template).toContain('expect_fetch');
});
```

- [ ] **Step 2: Run, confirm FAIL** — `.rs` falls through to the TS `ts.createSourceFile` path (wrong result).

- [ ] **Step 3: Implement**

- Add `synthesizeRustContract`: parse with `new RustParser().parseModule(...)`; pick the trait/struct by `symbolName` (else first symbol); emit for `mockall`: a `mock! { pub MockName { … } }` block with each method as `fn name(&self, …) -> Ret;` plus an `impl Trait for MockName { … }`, and `let mut mock = MockName::new(); mock.expect_name().returning(...)` setup lines with type-derived placeholders (`u8/i32/f64`→`0`, `String`/`str`→`String::from("")`/`""`, `bool`→`false`, `Option<T>`→`None`, `Result<T,E>`→`Ok(<T example>)`, `Vec<T>`→`vec![]`). For `mockito`/`wiremock` targets that are HTTP-oriented, emit the corresponding `mock("GET","/p")…create()` / `Mock::given(…)…respond_with(…)` skeleton (conservative — the symbol has no route info, so the template is a labeled scaffold, not a full route).
- Route `.rs` in `synthesizeContract` to it.

- [ ] **Step 4: Run, confirm PASS** — MCP test.

- [ ] **Step 5: Gate + commit**

```bash
git add packages/server/src/index.ts test/integration/mcp.test.ts
git commit -m "feat: synthesize mockall/mockito/wiremock contracts"
```

---

## Final acceptance (after all tasks)

- Full gate: `npm run typecheck && npm test && npm run lint && npm run format:check && npm run audit-self` — all green.
- Dogfood: re-run mockall (0 errors, warnings down to the genuine cfg-gated set), a mock-heavy pytest repo (httpx or flask) exercising pyright inference, and Knossos (PHP) + Chaos (TS) re-audits unchanged.
- Update `docs/11-real-world-findings.md` with the parity dogfood results and sync `HANDOVER.md` / `docs/07-roadmap.md` / `docs/README.md` to reflect the parity state (one docs commit at the end).
- PR `feat/language-parity` → merge → release-please cuts the next patch.
