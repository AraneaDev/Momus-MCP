# Python Language Support — Design

**Date:** 2026-08-17
**Status:** Design approved (in chat) — awaiting written-spec review
**Scope:** Add Python as a third Momus language. Rust is a *separate* follow-up spec
(sequenced second, reusing the N-language core built here).

---

## 1. Context & goal

Momus-MCP statically audits test suites for **tautological assertions** (tests that cannot
fail) and **mock-contract drift** (test doubles that no longer match production). It is the
"false-green test suite detector for coding agents." Today it supports **TypeScript/JS** and
**PHP** through the `LanguageParser` plugin interface: each language emits the
language-neutral `ModuleIR`, and rules (`packages/core/src/rules/`) operate only on IR, never
on a raw AST.

This spec adds **Python**. The headline value is the same as PHP's: a `patch.object(Thing,
'method')` whose `method` was renamed or removed is a *false-green* test, and Momus should
catch it statically (DRIFT-001), plus the same tautology/drift rules that already exist.

`docs/02-architecture.md` §2.2.4 already commits to Python via **tree-sitter-python + type
stubs**; this spec upgrades "stubs" to **annotations-first, with pyright as a deferred
upgrade** (see §3).

---

## 2. Scope & sequencing

- **In this spec:** Python, plus the N-language core refactor it requires (§4.1).
- **Separate follow-up spec:** Rust (`syn`/tree-sitter + type info). It reuses everything in
  §4.1 and adds its own parser package + mock catalog.
- **Sequencing decision:** Python first because it is the higher-value, lower-risk first new
  language — dynamic typing means we lean on the existing PHP "degraded typing" precedent
  (annotations → types, absent → skip), and its mock surface (`unittest.mock` +
  `pytest-mock`) is broad but well-understood.

---

## 3. Decisions (with rationale)

| Decision | Choice | Rationale |
|---|---|---|
| Parsing + types | **tree-sitter-python** (syntax) + **pyright** (types, deferred) | No Python runtime; both ship as npm/native packages, preserving "works anywhere Node runs." Pyright is a TypeScript project published to npm, so real type resolution is possible without a Python interpreter. |
| Type-awareness depth (v1) | **Annotations-first; pyright deferred behind a seam** | Mirrors the PHP docblock precedent (native/PHPDoc types when present, degrade otherwise). Lowest risk; ships DRIFT-001/005/TAUT first. Pyright's inference (its real strength) lands later via the seam. |
| Mock surface | **Common core:** `unittest.mock` (`patch`, `patch.object`, `Mock`, `MagicMock`, `AsyncMock`, `create_autospec`) + pytest assertions (`assert`, `pytest.raises`, `pytest.approx`) + `pytest-mock` `mocker` + `monkeypatch` | Covers the overwhelming majority of real Python test code without committing to the long tail in pass one. |
| Validation | **Synthetic fixtures + a real open-source repo** | Matches project culture (Chaos-MCP for TS, Knossos-MCP for PHP). The dogfood repo is proposed and confirmed before running. |
| Core refactor | **Single language registry** (`packages/core/src/languages.ts`) | Removes the 8+ hand-maintained language lists that have repeatedly drifted when a language was added (see HANDOVER §8 history). |

---

## 4. Design

### 4.1 Core becomes N-language (single registry)

New module `packages/core/src/languages.ts` is the single source of truth:

```ts
export const LANGUAGES = {
  typescript: { extensions: ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts'],
                testFilePatterns: ['**/*.{test,spec}.{ts,tsx,js,jsx,mjs}', '**/__tests__/**'],
                defaultEnabled: true },
  php:        { extensions: ['php'], testFilePatterns: [], defaultEnabled: false },
  python:     { extensions: ['py'],  testFilePatterns: ['**/test_*.py', '**/*_test.py'], defaultEnabled: false },
} as const;
export type Language = keyof typeof LANGUAGES;
```

Every *language list* now derives from the registry:

- `Language` = `keyof typeof LANGUAGES` (replaces the `'typescript' | 'php'` union in
  `ir.ts`).
- `MomusConfig.languages` = `Record<Language, boolean>`; defaults derived from
  `defaultEnabled` (Python default `false`, like PHP).
- `DEFAULT_CONFIG.testFilePatterns` = flattened from the registry.
- `discovery.ts` builds its extension regex from `extensions` (replaces the hard-coded
  `/\.(ts|tsx|js|jsx|mts|cts|php)$/`).
- `doctor` iterates the registry for per-language readiness checks.

Also in this pass (still language-list-adjacent, but IR-contract additions not registry
derivable):

- `MockFramework` += `'unittest' | 'pytest'` (`ir.ts`).
- `MockPattern` += the Python patterns in §4.3 (`ir.ts`).
- `IR_SCHEMA_VERSION` 3 → 4 (ModuleIR/parser extraction changed).
- `schemas/momusrc.schema.json` += `python` boolean.

**Honest boundaries** (documented, deliberately *not* in the registry):

1. **`MockFramework` / `MockPattern`** stay flat IR-contract unions. They describe
   frameworks/patterns, not languages, and rules key off them.
2. **Parser instantiation** stays in CLI + server (`new CompositeParser([...])`). `core`
   cannot import parser packages (dependency direction: parsers → core). This is the one
   intentional "wire it here" point.
3. **`release-please-config.json` `extra-files`** and **`scripts/publish.mjs` ORDER** are
   static JSON/scripts outside the TS module graph; they stay hand-maintained and form the
   "add a language" checklist (§5).

### 4.2 `@momus/parser-python` package

Mirrors `@momus/parser-php`: one package, `PythonParser implements LanguageParser`,
depends on `@momus/core` **types only**.

- **Deps:** `tree-sitter` + `tree-sitter-python` (native bindings). The Phase-0 spike (§4.8)
  confirms native vs `web-tree-sitter` WASM (async init + asset loading) before committing.
- **`canParse`:** `/\.py$/i`.
- **`resolveImport`:** import specifier → absolute file path. Handles `import a.b.c`,
  `from a.b import c`, package `__init__.py`; walks upward like the Composer resolver; returns
  `null` when ambiguous (conservative, never crashes).
- **`parseModule`** emits:
  - `symbols`: classes, functions, methods with `SignatureIR` from PEP 484/526/585/604
    annotations mapped to `TypeIR` (`Optional[X]`, `X | None`, `list[X]`, `dict[K,V]`,
    `Callable`, `Literal`, forward refs kept as `named`). Reuses a parser structured like the
    PHP `parseDocType` but for annotation grammar.
  - `imports`: `import` / `from … import … as …` with local names.
  - `kind`: test vs production from `test_*.py` / `*_test.py` filename or a `tests/` dir.
  - `framework`: best-effort (mirrors PHP's `isTestClass` heuristic) — `'pytest'` when pytest
    idioms are present (`pytest.raises`, `mocker`, `monkeypatch`), else `'unittest'`. This is a
    hint for reporting only, never a correctness gate.
  - `comments` (for `@momus-ignore`), `diagnostics` (SYS-001 parse errors — never throw).

### 4.3 Mock detection → `MockIR`

| Python pattern | `MockIR` |
|---|---|
| `patch('mod.attr')` / `@patch(...)` / `with patch(...) as m` | `pattern:'patch'`, `target:{kind:'module', specifier:'mod.attr'}` → **DRIFT-005** |
| `patch.object(Thing, 'method')` | `pattern:'patch-object'`, `target:{kind:'instance-member', symbolId:'Thing', memberName:'method'}` → **DRIFT-001** |
| `Mock(spec=Thing)` / `MagicMock(spec=Thing)` / `create_autospec(Thing)` | `pattern:'autospec'`, `target:{kind:'class', symbolId:'Thing'}` + spec-derived `stubbedMembers` |
| `mocker.patch(...)` / `mocker.Mock(...)` (pytest-mock) | same as `patch`/`Mock`, reached through the `mocker` fixture binding |
| `monkeypatch.setattr(obj, 'attr', value)` | `pattern:'monkeypatch'`, attribute target |
| `mock.return_value = X` / `mock.side_effect = ...` | `ConfiguredValueIR{api:'return-value' | 'side-effect', value}` → **DRIFT-003** when annotated |
| `mock.method.return_value = X` | member stub + configured value |

**Negative rule:** a plain `Mock()`/`MagicMock()` with no `spec` and no target is drift-inert
(analogous to `vi.fn()` with no assertion participation), though it can still trigger the
TAUT rules.

### 4.4 Assertions + provenance → `AssertionIR`

- `assert expr` (pytest) → operands extracted from binary comparisons (`==`, `!=`, `is`,
  `is not`, `in`), enabling TAUT-001 self-comparison (`assert x == x`).
- `pytest.raises(X)` / `pytest.approx(...)` captured as assertion metadata, not operands.
- `assertEqual` / `assertTrue` / `assertNotEqual` (unittest) → operands.
- Provenance reuses the existing `SourceKind` semantics:
  - `mock.return_value` reads → `mock-config`
  - mock method calls → `mock-call`
  - literals → `literal`
  - SUT calls → `production` (import-resolution + conservative call tracing)
- Reachability (TAUT-005/006): a mock is marked reachable when it is passed to a SUT call,
  returned, or asserted on — mirroring the TS/PHP hand-off detection.

### 4.5 Rule mapping

Rules are IR-only, so **no new rule-engine code**. Mapping:

| Rule | Python behavior |
|---|---|
| DRIFT-001 | missing attribute/member on a patched/spec'd class — **works without types** (headline) |
| DRIFT-002 | signature mismatch — only when annotations are present; else skip with `SYS-003` note |
| DRIFT-003 | configured return-value assignability — only when annotations are present; else skip |
| DRIFT-004 | constructor drift — PHP-only stub; N/A |
| DRIFT-005 | missing target attribute/module on `patch` / `patch.object` |
| DRIFT-006 | stale mock (git-diff) — same diff plumbing as TS/PHP |
| TAUT-001..006, MOCK-001/002 | unchanged over IR; Python `assert`/mock semantics feed them |

### 4.6 Type seam (pyright, deferred)

Type-awareness stays **parser-internal**, matching how `parser-typescript` owns its
`ts.Program` (the `TypeInfoProvider` in `docs/02` §2.3.1 was never implemented in code).
Add a minimal seam *inside* `parser-python` only, so a later pyright integration can resolve
`patch.object(Thing, …)` targets and annotated return-assignability without touching core.
YAGNI: do **not** add a type provider to `core`'s `ParseContext` in this pass.

### 4.7 Testing & validation

- **Fixture gallery** (`packages/parser-python/test/fixtures/`): planted violations
  (renamed method → DRIFT-001, patched missing attribute → DRIFT-005, `assert x == x` →
  TAUT-001, configured return mismatch → DRIFT-003) + healthy twins. Excluded from the vitest
  run via `**/test/fixtures/**`.
- **Unit + rule tests** mirroring `parser-php` (symbols/imports/mocks/assertions per pattern).
- **Golden audit test** (`test/golden`) pinning the exact issue set.
- **MCP integration** round-trip with `languages.python: true` (in-memory, cache disabled).
- **`doctor`** Python-readiness branch covered by unit tests.
- **Dogfood** against a real open-source pytest repo; the candidate is proposed and confirmed
  with the user before running. Findings go to `docs/11-real-world-findings.md`.

### 4.8 Build order

1. **Core N-language refactor** (§4.1) — green, no behavior change to TS/PHP.
2. **Spike** (in `experiments/`, throwaway): tree-sitter native-vs-WASM viability +
   annotation-parsing fidelity on a sample corpus.
3. `@momus/parser-python` **symbols / imports / test-detection**.
4. **Mock detection catalog** (§4.3).
5. **Assertions + provenance + reachability** (§4.4).
6. **Annotated DRIFT-002/003** on signatures (§4.5).
7. **Fixtures / golden / MCP / doctor / release-publish wiring** (§4.7 + §5).
8. **Dogfood + false-positive fixes.**

---

## 5. "Add a language" checklist (post-refactor)

Adding a language should now be: (1) an entry in `languages.ts`; (2) a parser package
implementing `LanguageParser`; (3) wire the parser into CLI + server; (4) two static-config
edits — `release-please-config.json` `extra-files` and `scripts/publish.mjs` ORDER. Plus
framework/pattern IR enum members if the language introduces new ones.

---

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| tree-sitter native build (node-gyp) breaks "works anywhere Node runs" | Spike evaluates `web-tree-sitter` WASM as fallback; decide before committing to a dependency. |
| pyright-internal is an unstable, heavy API | Deferred entirely in v1 (Approach 1); annotations carry the load; the seam isolates it when adopted. |
| Dynamic typing yields sparse DRIFT-002/003 coverage | Honest degraded mode + `SYS-003` notes (PHP precedent); pyright closes the gap later. |
| Registry refactor regresses TS/PHP | It is a pure derivation refactor; existing 300+ tests + golden audit + self-audit must stay green as the gate. |
| `assert` statement ambiguity (no matcher name) | Only binary comparison forms yield operands; everything else is conservative (`unknown`). |

---

## 7. Open questions (answered at implementation, not blocking)

1. Exact tree-sitter runtime (native vs WASM) — spike decides.
2. Which real repo to dogfood — proposed and confirmed before running.


---

## 8. Out of scope

- **Rust** (separate follow-up spec; reuses §4.1).
- **pyright integration** (deferred; seam defined in §4.6).
- **`unittest.TestCase` assertion catalog beyond `assertEqual`/`assertTrue`** (broad slice
  deferred past "common core").
- **`freezegun`, `responses`, `vcrpy`, and other third-party test helpers** (later catalog
  additions).
