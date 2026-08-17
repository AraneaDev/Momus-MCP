# Python Language Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Python as a third Momus language (parser + mock/assertion extraction + wiring) on top of an N-language core refactor, so Momus audits pytest/unittest suites for mock-contract drift and tautological assertions.

**Architecture:** A new `packages/core/src/languages.ts` becomes the single source of truth for language metadata, from which `Language`, config defaults, test-file patterns, and the discovery extension regex are all derived. A new `@momus/parser-python` package implements the existing `LanguageParser` interface using tree-sitter-python for syntax and textual PEP 484/526/585/604 annotation parsing into the language-neutral `ModuleIR` (the PHP-docblock precedent). Rules stay untouched — they consume IR only.

**Tech Stack:** TypeScript 5.9 (pinned), tree-sitter + tree-sitter-python, Vitest, tsx, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-17-python-language-support-design.md` — the plan argues from the spec, so the spec travels with it; executors read both.

## Global Constraints

- **`typescript@^5.9`** pinned everywhere (root + every package); never `typescript@7` (no programmatic API from ESM).
- **Node ≥ 20 native strip-only mode** (used by the `momus` bin): never use TypeScript parameter properties (`constructor(public x)`); they crash at import time.
- **`@momus/core` has zero runtime dependencies.** Parser packages depend on `@momus/core` **types only** (`import type`), so no dependency cycle.
- **Run from `src/` via tsx**; no `dist/` build. Package `exports` point at `./src/index.ts`.
- **Commit messages** are Conventional Commits (`feat(parser-python): …`, `refactor(core): …`) with **no attribution footer** — the "Generated with Codebuff" footer is forbidden and CI-enforced.
- **Vitest fixtures:** planted-violation galleries live under `**/test/fixtures/**` (auto-excluded from the test run). Never put a real test there.
- **Never `write_file` over an existing file** without confirming it exists and reading it first (HANDOVER §5.19). Restore-then-append.
- **The registry refactor (Task 1) must keep all existing tests green** — it is a pure derivation refactor, no behavior change to TS/PHP.
- **New code ships with planted-violation + healthy fixtures** in CI (repo guardrail).

---

## File Structure

```
packages/core/src/languages.ts        # NEW — LANGUAGES registry + Language + derived helpers
packages/core/src/ir.ts               # MOD — Language re-export; MockFramework/MockPattern += python
packages/core/src/config.ts           # MOD — languages: Record<Language, boolean>; derived defaults
packages/core/src/discovery.ts        # MOD — extension regex derived from registry
packages/core/src/index.ts            # MOD — export languages.ts
schemas/momusrc.schema.json           # MOD — languages.python boolean
packages/parser-python/               # NEW package
  package.json                        #     — name/version/exports/deps (template: parser-php)
  tsconfig.json                       #     — extends ../../tsconfig.base.json
  src/index.ts                        #     — PythonParser implements LanguageParser (glue)
  src/tree.ts                         #     — tree-sitter parse/walk/span helpers (spike output)
  src/types.ts                        #     — annotation text -> TypeIR
  src/symbols.ts                      #     — class/function/method -> SymbolIR
  src/resolve.ts                      #     — import specifier -> file path
  src/mocks.ts                        #     — unittest.mock/pytest-mock/monkeypatch -> MockIR
  src/assertions.ts                   #     — assert/assertEqual -> AssertionIR + provenance
  test/fixtures/                      #     — planted violations + healthy twins (excluded from run)
  test/parser.test.ts                 #     — integration tests via AuditEngine
packages/cli/src/index.ts             # MOD — createWorkspaceParser += PythonParser; pythonReadiness
packages/server/src/index.ts          # MOD — createMomusServer += PythonParser
packages/cli/package.json             # MOD — dependency on @momus/parser-python
packages/server/package.json          # MOD — dependency on @momus/parser-python
release-please-config.json            # MOD — extra-files += parser-python/package.json
scripts/publish.mjs                   # MOD — ORDER += @momus/parser-python
test/golden/audit.test.ts             # MOD — python golden case (Task 7)
test/integration/mcp.test.ts          # MOD — python MCP round-trip (Task 7)
```

---

### Task 1: Core language registry (N-language refactor)

**Files:**
- Create: `packages/core/src/languages.ts`
- Modify: `packages/core/src/ir.ts`, `packages/core/src/config.ts`, `packages/core/src/discovery.ts`, `packages/core/src/index.ts`, `packages/core/src/parser.ts`, `packages/core/src/compositeParser.ts`
- Test: `packages/core/test/languages.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  // packages/core/src/languages.ts
  export const LANGUAGES = {
    typescript: { extensions: ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts'],
                  testFilePatterns: ['**/*.{test,spec}.{ts,tsx,js,jsx,mjs}', '**/__tests__/**'],
                  defaultEnabled: true },
    php:        { extensions: ['php'], testFilePatterns: [], defaultEnabled: false },
    python:     { extensions: ['py'],  testFilePatterns: ['**/test_*.py', '**/*_test.py'], defaultEnabled: false },
  } as const;
  export type Language = keyof typeof LANGUAGES;
  export function languageExtensions(lang: Language): readonly string[];
  export function allExtensions(): string[];          // flat, sorted
  export function defaultTestFilePatterns(): string[]; // flattened, in registry order
  export function defaultEnabledLanguages(): Record<Language, boolean>;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/languages.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  LANGUAGES,
  allExtensions,
  defaultEnabledLanguages,
  defaultTestFilePatterns,
  languageExtensions,
} from '../src/languages.ts';

describe('languages registry', () => {
  it('derives every language list from one table', () => {
    expect(LANGUAGES.typescript.extensions).toEqual(['ts', 'tsx', 'js', 'jsx', 'mts', 'cts']);
    expect(LANGUAGES.python.testFilePatterns).toEqual(['**/test_*.py', '**/*_test.py']);
    expect(languageExtensions('php')).toEqual(['php']);
  });

  it('flattens extensions and test patterns', () => {
    expect(allExtensions()).toContain('py');
    expect(allExtensions()).toContain('php');
    expect(defaultTestFilePatterns()).toContain('**/test_*.py');
    expect(defaultTestFilePatterns()).toContain('**/__tests__/**');
  });

  it('derives enabled-by-default languages', () => {
    const enabled = defaultEnabledLanguages();
    expect(enabled.typescript).toBe(true);
    expect(enabled.php).toBe(false);
    expect(enabled.python).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/test/languages.test.ts`
Expected: FAIL with `Cannot find module '../src/languages.ts'`.

- [ ] **Step 3: Write the registry**

Create `packages/core/src/languages.ts` with the exact `LANGUAGES` table and the four helpers from the Interfaces block above. Implement them literally:

```ts
export function languageExtensions(lang: Language): readonly string[] {
  return LANGUAGES[lang].extensions;
}
export function allExtensions(): string[] {
  return [...new Set(Object.values(LANGUAGES).flatMap((l) => l.extensions))].sort();
}
export function defaultTestFilePatterns(): string[] {
  return Object.values(LANGUAGES).flatMap((l) => l.testFilePatterns);
}
export function defaultEnabledLanguages(): Record<Language, boolean> {
  return Object.fromEntries(Object.entries(LANGUAGES).map(([k, l]) => [k, l.defaultEnabled])) as Record<Language, boolean>;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/test/languages.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewire `ir.ts`, `parser.ts`, `compositeParser.ts` to derive `Language`**

In `packages/core/src/ir.ts`, replace `export type Language = 'typescript' | 'php';` (line 13) with:
```ts
import type { Language } from './languages.ts';
export type { Language }; // re-exported for back-compat with './ir.ts' importers
```
In `packages/core/src/parser.ts` and `packages/core/src/compositeParser.ts`, change the `Language` import from `'./ir.ts'` to `'./languages.ts'` (keep `ModuleIR`/`ModuleIR`-only imports from `'./ir.ts'`).

- [ ] **Step 6: Derive config + discovery from the registry**

In `packages/core/src/config.ts`:
- Change `languages` type to `Record<Language, boolean>` and the default to `defaultEnabledLanguages()`.
- Change `DEFAULT_CONFIG.testFilePatterns` to `defaultTestFilePatterns()`.

In `packages/core/src/discovery.ts`, replace the hard-coded `/\.(ts|tsx|js|jsx|mts|cts|php)$/` check with one derived from `allExtensions()`:

```ts
const SOURCE_EXT = new RegExp(`\\.(${allExtensions().join('|')})$`);
```
and use `!SOURCE_EXT.test(rel)` where the old regex was used.

- [ ] **Step 7: Export the registry**

In `packages/core/src/index.ts`, add `export * from './languages.ts';` after the `./ir.ts` export.

- [ ] **Step 8: Run the full core + repo gate**

Run: `npm run typecheck && npm test`
Expected: typecheck 0 errors; all existing tests pass (registry refactor is behavior-preserving).

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/languages.ts packages/core/src/ir.ts packages/core/src/parser.ts \
  packages/core/src/compositeParser.ts packages/core/src/config.ts packages/core/src/discovery.ts \
  packages/core/src/index.ts packages/core/test/languages.test.ts
git commit -m "refactor(core): derive language lists from a single registry"
```

---

### Task 2: Spike — tree-sitter-python viability + node-shape reference

**Files:**
- Create: `experiments/python-spike/probe.mts` (throwaway, gitignored — self-audit-excluded)
- Create: `packages/parser-python/src/tree.ts` (the committed, spike-validated helper)

**Interfaces:**
- Produces (committed into `packages/parser-python/src/tree.ts`):
  ```ts
  import Parser, { type SyntaxNode } from 'tree-sitter';
  import Python from 'tree-sitter-python';

  export interface PyLoc { line: number; column: number } // 0-based, as tree-sitter reports
  export function parsePython(source: string): { root: SyntaxNode; hasError: boolean };
  export function walk(root: SyntaxNode, visit: (node: SyntaxNode) => void): void;
  export function childField(node: SyntaxNode, field: string): SyntaxNode | null;
  export function textOf(node: SyntaxNode | null | undefined): string; // node.text
  export function start(node: SyntaxNode): PyLoc;   // { line: startPosition.row, column: startPosition.column }
  export function end(node: SyntaxNode): PyLoc;
  ```

- [ ] **Step 1: Install tree-sitter deps in a temp spike workspace**

Run:
```bash
cd experiments/python-spike && npm init -y >/dev/null && npm i tree-sitter tree-sitter-python --no-audit --no-fund
```
Expected: both install (native `tree-sitter` compiles via node-gyp, or prebuilt download). Record which happened.

- [ ] **Step 2: Probe node shapes on the canonical fixture**

Write `experiments/python-spike/probe.mts` that parses this sample and prints `node.type` + field names for the nodes the parser will need:

```python
class Repo:
    def save(self, item: "Item") -> int:
        return 1

from unittest.mock import patch, Mock
from .repo import Repo

def test_save(mocker):
    m = mocker.patch.object(Repo, "save", return_value=1)
    assert m.return_value == 1
```

Run: `npx tsx probe.mts`
Expected: a printed node table. **Verify these exact tree-sitter-python facts** (correct if wrong — do not assume):
- a function is `function_definition` with fields `name` (`identifier`), `parameters`, `return_type`, `body`.
- a class is `class_definition` with fields `name`, `superclasses`, `body`.
- an import is `import_statement` / `import_from_statement`.
- `patch.object(...)` is a `call` whose `function` is an `attribute` (`object` = `patch`, `attribute` = `object`); arguments is an `argument_list` of `string` / `identifier`.
- a mock config `m.return_value` is an `attribute`; assignment `m.return_value = 1` is an `expression_statement` wrapping an `assignment`.
- an annotation is a `type` field on `typed_parameter` / `typed_default_parameter` / `function_definition.return_type`; `list[int]` is `subscript` (`value` = `list`, `subscript` = `int`); `X | None` is `binary_operator` with operator `|`.

- [ ] **Step 3: Record the node-shape cheat-sheet**

Append the verified field names to a comment block at the top of `packages/parser-python/src/tree.ts` so every later task's traversal is grounded in the real grammar (not memory).

- [ ] **Step 4: Implement and unit-test `tree.ts`**

Implement the six functions from the Interfaces block. Add `packages/parser-python/test/tree.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { SyntaxNode } from 'tree-sitter';
import { parsePython, walk, childField, textOf, start, end } from '../src/tree.ts';

describe('python tree helpers', () => {
  it('parses and locates a function definition', () => {
    const { root, hasError } = parsePython('def f(x: int) -> int:\n    return x\n');
    expect(hasError).toBe(false);
    const nodes: SyntaxNode[] = [];
    walk(root, (n) => nodes.push(n));
    const fn = nodes.find((n) => n.type === 'function_definition')!;
    expect(fn).toBeDefined();
    expect(childField(fn, 'name')?.text).toBe('f');
    expect(start(fn).line).toBe(0);
  });
});
```

- [ ] **Step 5: Run the tree test**

Run: `npx vitest run packages/parser-python/test/tree.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit the spike-validated helper (leave the probe in experiments/, gitignored)**

```bash
git add packages/parser-python/src/tree.ts packages/parser-python/test/tree.test.ts
git commit -m "feat(parser-python): spike-validated tree-sitter helpers"
```

---

### Task 3: parser-python scaffold — annotations, symbols, imports, test-detection

**Files:**
- Create: `packages/parser-python/package.json`, `packages/parser-python/tsconfig.json`
- Create: `packages/parser-python/src/types.ts`, `packages/parser-python/src/symbols.ts`, `packages/parser-python/src/resolve.ts`, `packages/parser-python/src/index.ts`
- Test: `packages/parser-python/test/types.test.ts`, `packages/parser-python/test/parser.test.ts`
- Create fixture: `packages/parser-python/test/fixtures/symbols/sample.py`

**Interfaces:**
- Consumes: `parsePython`, `walk`, `childField`, `textOf`, `start`, `end` from `tree.ts` (Task 2); `TypeIR`, `SymbolIR`, `ImportIR`, `ModuleIR`, `SignatureIR`, `ParamIR` from `@momus/core`.
- Produces:
  ```ts
  // types.ts
  export function parseAnnotation(text: string): TypeIR | undefined; // PEP 484/526/585/604 -> TypeIR

  // symbols.ts
  export function extractSymbols(root: SyntaxNode, file: string): SymbolIR[];

  // resolve.ts
  export function resolvePythonImport(specifier: string, fromFile: string): string | null;

  // index.ts
  export class PythonParser implements LanguageParser {
    readonly language = 'python' as const;
    canParse(path: string): boolean;
    resolveImport(specifier: string, fromFile: string): string | null;
    parseModule(path: string, source: string, ctx: ParseContext): ModuleIR;
  }
  ```

- [ ] **Step 1: Package scaffold**

Create `packages/parser-python/package.json` (copy parser-php, swap name/description/deps):
```json
{
  "name": "@momus/parser-python",
  "version": "0.0.0",
  "publishConfig": { "access": "public" },
  "type": "module",
  "description": "Python parser plugin for Momus using tree-sitter-python",
  "files": ["src"],
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit -p tsconfig.json" },
  "dependencies": {
    "@momus/core": "~0.0.1",
    "tree-sitter": "^0.21.1",
    "tree-sitter-python": "^0.23.0"
  },
  "devDependencies": { "@stryker-mutator/core": "^9.6.1" }
}
```
Create `packages/parser-python/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```
Then run `npm run version:sync` to set `version` to the current lockstep version — **never hardcode it** (a stale version blocks the release-config gate). Finally `npm install` at the repo root to link the new workspace. (Pin the exact tree-sitter versions npm resolves, not the guesses above.)

- [ ] **Step 2: Write the failing annotation-parser test**

Create `packages/parser-python/test/types.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseAnnotation } from '../src/types.ts';

describe('parseAnnotation', () => {
  it('maps builtins', () => {
    expect(parseAnnotation('int')).toEqual({ kind: 'named', name: 'int', typeArgs: [] });
    expect(parseAnnotation('None')).toEqual({ kind: 'null' });
    expect(parseAnnotation('Any')).toEqual({ kind: 'unknown' });
  });
  it('unions and optionals', () => {
    expect(parseAnnotation('int | None')).toEqual({ kind: 'union', members: [{ kind: 'named', name: 'int', typeArgs: [] }, { kind: 'null' }] });
    expect(parseAnnotation('Optional[int]')).toEqual({ kind: 'union', members: [{ kind: 'named', name: 'int', typeArgs: [] }, { kind: 'null' }] });
  });
  it('generics', () => {
    expect(parseAnnotation('list[int]')).toEqual({ kind: 'named', name: 'list', typeArgs: [{ kind: 'named', name: 'int', typeArgs: [] }] });
    expect(parseAnnotation('dict[str, int]')).toEqual({ kind: 'named', name: 'dict', typeArgs: [{ kind: 'named', name: 'str', typeArgs: [] }, { kind: 'named', name: 'int', typeArgs: [] }] });
  });
  it('unknown for empty/ambiguous', () => {
    expect(parseAnnotation('')).toBeUndefined();
    expect(parseAnnotation('...')).toEqual({ kind: 'unknown' });
  });
});
```

- [ ] **Step 3: Implement `types.ts`**

Port the PHP `parseDocType` shape (from `packages/parser-php/src/index.ts`) to annotation grammar: split top-level `|` → union, then handle `Optional[...]`, `list[...]`/`dict[...]`/`tuple[...]`/`set[...]` via `[...]`, `Callable[[...], R]`, `Literal[...]`, bare names (`None` → `{kind:'null'}`, `Any` → `{kind:'unknown'}`, builtins → `{kind:'named'}`), forward refs and quoted names (`'Item'` → strip quotes → `named`).

- [ ] **Step 4: Run the types test**

Run: `npx vitest run packages/parser-python/test/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing parser (symbols) test + fixture**

Create `packages/parser-python/test/fixtures/symbols/sample.py`:
```python
class Repo:
    def save(self, item: "Item") -> int:
        return 1

    def load(self, key: str) -> "Item | None":
        return None

def helper(x: list[int]) -> dict[str, int]:
    return {}
```

Create `packages/parser-python/test/parser.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { PythonParser } from '../src/index.ts';

const parser = new PythonParser();
const SRC = `class Repo:
    def save(self, item: "Item") -> int:
        return 1

    def load(self, key: str) -> "Item | None":
        return None

def helper(x: list[int]) -> dict[str, int]:
    return {}
`;

describe('PythonParser symbols', () => {
  it('extracts class/method/function symbols with signatures', () => {
    const mod = parser.parseModule('/x/repo.py', SRC, { config: undefined, resolveImport: () => null });
    expect(mod.language).toBe('python');
    expect(mod.kind).toBe('production');
    const repo = mod.symbols.find((s) => s.name === 'Repo')!;
    expect(repo.kind).toBe('class');
    const save = repo.members.find((m) => m.name === 'save')!;
    expect(save.signature!.returnType).toEqual({ kind: 'named', name: 'int', typeArgs: [] });
    const load = repo.members.find((m) => m.name === 'load')!;
    expect(load.signature!.returnType).toEqual({ kind: 'union', members: [{ kind: 'named', name: 'Item', typeArgs: [] }, { kind: 'null' }] });
  });
});
```

- [ ] **Step 6: Implement `symbols.ts`, `resolve.ts`, and `index.ts`**

- `symbols.ts`: walk the tree; for each `class_definition` build a `SymbolIR` with methods from `function_definition` children; each method's `signature` maps parameters (`typed_parameter` / `typed_default_parameter` / `default_parameter` → `ParamIR`) and `return_type` via `parseAnnotation`. `id` = `${file}#${name}` (methods `${parentId}.${name}`), matching core conventions.
- `resolve.ts`: resolve `import x.y.z` / `from x.y import z` specifiers to files by walking upward for a package root and mapping dotted segments to paths (try `__init__.py`, `.py`); return `null` when not found (never throw).
- `index.ts`: `PythonParser` with `canParse` = `/\.py$/i`; `parseModule` orchestrates symbols/imports/kind/framework and returns `ModuleIR` (mocks/assertions empty `[]` for now). `kind` = test when filename matches `/test_.*\.py$/` or `/.*_test\.py$/` or path contains a `/tests/` segment; `framework` = `'pytest'` when the source references pytest (`pytest`, `mocker`, `monkeypatch`), else `'unittest'` (best-effort, reporting-only).

- [ ] **Step 7: Run the parser test**

Run: `npx vitest run packages/parser-python/test/parser.test.ts`
Expected: PASS.

- [ ] **Step 8: Run typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: green.

- [ ] **Step 9: Commit**

```bash
git add packages/parser-python/package.json packages/parser-python/tsconfig.json \
  packages/parser-python/src packages/parser-python/test
git commit -m "feat(parser-python): symbols, imports, and test detection"
```

---

### Task 4: Mock detection catalog

**Files:**
- Create: `packages/parser-python/src/mocks.ts`
- Modify: `packages/parser-python/src/index.ts`
- Test: `packages/parser-python/test/mocks.test.ts`
- Fixtures: `packages/parser-python/test/fixtures/mocks/patched.py`, `…/mocks/healthy.py`

**Interfaces:**
- Consumes: tree helpers (Task 2), `SymbolIR` (Task 3), `MockIR`, `MockFramework`, `MockPattern`, `ConfiguredValueIR`, `StubbedMemberIR`, `SourceSpan` from `@momus/core`.
- Produces:
  ```ts
  // mocks.ts
  export interface PythonMockState { mocks: MockIR[]; bindings: Map<string, MockIR[]> } // key: 'scope:name'
  export function extractMocks(root: SyntaxNode, file: string, symbols: SymbolIR[]): PythonMockState;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/parser-python/test/mocks.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PythonParser } from '../src/index.ts';

const parser = new PythonParser();

describe('PythonParser mocks', () => {
  it('detects patch.object as an instance-member target', () => {
    const src = `from unittest.mock import patch
from .repo import Repo

def test_save():
    with patch.object(Repo, "save", return_value=1) as m:
        pass
`;
    const mod = parser.parseModule('/x/test_x.py', src, { config: undefined, resolveImport: () => null });
    const mock = mod.mocks.find((m) => m.pattern === 'patch-object')!;
    expect(mock.target).toMatchObject({ kind: 'instance-member', exportName: 'Repo', memberName: 'save' });
  });

  it('detects patch(module.attr) as a module target', () => {
    const src = `from unittest.mock import patch

def test_send():
    with patch("app.mail.send") as m:
        pass
`;
    const mod = parser.parseModule('/x/test_x.py', src, { config: undefined, resolveImport: () => null });
    expect(mod.mocks.some((m) => m.pattern === 'patch' && m.target?.specifier === 'app.mail.send')).toBe(true);
  });

  it('captures return_value as a configured value', () => {
    const src = `from unittest.mock import Mock

def test_price():
    m = Mock(spec=Price)
    m.get_price.return_value = 42
`;
    const mod = parser.parseModule('/x/test_x.py', src, { config: undefined, resolveImport: () => null });
    const stub = mod.mocks.flatMap((m) => m.stubbedMembers).find((s) => s.name === 'get_price')!;
    expect(stub.returnValues).toHaveLength(1);
    expect(stub.returnValues[0]!.api).toBe('return-value');
    expect(stub.returnValues[0]!.value).toEqual({ kind: 'literal', value: 42 });
  });
});
```

- [ ] **Step 2: Implement `mocks.ts`**

Walk the tree for the catalog (§4.3 of the spec), producing `MockIR`:
- `patch('mod.attr')` (a `call` whose `function` is `identifier` `patch`, single string arg) → `pattern:'patch'`, `target:{kind:'module', specifier, span}`.
- `patch.object(Thing, 'member'[, **kw])` (a `call` whose `function` is an `attribute` with `attribute` = `object`) → `pattern:'patch-object'`, `target:{kind:'instance-member', exportName: Thing, memberName, span}`. Capture `return_value=`/`side_effect=` kwargs as `ConfiguredValueIR`.
- `Mock(spec=Thing)` / `MagicMock(spec=Thing)` / `create_autospec(Thing)` → `pattern:'autospec'`, `target:{kind:'class', exportName: Thing}`.
- `mocker.patch(...)` / `mocker.Mock(...)` → same as above, reached through a `mocker` parameter binding (record the `mocker` name from the enclosing function's parameters).
- `monkeypatch.setattr(obj, 'attr', v)` → `pattern:'monkeypatch'`, attribute target.
- `m.return_value = X` / `m.side_effect = ...` / `m.member.return_value = X` → member stub + `ConfiguredValueIR{api:'return-value'|'side-effect', value: literalOrNamed(X)}`.

Bindings follow the PHP `scope:name` convention: assign a mock to a local name (e.g. `m = Mock(...)`), then resolve `m.method(...)`/`m.return_value` back to it via nearest-preceding binding. A plain `Mock()`/`MagicMock()` with no `spec` and no target is recorded with `target` undefined (drift-inert).

- [ ] **Step 3: Wire `extractMocks` into `parseModule`**

In `index.ts`, call `extractMocks` and set `module.mocks`; leave `assertions` empty.

- [ ] **Step 4: Run the mocks test**

Run: `npx vitest run packages/parser-python/test/mocks.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add packages/parser-python/src/mocks.ts packages/parser-python/src/index.ts packages/parser-python/test/mocks.test.ts
git commit -m "feat(parser-python): unittest.mock / pytest-mock / monkeypatch detection"
```

---

### Task 5: Assertions + provenance + reachability

**Files:**
- Create: `packages/parser-python/src/assertions.ts`
- Modify: `packages/parser-python/src/index.ts`
- Test: `packages/parser-python/test/assertions.test.ts`

**Interfaces:**
- Consumes: tree helpers (Task 2), `PythonMockState` (Task 4), `AssertionIR`, `ExprIR`, `SourceKind` from `@momus/core`.
- Produces:
  ```ts
  // assertions.ts
  export function extractAssertions(root: SyntaxNode, file: string, state: PythonMockState): AssertionIR[];
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/parser-python/test/assertions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PythonParser } from '../src/index.ts';

const parser = new PythonParser();

describe('PythonParser assertions', () => {
  it('extracts a self-comparison from assert', () => {
    const src = `def test_x():
    x = 1
    assert x == x
`;
    const mod = parser.parseModule('/x/test_x.py', src, { config: undefined, resolveImport: () => null });
    const a = mod.assertions[0]!;
    expect(a.api).toBe('==');
    expect(a.operands).toHaveLength(2);
    expect(a.operands[0]!.text).toBe('x');
    expect(a.operands[1]!.text).toBe('x');
  });

  it('marks a mock return_value operand as mock-config provenance', () => {
    const src = `from unittest.mock import Mock

def test_price():
    m = Mock(spec=Price)
    m.get_price.return_value = 42
    assert m.get_price() == 42
`;
    const mod = parser.parseModule('/x/test_x.py', src, { config: undefined, resolveImport: () => null });
    const a = mod.assertions[0]!;
    expect(a.operands[0]!.provenance).toBe('mock-config');
  });

  it('marks reachable mocks (handed to a SUT call)', () => {
    const src = `from unittest.mock import Mock
from .service import run

def test_run():
    m = Mock(spec=Deps)
    run(m)
`;
    const mod = parser.parseModule('/x/test_x.py', src, { config: undefined, resolveImport: () => null });
    expect(mod.mocks[0]!.invocationSites.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Implement `assertions.ts`**

- For `assert_statement`: if its child is a `comparison_operator` (`==`, `!=`, `is`, `is not`, `in`, `not in`) or `binary_operator`, extract the two operands as `ExprIR` (`kind` from node type: identifier/literal/call/attribute/…, `text` = `node.text`).
- For `assertEqual`/`assertNotEqual`/`assertTrue` calls (unittest), extract the first two args.
- Provenance per operand: resolve the operand text against `state.bindings` — a `m.return_value` / `m.member.return_value` read → `'mock-config'` (with `configuredValue` from the stub); a `m.method()` call → `'mock-call'`; a literal → `'literal'`; a call to an imported SUT function → `'production'`; else `'unknown'`.
- Reachability: mark a mock's `invocationSites` when it appears as an argument to a non-mock call, is returned, or is an assertion operand (mirrors the TS/PHP hand-off rule).

- [ ] **Step 3: Wire `extractAssertions` into `parseModule`**

Set `module.assertions` from `extractAssertions`.

- [ ] **Step 4: Run the assertions test**

Run: `npx vitest run packages/parser-python/test/assertions.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck + full suite, then commit**

```bash
npm run typecheck && npm test
git add packages/parser-python/src/assertions.ts packages/parser-python/src/index.ts packages/parser-python/test/assertions.test.ts
git commit -m "feat(parser-python): assertions, provenance, and reachability"
```

---

### Task 6: Annotated DRIFT-002/003 (type-aware drift on annotated signatures)

**Files:**
- Modify: `packages/parser-python/src/index.ts` (or `symbols.ts`) — set `ConfiguredValueIR.assignable` from annotations
- Test: `packages/parser-python/test/drift.test.ts`

**Interfaces:**
- Consumes: `parseAnnotation` (Task 3), `MockIR.configuredValues` (Task 4), `SymbolIR.signature` (Task 3).

- [ ] **Step 1: Write the failing test**

Create `packages/parser-python/test/drift.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AuditEngine, CompositeParser, DEFAULT_CONFIG } from '@momus/core';
import { PythonParser } from '../src/index.ts';

describe('python drift rules', () => {
  it('DRIFT-001 fires when a patched method does not exist', () => {
    const root = '/x';
    const engine = new AuditEngine({
      root,
      parser: new CompositeParser([new PythonParser()]),
      config: { ...DEFAULT_CONFIG, languages: { typescript: false, php: false, python: true } },
    });
    // fixture repo with Repo.save() in production and patch.object(Repo, 'save2') in test
    const result = engine.run();
    expect(result.issues.some((i) => i.rule === 'DRIFT-001')).toBe(true);
  });

  it('DRIFT-003 fires when a configured return value is not assignable to the annotated return type', () => {
    // production: def price(self) -> int; test: m.price.return_value = "nope"
    const engine = new AuditEngine({ /* …same… */ });
    expect(engine.run().issues.some((i) => i.rule === 'DRIFT-003')).toBe(true);
  });

  it('stays quiet on a healthy annotated twin', () => {
    // production: def price(self) -> int; test: m.price.return_value = 1
    const engine = new AuditEngine({ /* …same… */ });
    const result = engine.run();
    expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Build the drift fixture gallery**

Create `packages/parser-python/test/fixtures/drift/`:
- `repo.py` (production): a `Repo` class with `def save(self, item: "Item") -> int` and `def price(self) -> int`.
- `drift_test.py` (planted): `patch.object(Repo, 'save2', return_value=1)` (missing member) and `m.price.return_value = "nope"` (bad return).
- `healthy_test.py` (control): `patch.object(Repo, 'save', return_value=1)` and `m.price.return_value = 1`.

- [ ] **Step 3: Implement assignability wiring**

Where a `ConfiguredValueIR` is emitted for a member stub, look up the production member's annotated return type (via the resolved `SymbolIR`) and set `assignable` using the existing core assignability rules (`computeReturnAssignability` already runs over IR). When no annotation exists, leave `assignable: 'unknown'` (rules skip with a `SYS-003` note).

- [ ] **Step 4: Run the drift tests**

Run: `npx vitest run packages/parser-python/test/drift.test.ts`
Expected: DRIFT-001 + DRIFT-003 fire; healthy twin is clean.

- [ ] **Step 5: Run typecheck + full suite, then commit**

```bash
npm run typecheck && npm test
git add packages/parser-python/src packages/parser-python/test
git commit -m "feat(parser-python): annotated DRIFT-002/003 drift detection"
```

---

### Task 7: Wiring — CLI/server/doctor/config/schema/release/publish + golden + MCP

**Files:**
- Modify: `packages/cli/src/index.ts`, `packages/server/src/index.ts`
- Modify: `packages/cli/package.json`, `packages/server/package.json`
- Modify: `schemas/momusrc.schema.json`, `release-please-config.json`, `scripts/publish.mjs`
- Modify: `packages/core/src/ir.ts` (MockFramework += `'unittest'|'pytest'`; MockPattern += python patterns)
- Test: `test/golden/audit.test.ts`, `test/integration/mcp.test.ts`

**Interfaces:**
- Consumes: `PythonParser` (Tasks 3–6), `LANGUAGES` (Task 1).

- [ ] **Step 1: Add IR enum members**

In `packages/core/src/ir.ts`: add `'unittest' | 'pytest'` to `MockFramework`; add `'patch' | 'patch-object' | 'autospec' | 'monkeypatch' | 'pytest-mock'` to `MockPattern`. Bump `IR_SCHEMA_VERSION` from `'3'` to `'4'` (comment: python parser extraction).

- [ ] **Step 2: Wire the parser into CLI + server**

In `packages/cli/src/index.ts` `createWorkspaceParser()` and `packages/server/src/index.ts` `createMomusServer()`, change to `new CompositeParser([new TypeScriptParser(), new PhpParser(), new PythonParser()])` and add the `import { PythonParser } from '@momus/parser-python'`. Add `@momus/parser-python: ~0.0.1` to both packages' `dependencies`.

- [ ] **Step 3: Python readiness in `doctor`**

Add `pythonProjectSignals` (pyproject.toml presence + bounded `.py` count) and `pythonReadiness` mirroring `phpProjectSignals`/`phpReadiness` in `packages/cli/src/index.ts`. Extend `runDoctor`'s `languages:` line with `python=…` and print `python readiness:`.

- [ ] **Step 4: Schema + release/publish**

- `schemas/momusrc.schema.json`: add `python` to the `languages` object's properties (boolean, alongside `typescript`/`php`).
- `release-please-config.json`: add a `json`/`$.version` extra-file for `packages/parser-python/package.json`.
- `scripts/publish.mjs`: insert `'@momus/parser-python'` after `'@momus/parser-php'` in `ORDER`.

- [ ] **Step 5: Golden audit test**

Add a python case to `test/golden/audit.test.ts` that audits the `fixtures/drift` gallery and asserts the exact issue set (DRIFT-001 + DRIFT-003 errors, healthy twin quiet).

- [ ] **Step 6: MCP integration round-trip**

Add a case to `test/integration/mcp.test.ts` that constructs the server with `languages.python: true`, runs `verify_mock_drift` / `detect_tautological_assertions` against the python fixture, and asserts the expected findings.

- [ ] **Step 7: Full gate**

Run: `npm run typecheck && npm test && npm run lint && npm run format:check && npm run audit-self`
Expected: all green; self-audit must exclude `packages/parser-python/test/fixtures/**` (add to `.momusrc` ignorePatterns if not already covered).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: wire python language support through CLI, server, doctor, and release tooling"
```

---

### Task 8: Docs/HANDOVER sync + dogfood

**Files:**
- Modify: `docs/02-architecture.md` (§2.2.4), `docs/03-analysis-algorithms.md` (§3.3), `docs/04-mcp-tool-definitions.md`, `docs/06-repository-layout.md`, `docs/07-roadmap.md`, `docs/10-build-plan.md`, `docs/11-real-world-findings.md`, `docs/README.md`
- Modify: `HANDOVER.md` (§8 spec-delta table + a new "Last verified" bullet)

- [ ] **Step 1: Update normative docs**

- `docs/02` §2.2.4: mark Python as shipped (tree-sitter-python + annotations), keep Rust as the remaining candidate.
- `docs/03` §3.3: add Python applicability notes for DRIFT-001/002/003/005 (annotated-only for 002/003).
- `docs/04`: note the tools now advertise Python when enabled.
- `docs/06`: add `parser-python` to the layout + dependency diagram.
- `docs/07` / `docs/10`: mark the Python slice done, list remaining Rust slice.
- `docs/README`: update the status lines.

- [ ] **Step 2: Update HANDOVER.md**

Add a "Last verified" bullet summarizing Python support (registry refactor, parser, mock/assertion catalog, annotated drift, dogfood findings), and update the §8 spec-delta table (e.g. "Language lists → single registry").

- [ ] **Step 3: Dogfood against a real repo (propose candidate first)**

Propose a representative pytest-heavy open-source repo to the user and get confirmation before running. Run `momus audit` against it, record findings + fixed false positives in `docs/11-real-world-findings.md`, and re-run the full gate.

- [ ] **Step 4: Commit**

```bash
git add docs HANDOVER.md
git commit -m "docs: python support in spec, build plan, and handover"
```

---

## Self-Review

**Spec coverage:** §4.1 → Task 1 (registry) + Task 7 Step 1/4 (enums/schema/release); §4.2 → Tasks 2–3 (tree helpers, symbols/imports/kind/framework); §4.3 → Task 4 (mock catalog); §4.4 → Task 5 (assertions/provenance/reachability); §4.5 → Task 6 (annotated drift); §4.6 (pyright seam) → intentionally deferred, no task (recorded in spec); §4.7 → Tasks 6–7 (fixtures/golden/MCP) + Task 8 (dogfood); §4.8 build order → task sequence 1–8. No gap found.

**Placeholder scan:** The only intentionally spike-deferred item is the tree-sitter node-shape details, resolved *by* Task 2 (which produces the committed `tree.ts` cheat-sheet that later tasks consume) — not a placeholder. Tree-sitter dependency versions are pinned by `npm install` at Task 3 Step 1 rather than guessed. No "TBD"/"implement later" strings remain.

**Type consistency:** `LANGUAGES`/`Language`/`languageExtensions`/`allExtensions`/`defaultTestFilePatterns`/`defaultEnabledLanguages` (Task 1) are consumed verbatim by `ir.ts`/`config.ts`/`discovery.ts`. `parsePython`/`walk`/`childField`/`textOf`/`start`/`end` (Task 2) are consumed verbatim by `symbols.ts`/`mocks.ts`/`assertions.ts`. `PythonParser implements LanguageParser` exposes the exact `LanguageParser` methods (`language`, `canParse`, `resolveImport`, `parseModule`). `PythonMockState` (Task 4) is consumed by `extractAssertions` (Task 5). `extractMocks`/`extractAssertions` signatures match their `parseModule` call sites.
