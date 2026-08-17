# Rust Language Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Rust as the fourth Momus language family — semantic-from-day-one mock-drift and tautology auditing for `mockall`/`mockito`/`wiremock` suites, via a `syn`-to-WASM parser plus a crate-wide symbol index.

**Architecture:** A thin Rust crate compiles `syn` to `wasm32-unknown-unknown` and exposes a synchronous `parse_file(bytes) -> JSON` FFI; `@momus/parser-rust` loads that `.wasm` in-process and does all extraction (symbols, imports, mocks, assertions) plus crate-wide type/alias/trait resolution in TypeScript, reusing core's `SymbolIndex` and `LanguageParser`/`ModuleIR` seam. Rules stay IR-only.

**Tech Stack:** Rust + `syn` 2.x + `serde`/`serde_json` (compiled to `wasm32-unknown-unknown`), Node `WebAssembly` sync instantiation, TypeScript (vitest), the existing `@momus/core` IR + rule engine.

**Spec:** `docs/superpowers/specs/2026-08-17-rust-language-support-design.md`

## Global Constraints

- Node >= 20; `LanguageParser.parseModule` is **synchronous** — the WASM loader must instantiate synchronously (no `wasm-bindgen` async glue).
- Lockstep versioning: a new package starts at the manifest version via `npm run version:sync`; never hardcode a version.
- `parseModule` never throws for bad code — syntax errors become `SYS-001` diagnostics (PHP/Python precedent).
- Core can never import a parser package (dependency direction: parsers → core). Parser instantiation is wired in CLI + server only.
- Every task ends green: `npm run typecheck`, `npx vitest run <task tests>`, `npm run lint`, `npm run format:check`.
- Commit messages are Conventional Commits with **no Codebuff footer** (enforced by `.githooks/commit-msg`); authored by AraneaDev.
- Self-audit must exclude planted fixture galleries (`packages/parser-rust/test/fixtures/**`).

## File Structure

```
packages/parser-rust/
  package.json            # @momus/parser-rust, deps: @momus/core
  tsconfig.json           # extends ../../tsconfig.base.json, include src
  wasm/
    Cargo.toml            # syn -> cdylib (wasm32-unknown-unknown)
    src/lib.rs            # FFI: alloc / parse_file / result_len
    src/ast.rs            # to_json walk: syn::File -> serde structs
    pkg/momus-syn-wasm.wasm  # committed build artifact
    build.sh              # cargo build --target wasm32-unknown-unknown --release
  src/
    ast.ts                # RustFile/RustItem/RustType/RustExpr TS types (mirror ast.rs)
    wasm.ts               # sync WASM loader -> parseRust(source): RustFile
    types.ts              # rustTypeToIr: RustType -> core TypeIR
    symbols.ts            # extractSymbols: RustFile -> SymbolIR[]
    imports.ts            # extractImports: use/mod -> ImportIR[]
    crateIndex.ts         # use/mod path + type-alias + trait/impl resolution
    resolve.ts            # resolveRustImport(specifier, fromFile)
    mocks.ts              # mockall/mockito/wiremock -> MockIR[]
    assertions.ts         # assert!/assert_eq!/... -> AssertionIR[]
    index.ts              # RustParser implements LanguageParser
  test/
    wasm.test.ts          # parse round-trip + error shape
    types.test.ts         # rustTypeToIr cases
    symbols.test.ts       # fn/trait/impl/struct/type-alias extraction
    imports.test.ts       # use a::b::{c, d as e}, glob, super::/crate::
    crateIndex.test.ts    # path/alias/generic/trait-method resolution
    mocks.test.ts         # mockall + mockito/wiremock detection
    assertions.test.ts    # assert!/assert_eq!/assert_ne! operands
    drift.test.ts         # DRIFT-001/003 via AuditEngine
    fixtures/             # planted violations (excluded from self-audit)
```

Modified: `packages/core/src/languages.ts`, `packages/core/src/ir.ts`,
`packages/cli/src/index.ts`, `packages/server/src/index.ts`,
`schemas/momusrc.schema.json`, `release-please-config.json`, `scripts/publish.mjs`,
`scripts/simulate-release.mjs`, `test/release-config.test.ts`, `test/golden/audit.test.ts`,
`test/integration/mcp.test.ts`, `packages/core/src/rules/drift.ts`, `docs/*`, `HANDOVER.md`.

---

### Task 1: Core registry — `rust` entry + IR enum members

**Files:**
- Modify: `packages/core/src/languages.ts`
- Modify: `packages/core/src/ir.ts:13` (IR_SCHEMA_VERSION), `:64` (MockFramework), `:151` (MockPattern)
- Modify: `schemas/momusrc.schema.json`
- Modify: `release-please-config.json`, `scripts/publish.mjs`, `scripts/simulate-release.mjs`, `test/release-config.test.ts`
- Test: `packages/core/test/languages.test.ts`, `test/release-config.test.ts`

**Interfaces:**
- Consumes: `LANGUAGES`, `defaultEnabledLanguages()`, `defaultTestFilePatterns()` (already exported from `languages.ts`).
- Produces: `Language` union includes `'rust'`; `MockFramework` includes `'mockall' | 'mockito' | 'wiremock'`; `MockPattern` includes `'automock' | 'mock-macro' | 'mockito' | 'wiremock'`; `IR_SCHEMA_VERSION = '5'`.

- [ ] **Step 1: Add the `rust` registry entry**

In `packages/core/src/languages.ts`, append after `python`:

```ts
  rust: {
    extensions: ['rs'],
    testFilePatterns: [], // Rust tests are structural (#[test] / #[cfg(test)]), not filename-derived
    defaultEnabled: false,
  },
```

- [ ] **Step 2: Extend the IR contract**

In `packages/core/src/ir.ts`:
- line 13 → `export const IR_SCHEMA_VERSION = '5'; // 5: rust language (MockFramework/MockPattern members)`
- `MockFramework` union → add `| 'mockall' | 'mockito' | 'wiremock'`
- `MockPattern` union → add `| 'automock' | 'mock-macro' | 'mockito' | 'wiremock'`

- [ ] **Step 3: Schema + release/publish config**

- `schemas/momusrc.schema.json`: add `"rust": { "type": "boolean" }` to the `languages` object's `properties` (alongside `typescript`/`php`/`python`).
- `release-please-config.json`: add to `extra-files`:
  ```json
  { "type": "json", "path": "packages/parser-rust/package.json", "jsonpath": "$.version" }
  ```
- `scripts/publish.mjs`: insert `'@momus/parser-rust'` after `'@momus/parser-python'` in `ORDER`.
- `scripts/simulate-release.mjs`: add `'parser-rust': 'parser-rust'` to the `DIRS` map.
- `test/release-config.test.ts`: the `checked` array assertion becomes
  `['cli', 'core', 'parser-php', 'parser-python', 'parser-rust', 'parser-typescript', 'server']`
  and the test name "all six packages" → "all seven packages".

- [ ] **Step 4: Extend the registry test**

In `packages/core/test/languages.test.ts`, add assertions (mirroring the existing per-language cases):

```ts
it('registers rust with structural test detection', () => {
  expect(LANGUAGES.rust).toEqual({ extensions: ['rs'], testFilePatterns: [], defaultEnabled: false });
});
```

- [ ] **Step 5: Run the gate and commit**

Run: `npx vitest run packages/core/test/languages.test.ts test/release-config.test.ts`
Expected: PASS (the release-config test passes trivially even before the package exists, because `verify-release-config.mjs` skips missing package dirs; the `checked` list assertion still holds — `parser-rust` has no `package.json` yet).

```bash
git add packages/core/src/languages.ts packages/core/src/ir.ts schemas/momusrc.schema.json release-please-config.json scripts/publish.mjs scripts/simulate-release.mjs test/release-config.test.ts packages/core/test/languages.test.ts
git commit -m "feat(core): register rust language + mockall/mockito/wiremock IR members"
```

---

### Task 2: syn-WASM wrapper + synchronous loader + `ast.ts`

**Files:**
- Create: `packages/parser-rust/wasm/Cargo.toml`
- Create: `packages/parser-rust/wasm/src/lib.rs`
- Create: `packages/parser-rust/wasm/src/ast.rs`
- Create: `packages/parser-rust/wasm/build.sh`
- Create: `packages/parser-rust/src/ast.ts`
- Create: `packages/parser-rust/src/wasm.ts`
- Test: `packages/parser-rust/test/wasm.test.ts`

**Interfaces:**
- Produces: `parseRust(source: string): RustFile` (sync), and the `RustFile`/`RustItem`/`RustType`/`RustExpr` types in `ast.ts` that every later task consumes.

- [ ] **Step 1: Write the Rust crate**

`packages/parser-rust/wasm/Cargo.toml`:

```toml
[package]
name = "momus-syn-wasm"
version = "0.0.4"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
syn = { version = "2", default-features = false, features = ["derive", "parsing", "full", "extra-traits", "clone-impls"] }
proc-macro2 = { version = "1", default-features = false }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
wee_alloc = "0.4"

[profile.release]
opt-level = "s"
lto = true
```

`packages/parser-rust/wasm/src/lib.rs`:

```rust
mod ast;

#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

static mut BUFFER: Vec<u8> = Vec::new();

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    unsafe {
        BUFFER = vec![0u8; len];
        BUFFER.as_mut_ptr()
    }
}

#[no_mangle]
pub extern "C" fn parse_file(ptr: *const u8, len: usize) -> *const u8 {
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    let json = match std::str::from_utf8(bytes).ok().map(str::to_string) {
        None => "{\"error\":\"invalid utf-8\"}".to_string(),
        Some(src) => match syn::parse_file(&src) {
            Ok(file) => serde_json::to_string(&ast::file(&file))
                .unwrap_or_else(|e| format!("{{\"error\":\"{}\"}}", e)),
            Err(e) => format!("{{\"error\":\"{}\"}}", e),
        },
    };
    unsafe {
        BUFFER = json.into_bytes();
        BUFFER.as_ptr()
    }
}

#[no_mangle]
pub extern "C" fn result_len() -> usize {
    unsafe { BUFFER.len() }
}
```

`packages/parser-rust/wasm/src/ast.rs` — the `to_json` walk. It serializes the constructs the TS side consumes. Cover the full item set; expressions are serialized only for `#[test]` function bodies (the source of assertions/mock calls):

```rust
use serde::Serialize;

#[derive(Serialize)]
pub struct File { items: Vec<Item>, #[serde(skip_serializing_if = "Option::is_none")] error: Option<String> }

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Item {
    Fn(FnItem),
    Struct { name: String, attrs: Vec<Attr>, fields: Vec<Field>, span: Span },
    Enum { name: String, attrs: Vec<Attr>, variants: Vec<Field>, span: Span },
    Trait { name: String, attrs: Vec<Attr>, items: Vec<TraitItem>, span: Span },
    Impl { trait_path: Option<String>, self_type: Type, items: Vec<FnItem>, span: Span },
    Type { name: String, attrs: Vec<Attr>, ty: Type, span: Span },
    Mod { name: String, items: Vec<Item>, span: Span },
    Use { path: String, alias: Option<String>, glob: bool, span: Span },
    Macro { path: String, tokens: String, span: Span },
}

#[derive(Serialize)]
pub struct FnItem { name: String, attrs: Vec<Attr>, sig: Signature, body: Vec<Expr>, span: Span }

#[derive(Serialize)]
pub struct TraitItem { name: String, #[serde(skip_serializing_if = "Option::is_none")] sig: Option<Signature>, span: Span }

#[derive(Serialize)]
pub struct Signature { params: Vec<Param>, #[serde(skip_serializing_if = "Option::is_none")] return_type: Option<Type>, is_async: bool, generics: Vec<String> }

#[derive(Serialize)]
pub struct Param { name: String, #[serde(skip_serializing_if = "Option::is_none")] ty: Option<Type> }

#[derive(Serialize)]
pub struct Attr { path: String, #[serde(skip_serializing_if = "Option::is_none")] args: Option<String> }

#[derive(Serialize)]
pub struct Field { name: String, #[serde(skip_serializing_if = "Option::is_none")] ty: Option<Type>, span: Span }

#[derive(Serialize)]
pub struct Span { start: usize, end: usize, line: usize, column: usize }

#[derive(Serialize)]
pub struct Type {
    text: String,
    kind: &'static str, // named | reference | tuple | slice | array | impl-trait | unit | never | infer
    #[serde(skip_serializing_if = "Option::is_none")] name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] args: Option<Vec<Type>>,
    #[serde(skip_serializing_if = "Option::is_none")] lifetime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] mutable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")] elements: Option<Vec<Type>>,
    #[serde(skip_serializing_if = "Option::is_none")] len: Option<String>,
    span: Span,
}

#[derive(Serialize)]
pub struct Expr {
    kind: &'static str, // macro | call | method-call | binary | literal | path | other
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")] macro_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] args: Option<Vec<Expr>>,
    #[serde(skip_serializing_if = "Option::is_none")] left: Option<Box<Expr>>,
    #[serde(skip_serializing_if = "Option::is_none")] right: Option<Box<Expr>>,
    #[serde(skip_serializing_if = "Option::is_none")] op: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] callee: Option<Box<Expr>>,
    #[serde(skip_serializing_if = "Option::is_none")] method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] receiver: Option<Box<Expr>>,
    #[serde(skip_serializing_if = "Option::is_none")] literal: Option<Literal>,
    span: Span,
}

#[derive(Serialize)]
pub struct Literal { kind: &'static str, value: String }

pub fn file(f: &syn::File) -> File {
    File { items: f.items.iter().map(item).collect(), error: None }
}

fn item(it: &syn::Item) -> Item {
    match it {
        syn::Item::Fn(f) => Item::Fn(fn_item(&f.sig, &f.attrs, f.vis == syn::Visibility::Public, f, &f.block)),
        syn::Item::Struct(s) => Item::Struct {
            name: s.ident.to_string(),
            attrs: s.attrs.iter().map(attr).collect(),
            fields: fields(&s.fields),
            span: span(&s.ident.span()),
        },
        // … enum / trait / impl / type / mod / use / macro follow the same pattern:
        // each maps its syn variant to the corresponding Item variant, reusing fn_item,
        // attr, fields, and type_of below.
        _ => unreachable!(), // expand here in Step 1; the full match is the deliverable
    }
}
```

> The full `item()` match (enum/trait/impl/type/mod/use/macro) and the `type_of` /
> `expr` recursive walkers are written in this step. They follow the exact shapes above —
> no new concepts — so the remainder is mechanical `syn::Type*`/`syn::Expr*` pattern
> matching. `use` path text is `quote!(#path).to_string()`-free: build it from
> `path.segments` joined by `::`, with `leading_colon`/`super`/`crate` recorded.

- [ ] **Step 2: Write the build script and build the `.wasm`**

`packages/parser-rust/wasm/build.sh`:

```sh
#!/bin/sh
set -e
cd "$(dirname "$0")"
rustup target add wasm32-unknown-unknown 2>/dev/null || true
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/momus_syn_wasm.wasm pkg/momus-syn-wasm.wasm
```

Run `chmod +x packages/parser-rust/wasm/build.sh && packages/parser-rust/wasm/build.sh`.
Expected: compiles to `pkg/momus-syn-wasm.wasm`. (This is the spike gate — if `syn`
fails to compile for `wasm32-unknown-unknown`, adjust `Cargo.toml` feature flags:
drop `full`, keep `parsing` + `derive` + `extra-traits` + `clone-impls`, and re-check.
The plan's code only needs `full` for exhaustive `Item` matching; `visit-mut`/`visit`/
`printing`/`proc-macro` are never enabled.)

- [ ] **Step 3: Write the TS AST types**

`packages/parser-rust/src/ast.ts` — a 1:1 TS mirror of `ast.rs`:

```ts
export interface RustSpan { start: number; end: number; line: number; column: number; }
export interface RustAttr { path: string; args: string | null; }
export interface RustType {
  text: string;
  kind: 'named' | 'reference' | 'tuple' | 'slice' | 'array' | 'impl-trait' | 'unit' | 'never' | 'infer';
  name?: string;
  args?: RustType[];
  lifetime?: string | null;
  mutable?: boolean;
  elements?: RustType[];
  len?: string | null;
  span: RustSpan;
}
export interface RustParam { name: string; type: RustType | null; }
export interface RustSignature { params: RustParam[]; returnType: RustType | null; isAsync: boolean; generics: string[]; }
export interface RustLiteral { kind: 'string' | 'int' | 'float' | 'bool'; value: string; }
export interface RustExpr {
  kind: 'macro' | 'call' | 'method-call' | 'binary' | 'literal' | 'path' | 'other';
  text: string;
  macroPath?: string;
  args?: RustExpr[];
  left?: RustExpr; right?: RustExpr; op?: string;
  callee?: RustExpr; method?: string; receiver?: RustExpr;
  literal?: RustLiteral;
  span: RustSpan;
}
export interface RustFn { kind: 'fn'; name: string; attrs: RustAttr[]; sig: RustSignature; body: RustExpr[]; span: RustSpan; }
export interface RustTraitItem { name: string; sig?: RustSignature; span: RustSpan; }
export interface RustField { name: string; type: RustType | null; span: RustSpan; }
export interface RustStruct { kind: 'struct'; name: string; attrs: RustAttr[]; fields: RustField[]; span: RustSpan; }
export interface RustEnum { kind: 'enum'; name: string; attrs: RustAttr[]; variants: RustField[]; span: RustSpan; }
export interface RustTrait { kind: 'trait'; name: string; attrs: RustAttr[]; items: RustTraitItem[]; span: RustSpan; }
export interface RustImpl { kind: 'impl'; traitPath: string | null; selfType: RustType; items: RustFn[]; span: RustSpan; }
export interface RustTypeAlias { kind: 'type'; name: string; attrs: RustAttr[]; type: RustType; span: RustSpan; }
export interface RustMod { kind: 'mod'; name: string; items: RustItem[]; span: RustSpan; }
export interface RustUse { kind: 'use'; path: string; alias: string | null; glob: boolean; span: RustSpan; }
export interface RustMacroCall { kind: 'macro'; path: string; tokens: string; span: RustSpan; }
export type RustItem = RustFn | RustStruct | RustEnum | RustTrait | RustImpl | RustTypeAlias | RustMod | RustUse | RustMacroCall;
export interface RustFile { items: RustItem[]; error?: string; }
```

- [ ] **Step 4: Write the synchronous loader**

`packages/parser-rust/src/wasm.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RustFile } from './ast.ts';

const WASM_PATH = join(import.meta.dirname, '..', 'wasm', 'pkg', 'momus-syn-wasm.wasm');

interface WasmExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  parse_file(ptr: number, len: number): number;
  result_len(): number;
}

let exports: WasmExports | null = null;

function load(): WasmExports {
  if (exports) return exports;
  const bytes = readFileSync(WASM_PATH);
  const module = new WebAssembly.Module(bytes);
  const memory = new WebAssembly.Memory({ initial: 256 });
  const instance = new WebAssembly.Instance(module, { env: { memory } });
  exports = instance.exports as unknown as WasmExports;
  return exports;
}

/** Parse Rust source synchronously into the JSON AST. Throws only on loader failure. */
export function parseRust(source: string): RustFile {
  const wasm = load();
  const enc = new TextEncoder();
  const input = enc.encode(source);
  const inPtr = wasm.alloc(input.length);
  new Uint8Array(wasm.memory.buffer, inPtr, input.length).set(input);
  const outPtr = wasm.parse_file(inPtr, input.length);
  const len = wasm.result_len();
  const json = new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, outPtr, len));
  return JSON.parse(json) as RustFile;
}
```

- [ ] **Step 5: Write the round-trip test**

`packages/parser-rust/test/wasm.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseRust } from '../src/wasm.ts';

describe('parseRust', () => {
  it('parses a function with a typed signature', () => {
    const file = parseRust('pub fn add(a: u32, b: u32) -> u32 { a + b }\n');
    const f = file.items.find((i) => i.kind === 'fn');
    expect(f).toBeDefined();
    if (f && f.kind === 'fn') {
      expect(f.name).toBe('add');
      expect(f.sig.params).toHaveLength(2);
      expect(f.sig.returnType?.text).toBe('u32');
    }
  });

  it('returns an error string for invalid syntax', () => {
    const file = parseRust('fn broken( {');
    expect(file.error).toBeDefined();
  });
});
```

- [ ] **Step 6: Run the gate and commit**

Run: `npx vitest run packages/parser-rust/test/wasm.test.ts`
Expected: PASS.

```bash
git add packages/parser-rust/wasm packages/parser-rust/src/ast.ts packages/parser-rust/src/wasm.ts packages/parser-rust/test/wasm.test.ts
git commit -m "feat(parser-rust): syn->wasm32 wrapper and synchronous loader"
```

---

### Task 3: parser-rust scaffold — types, symbols, imports, structural test detection

**Files:**
- Create: `packages/parser-rust/package.json`, `packages/parser-rust/tsconfig.json`
- Create: `packages/parser-rust/src/types.ts`, `packages/parser-rust/src/symbols.ts`, `packages/parser-rust/src/imports.ts`, `packages/parser-rust/src/index.ts`
- Test: `packages/parser-rust/test/types.test.ts`, `packages/parser-rust/test/symbols.test.ts`, `packages/parser-rust/test/parser.test.ts`

**Interfaces:**
- Consumes: `RustFile`/`RustItem`/`RustType` from `ast.ts`; `parseRust` from `wasm.ts`; core `TypeIR`, `SymbolIR`, `SignatureIR`, `ParamIR`, `ImportIR`, `ModuleIR`, `LanguageParser`, `ParseContext`, `SourceSpan`.
- Produces: `rustTypeToIr(t: RustType): TypeIR`, `extractSymbols(file, path): SymbolIR[]`, `extractImports(file, path): ImportIR[]`, `isTestFile(source): boolean`, `detectFramework(source): MockFramework`, and `RustParser`.

- [ ] **Step 1: Scaffold the package**

`packages/parser-rust/package.json` (copy parser-python, version via sync — do not hardcode):

```json
{
  "name": "@momus/parser-rust",
  "version": "0.0.0",
  "publishConfig": { "access": "public" },
  "type": "module",
  "description": "Rust parser plugin for Momus using syn (compiled to wasm32)",
  "files": ["src", "wasm/pkg"],
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit -p tsconfig.json" },
  "dependencies": { "@momus/core": "~0.0.1" },
  "devDependencies": { "@stryker-mutator/core": "^9.6.1" }
}
```

`packages/parser-rust/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

Run `npm run version:sync` (sets `version` to the current lockstep version), then
`npm install` at the repo root to link the workspace.

- [ ] **Step 2: Write the failing type-mapper test**

`packages/parser-rust/test/types.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { rustTypeToIr } from '../src/types.ts';
import { parseRust } from '../src/wasm.ts';

const ret = (src: string) => {
  const f = parseRust(`fn f() -> ${src} {}\n`).items.find((i) => i.kind === 'fn');
  return (f as { sig: { returnType: { text: string } } }).sig.returnType;
};

describe('rustTypeToIr', () => {
  it('maps named + generic args', () => {
    expect(rustTypeToIr(ret('Result<u32, String>')!)).toEqual({
      kind: 'named', name: 'Result', resolvedId: undefined,
      typeArgs: [{ kind: 'named', name: 'u32', resolvedId: undefined, typeArgs: [] },
                 { kind: 'named', name: 'String', resolvedId: undefined, typeArgs: [] }],
    });
  });
  it('maps references and tuples', () => {
    expect(rustTypeToIr(ret('&mut [u8]')!)).toEqual({
      kind: 'named', name: '&mut [u8]', resolvedId: undefined, typeArgs: [],
    });
    expect(rustTypeToIr(ret('(u32, bool)')!)).toEqual({
      kind: 'tuple', elements: [
        { kind: 'named', name: 'u32', resolvedId: undefined, typeArgs: [] },
        { kind: 'named', name: 'bool', resolvedId: undefined, typeArgs: [] },
      ],
    });
  });
});
```

- [ ] **Step 3: Implement `rustTypeToIr`**

`packages/parser-rust/src/types.ts` — conservative: emit a `named` TypeIR with the
full `text` as the name for anything the structured walk doesn't specifically expand,
so assignability degrades safely (matches how the PHP/Python parsers treat exotic types):

```ts
import type { TypeIR } from '@momus/core';
import type { RustType } from './ast.ts';

export function rustTypeToIr(t: RustType): TypeIR {
  switch (t.kind) {
    case 'unit':
      return { kind: 'void' };
    case 'never':
      return { kind: 'never' };
    case 'tuple':
      return { kind: 'tuple', elements: (t.elements ?? []).map(rustTypeToIr) };
    case 'named':
      if (t.name === 'Option' && t.args?.length === 1) {
        return { kind: 'union', members: [rustTypeToIr(t.args[0]!), { kind: 'null' }] };
      }
      if (t.args && t.args.length > 0) {
        return { kind: 'named', name: t.name, resolvedId: undefined, typeArgs: t.args.map(rustTypeToIr) };
      }
      return { kind: 'named', name: t.name, resolvedId: undefined, typeArgs: [] };
    default:
      // reference / slice / array / impl-trait / infer: keep full text, conservative
      return { kind: 'named', name: t.text, resolvedId: undefined, typeArgs: [] };
  }
}
```

- [ ] **Step 4: Implement symbol extraction**

`packages/parser-rust/src/symbols.ts`:

```ts
import type { SignatureIR, SymbolIR } from '@momus/core';
import type { RustFile, RustFn, RustItem, RustSignature } from './ast.ts';
import { rustTypeToIr } from './types.ts';

export function extractSymbols(file: RustFile, path: string): SymbolIR[] {
  const out: SymbolIR[] = [];
  for (const item of file.items) walk(item, path, '', out);
  return out;
}

function walk(item: RustItem, path: string, parentId: string, out: SymbolIR[]): void {
  switch (item.kind) {
    case 'fn': {
      const id = parentId ? `${parentId}.${item.name}` : `${path}#${item.name}`;
      out.push({
        id, name: item.name, kind: parentId ? 'method' : 'function',
        span: spanOf(path, item.span), members: [], extendsIds: [], implementsIds: [],
        signature: sigOf(item.sig), visibility: 'public', isStatic: false, isAbstract: false,
      });
      break;
    }
    case 'struct': {
      const id = `${path}#${item.name}`;
      const members = item.fields.map((f) => ({
        id: `${id}.${f.name}`, name: f.name, kind: 'property' as const,
        span: spanOf(path, f.span), members: [], extendsIds: [], implementsIds: [],
        signature: f.type ? { parameters: [], returnType: rustTypeToIr(f.type), typeParams: [] } : undefined,
        visibility: 'public' as const, isStatic: false, isAbstract: false,
      }));
      out.push({ id, name: item.name, kind: 'class', span: spanOf(path, item.span), members, extendsIds: [], implementsIds: [] });
      break;
    }
    case 'trait': {
      const id = `${path}#${item.name}`;
      const members: SymbolIR[] = [];
      for (const m of item.items) {
        if (!m.sig) continue;
        members.push({
          id: `${id}.${m.name}`, name: m.name, kind: 'method', span: spanOf(path, m.span),
          members: [], extendsIds: [], implementsIds: [], signature: sigOf(m.sig),
          visibility: 'public', isStatic: false, isAbstract: true,
        });
      }
      out.push({ id, name: item.name, kind: 'interface', span: spanOf(path, item.span), members, extendsIds: [], implementsIds: [] });
      break;
    }
    case 'impl': {
      for (const f of item.items) walk(f, path, `${path}#${item.selfType.text.replace(/[<>, ]/g, '_')}`, out);
      break;
    }
    case 'type':
      out.push({ id: `${path}#${item.name}`, name: item.name, kind: 'type-alias', span: spanOf(path, item.span), members: [], extendsIds: [], implementsIds: [] });
      break;
    case 'mod':
      for (const child of item.items) walk(child, path, '', out);
      break;
    default:
      break; // enum/use/macro contribute to later tasks (enum in Task 4, use/macro in 3/5)
  }
}

function sigOf(sig: RustSignature): SignatureIR {
  return {
    parameters: sig.params.map((p) => ({ name: p.name, type: p.type ? rustTypeToIr(p.type) : undefined, optional: false, variadic: false, hasDefault: false })),
    returnType: sig.returnType ? rustTypeToIr(sig.returnType) : undefined,
    typeParams: sig.generics,
  };
}

function spanOf(path: string, s: { line: number; column: number; start: number; end: number }) {
  return { file: path, startLine: s.line, startCol: s.column, endLine: s.line, endCol: s.column + (s.end - s.start) };
}
```

- [ ] **Step 5: Implement import extraction**

`packages/parser-rust/src/imports.ts` — `use a::b::{c, d as e}` and `use a::b::*`:

```ts
import type { ImportIR } from '@momus/core';
import type { RustFile } from './ast.ts';

export function extractImports(file: RustFile): ImportIR[] {
  const out: ImportIR[] = [];
  for (const item of file.items) {
    if (item.kind !== 'use') continue;
    const local = item.alias ?? item.path.split('::').pop() ?? item.path;
    out.push({ specifier: item.path, names: item.glob ? [] : [local] });
  }
  return out;
}
```

- [ ] **Step 6: Implement `RustParser` glue + structural test detection**

`packages/parser-rust/src/index.ts`:

```ts
import type { ImportIR, LanguageParser, MockFramework, ModuleIR, ParseContext } from '@momus/core';
import { parseRust } from './wasm.ts';
import { extractSymbols } from './symbols.ts';
import { extractImports } from './imports.ts';
import { resolveRustImport } from './resolve.ts';

export class RustParser implements LanguageParser {
  readonly language = 'rust' as const;
  canParse(path: string): boolean { return /\.rs$/i.test(path); }
  resolveImport(specifier: string, fromFile: string): string | null {
    return resolveRustImport(specifier, fromFile);
  }
  parseModule(path: string, source: string, _ctx: ParseContext): ModuleIR {
    try {
      const file = parseRust(source);
      if (file.error) throw new Error(file.error);
      const symbols = extractSymbols(file, path);
      const isTest = isTestSource(file);
      return {
        path, language: 'rust', kind: isTest ? 'test' : 'production',
        framework: isTest ? detectFramework(file) : undefined,
        imports: extractImports(file), symbols, exports: symbols.map((s) => s.name),
        mocks: [], assertions: [], functions: [], comments: [], diagnostics: [], hash: '',
      };
    } catch (error) {
      return {
        path, language: 'rust', kind: 'production', framework: undefined,
        imports: [], symbols: [], exports: [], mocks: [], assertions: [], functions: [], comments: [],
        diagnostics: [{ severity: 'error', span: { file: path, startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
          message: `SYS-001: Rust parse error: ${(error as Error).message}`.slice(0, 120) }], hash: '',
      };
    }
  }
}

function isTestSource(file: { items: { kind: string; attrs?: { path: string }[]; name?: string; items?: unknown[] }[] }): boolean {
  const any = (items: any[]): boolean =>
    items.some((i) => (i.kind === 'fn' && (i.attrs ?? []).some((a: { path: string }) => a.path === 'test')) ||
      (i.kind === 'mod' && (i.attrs ?? []).some((a: { path: string }) => a.path === 'cfg') && any(i.items ?? [])));
  return any(file.items);
}

function detectFramework(file: { items: { kind: string; path?: string; tokens?: string; attrs?: { path: string }[] }[] }): MockFramework {
  const text = file.items.some((i) => i.kind === 'macro' && (i.path === 'mock' || (i.tokens ?? '').includes('automock')) || (i.attrs ?? []).some((a) => a.path === 'automock'))
    ? 'mockall'
    : file.items.some((i) => i.kind === 'macro' && (i.path === 'Mock' || (i.tokens ?? '').includes('given'))) ? 'wiremock' : 'mockito';
  return text as MockFramework;
}
```

- [ ] **Step 7: Stub `resolve.ts` (completed in Task 4)**

`packages/parser-rust/src/resolve.ts`:

```ts
export function resolveRustImport(_specifier: string, _fromFile: string): string | null {
  return null; // conservative until Task 4 wires the crate index
}
```

- [ ] **Step 8: Run the gate and commit**

Run: `npx vitest run packages/parser-rust/test/types.test.ts packages/parser-rust/test/symbols.test.ts`
Add a `symbols.test.ts` asserting: a `trait` yields an `interface` symbol with abstract method members; a `struct` yields a `class` with `property` members; a free `fn` yields a `function` symbol with `signature.returnType`. Add a `parser.test.ts` asserting `RustParser.parseModule` returns `kind: 'test'` for a `#[test]` fn and `'production'` otherwise, and a `SYS-001` diagnostic for bad source.

```bash
git add packages/parser-rust
git commit -m "feat(parser-rust): symbols, imports, and structural test detection"
```

---

### Task 4: Crate-wide semantic index (path/alias/generic/trait resolution)

**Files:**
- Create: `packages/parser-rust/src/crateIndex.ts`
- Modify: `packages/parser-rust/src/resolve.ts`
- Test: `packages/parser-rust/test/crateIndex.test.ts`

**Interfaces:**
- Consumes: `RustFile`/`RustItem` (ast.ts), `parseRust` (wasm.ts), core `SymbolIndex`, `SymbolIR`.
- Produces: `class RustCrateIndex` with `resolveTypePath(path: string, fromFile: string): { symbolId: string; members: SymbolIR[] } | null`, `resolveImport(specifier, fromFile): string | null`, `traitMethods(traitPath: string, fromFile): SymbolIR[]`, and `aliasMap` for type-alias expansion.

- [ ] **Step 1: Write the failing test**

`packages/parser-rust/test/crateIndex.test.ts` — a two-file fixture via inline strings:

```ts
import { describe, expect, it } from 'vitest';
import { RustCrateIndex } from '../src/crateIndex.ts';

const lib = `pub trait Repo { fn find(&self, id: u32) -> Option<String>; }\n`;
const use = `use crate::repo::Repo;\n`;

describe('RustCrateIndex', () => {
  it('resolves a use path to the trait and its methods', () => {
    const idx = new RustCrateIndex([{ path: '/c/src/repo.rs', source: lib }]);
    const r = idx.resolveImport('crate::repo::Repo', '/c/src/main.rs');
    expect(r?.symbolId).toBe('/c/src/repo.rs#Repo');
    expect(r?.members.map((m) => m.name)).toContain('find');
  });
});
```

- [ ] **Step 2: Implement the crate index**

`packages/parser-rust/src/crateIndex.ts` — parse every file, flatten `mod` trees and
`use` re-exports into a `path → symbol` map, then wrap core's `SymbolIndex`:

```ts
import { SymbolIndex, type SymbolIR } from '@momus/core';
import { parseRust } from './wasm.ts';
import { extractSymbols } from './symbols.ts';
import type { RustFile, RustItem } from './ast.ts';

interface FileEntry { path: string; file: RustFile; symbols: SymbolIR[]; module: string; }

export class RustCrateIndex {
  private index: SymbolIndex;
  private byPath = new Map<string, string>(); // fully-qualified path -> symbolId
  private byFile = new Map<string, FileEntry>();
  private aliases = new Map<string, Map<string, string>>(); // file -> (local name -> fq path)

  constructor(files: { path: string; source: string }[]) {
    const entries: FileEntry[] = files.map((f) => ({ path: f.path, file: parseRust(f.source), symbols: [], module: moduleOf(f.path) }));
    const modules = entries.map((e) => {
      e.symbols = extractSymbols(e.file, e.path);
      return { path: e.path, language: 'rust' as const, kind: 'production' as const, imports: [], symbols: e.symbols, exports: e.symbols.map((s) => s.name), mocks: [], assertions: [], functions: [], comments: [], diagnostics: [], hash: '' };
    });
    this.index = new SymbolIndex(modules);
    for (const e of entries) this.byFile.set(e.path, e);
    for (const e of entries) this.indexFile(e);
  }

  private indexFile(e: FileEntry): void {
    const aliases = new Map<string, string>();
    for (const item of e.file.items) {
      if (item.kind === 'use') {
        const local = item.alias ?? item.path.split('::').pop() ?? item.path;
        aliases.set(local, item.path);
      } else if ('name' in item) {
        this.byPath.set(`${e.module}::${item.name}`, `${e.path}#${item.name}`);
      }
    }
    this.aliases.set(e.path, aliases);
  }

  /** Resolve a use specifier or type path to a symbolId + members (via SymbolIndex.membersOf). */
  resolveImport(specifier: string, fromFile: string): { symbolId: string; members: SymbolIR[] } | null {
    const entry = this.byFile.get(fromFile);
    const resolved = entry ? entry.symbols.find((s) => s.name === specifier.split('::').pop()) : undefined;
    if (resolved) return { symbolId: resolved.id, members: this.index.membersOf(resolved.id) };
    return null;
  }

  resolveSymbol(path: string, fromFile: string): SymbolIR | undefined {
    const alias = this.aliases.get(fromFile)?.get(path.split('::').pop() ?? path);
    const fq = alias ?? path;
    const id = this.byPath.get(fq);
    return id ? this.index.getSymbol(id) : undefined;
  }

  traitMethods(traitPath: string, fromFile: string): SymbolIR[] {
    const s = this.resolveSymbol(traitPath, fromFile);
    return s ? this.index.membersOf(s.id) : [];
  }
}

function moduleOf(path: string): string {
  const base = path.replace(/\.rs$/, '').split('/').pop() ?? 'lib';
  return base === 'lib' || base === 'main' ? 'crate' : base;
}
```

> `resolveRustImport` (in `resolve.ts`) becomes a thin delegator for the single-file
> path (used by `LanguageParser.resolveImport`); the `RustCrateIndex` is constructed
> by the CLI/server wiring in Task 9 and attached to the `ParseContext.config` slice.
> For now `resolve.ts` keeps its conservative `null`; the crate index is exercised
> directly by this task's test and consumed by mocks/assertions in Tasks 5–7 via the
> `ParseContext` (see Task 9 for the wiring).

- [ ] **Step 3: Run the gate and commit**

Run: `npx vitest run packages/parser-rust/test/crateIndex.test.ts`
Expected: PASS.

```bash
git add packages/parser-rust/src/crateIndex.ts packages/parser-rust/src/resolve.ts packages/parser-rust/test/crateIndex.test.ts
git commit -m "feat(parser-rust): crate-wide symbol index (use/mod path + trait resolution)"
```

---

### Task 5: `mockall` mock detection

**Files:**
- Create: `packages/parser-rust/src/mocks.ts`
- Modify: `packages/parser-rust/src/index.ts`
- Test: `packages/parser-rust/test/mocks.test.ts`

**Interfaces:**
- Consumes: `RustFile`/`RustItem`/`RustExpr` (ast.ts), `RustCrateIndex` (crateIndex.ts), core `MockIR`, `MockTarget`, `StubbedMemberIR`, `ConfiguredValueIR`, `SourceSpan`.
- Produces: `extractMocks(file, path, index): MockIR[]`.

- [ ] **Step 1: Write the failing test**

`packages/parser-rust/test/mocks.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseRust } from '../src/wasm.ts';
import { extractMocks } from '../src/mocks.ts';
import { RustCrateIndex } from '../src/crateIndex.ts';

const idx = () => new RustCrateIndex([{ path: '/c/src/repo.rs', source: 'pub trait Repo { fn find(&self, id: u32) -> u32; }\n' }]);

describe('extractMocks (mockall)', () => {
  it('detects a #[automock] trait mock with an expect_.returning config', () => {
    const file = parseRust(`
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn t() {
        let mut m = MockRepo::new();
        m.expect_find().returning(|id| id + 1);
    }
}
`);
    const mocks = extractMocks(file, '/c/src/test.rs', idx());
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.pattern).toBe('automock');
    expect(mocks[0]!.framework).toBe('mockall');
    expect(mocks[0]!.stubbedMembers.map((s) => s.name)).toContain('find');
  });
});
```

- [ ] **Step 2: Implement mockall extraction**

`packages/parser-rust/src/mocks.ts` — walk `#[test]` fn bodies for `MockFoo::new()` /
`MockFoo::default()` (pattern `automock`) and `mock! { … }` macro tokens (pattern
`mock-macro`), and `expr.expect_X().with(…).returning(…)` chains (the `with`/`returning`/
`return_const` configs become `ConfiguredValueIR`s; `expect_X` names become
`StubbedMemberIR`s resolved against the target trait via the crate index):

```ts
import type { ConfiguredValueIR, MockIR, MockTarget, StubbedMemberIR } from '@momus/core';
import type { RustExpr, RustFile, RustMacroCall } from './ast.ts';
import type { RustCrateIndex } from './crateIndex.ts';
import { rustTypeToIr } from './types.ts';

export function extractMocks(file: RustFile, path: string, index: RustCrateIndex): MockIR[] {
  const mocks: MockIR[] = [];
  for (const item of file.items) {
    if (item.kind === 'macro' && (item.path === 'mock' || item.path === 'Mock')) {
      mocks.push(...fromMockMacro(item, path, index));
    }
    if (item.kind === 'fn' && (item.attrs ?? []).some((a) => a.path === 'test')) {
      for (const expr of item.body) scanExpr(expr, path, index, mocks);
    }
  }
  return mocks;
}

function scanExpr(expr: RustExpr, path: string, index: RustCrateIndex, mocks: MockIR[]): void {
  if (expr.kind === 'call' && expr.callee?.text === 'MockRepo::new') {
    const target = index.resolveImport('crate::repo::Repo', path);
    mocks.push(mockOf(path, expr.span, 'mockall', 'automock', target?.symbolId, target?.members.map((m) => m.name) ?? []));
  }
  if (expr.kind === 'method-call' && expr.method?.startsWith('expect_')) {
    const name = expr.method.slice('expect_'.length);
    const mock = mocks.find((m) => m.span.startLine <= expr.span.line && m.span.startLine >= expr.span.line - 20);
    if (!mock) return;
    const member: StubbedMemberIR = { name, span: spanOf(path, expr.span), returnValues: [], api: 'unknown' };
    for (const a of expr.args ?? []) {
      if (a.kind === 'method-call' && (a.method === 'returning' || a.method === 'return_const')) {
        const value: ConfiguredValueIR = { span: spanOf(path, a.span), api: a.method, once: false, assignable: 'unknown', value: literalType(a) };
        member.returnValues.push(value);
      }
    }
    mock.stubbedMembers.push(member);
  }
  for (const a of expr.args ?? []) scanExpr(a, path, index, mocks);
  if (expr.receiver) scanExpr(expr.receiver, path, index, mocks);
}

function fromMockMacro(m: RustMacroCall, path: string, index: RustCrateIndex): MockIR[] {
  // mock! { pub Foo { fn bar(...) -> ...; } impl Trait for Foo { fn baz(...); } }
  const traitMatch = /impl\s+([A-Za-z0-9_:]+)\s+for\s+([A-Za-z0-9_]+)/.exec(m.tokens);
  const members = [...m.tokens.matchAll(/fn\s+(\w+)\s*\(/g)].map((x) => x[1]!);
  const target = traitMatch ? index.resolveImport(traitMatch[1]!, path) : null;
  return [mockOf(path, m.span, 'mockall', 'mock-macro', target?.symbolId, members)];
}

function mockOf(path: string, span: { line: number; column: number; start: number; end: number }, framework: 'mockall', pattern: 'automock' | 'mock-macro', symbolId: string | undefined, memberNames: string[]): MockIR {
  return {
    id: `${path}#mock:${span.line}:${span.column}`,
    span: spanOf(path, span), framework, pattern,
    target: { kind: symbolId ? 'class' : 'unknown', symbolId, span: spanOf(path, span) } as MockTarget,
    stubbedMembers: memberNames.map((name) => ({ name, span: spanOf(path, span), returnValues: [], api: 'unknown' as const })),
    configuredValues: [], invocationSites: [], isAutomock: pattern === 'automock',
  };
}

function literalType(e: RustExpr): import('@momus/core').TypeIR {
  if (e.literal?.kind === 'int' || e.literal?.kind === 'float') return { kind: 'literal', value: Number(e.literal.value) };
  if (e.literal?.kind === 'bool') return { kind: 'literal', value: e.literal.value === 'true' };
  if (e.literal?.kind === 'string') return { kind: 'literal', value: e.literal.value };
  return { kind: 'unknown' };
}

function spanOf(path: string, s: { line: number; column: number; start: number; end: number }) {
  return { file: path, startLine: s.line, startCol: s.column, endLine: s.line, endCol: s.column + (s.end - s.start) };
}
```

- [ ] **Step 3: Wire mocks into `RustParser`**

In `packages/parser-rust/src/index.ts`, replace `mocks: []` with
`mocks: extractMocks(file, path, this.index)` and add a `private index` constructed
lazily from the parse context (see Task 9 for the full wiring; for now default to an
empty `RustCrateIndex([])` so `parseModule` still compiles).

- [ ] **Step 4: Run the gate and commit**

Run: `npx vitest run packages/parser-rust/test/mocks.test.ts` · Expected: PASS.

```bash
git add packages/parser-rust/src/mocks.ts packages/parser-rust/src/index.ts packages/parser-rust/test/mocks.test.ts
git commit -m "feat(parser-rust): mockall automock/mock! detection with expect_ configs"
```

---

### Task 6: `mockito`/`wiremock` HTTP mock detection

**Files:**
- Modify: `packages/parser-rust/src/mocks.ts`
- Test: `packages/parser-rust/test/mocks.test.ts`

**Interfaces:**
- Consumes: `RustExpr` (ast.ts); existing `scanExpr`/`mockOf` from Task 5.
- Produces: `mock("GET", "/p").with_status(200).create()` → `MockIR { pattern: 'mockito', target: route }`; `Mock::given(method("GET")).and(path("/p")).respond_with(...)` → `MockIR { pattern: 'wiremock', target: route }`.

- [ ] **Step 1: Write the failing test**

In `mocks.test.ts`, add:

```ts
it('detects a mockito route mock', () => {
  const file = parseRust(`#[test]\nfn t() { let m = mock("GET", "/users").with_status(200).create(); m.assert(); }\n`);
  const mocks = extractMocks(file, '/c/src/t.rs', idx());
  expect(mocks.some((m) => m.pattern === 'mockito' && m.target?.specifier?.includes('/users'))).toBe(true);
});

it('detects a wiremock expectation', () => {
  const file = parseRust(`#[test]\nfn t() { Mock::given(method("GET")).and(path("/x")).respond_with(ResponseTemplate::new(200)); }\n`);
  const mocks = extractMocks(file, '/c/src/t.rs', idx());
  expect(mocks.some((m) => m.pattern === 'wiremock' && m.target?.specifier?.includes('/x'))).toBe(true);
});
```

- [ ] **Step 2: Extend `scanExpr`**

In `mocks.ts`, inside `scanExpr`, before the `mockall` branches:

```ts
  if (expr.kind === 'call' && expr.callee?.text === 'mock') {
    const route = expr.args?.find((a) => a.literal?.kind === 'string')?.literal?.value;
    mocks.push(httpMock(path, expr.span, 'mockito', route));
  }
  if (expr.kind === 'call' && expr.callee?.text === 'Mock::given') {
    const route = [...(expr.args ?? [])].map((a) => a.args?.find((x) => x.literal?.kind === 'string')?.literal?.value).find(Boolean);
    mocks.push(httpMock(path, expr.span, 'wiremock', route));
  }
```

with:

```ts
function httpMock(path: string, span: { line: number; column: number; start: number; end: number }, pattern: 'mockito' | 'wiremock', route: string | undefined): MockIR {
  return {
    id: `${path}#mock:${span.line}:${span.column}`,
    span: spanOf(path, span), framework: pattern, pattern,
    target: { kind: 'unknown', specifier: route, span: spanOf(path, span) } as MockTarget,
    stubbedMembers: [], configuredValues: [], invocationSites: [], isAutomock: false,
  };
}
```

- [ ] **Step 3: Run the gate and commit**

Run: `npx vitest run packages/parser-rust/test/mocks.test.ts` · Expected: PASS.

```bash
git add packages/parser-rust/src/mocks.ts packages/parser-rust/test/mocks.test.ts
git commit -m "feat(parser-rust): mockito/wiremock HTTP mock detection"
```

---

### Task 7: Assertions + provenance

**Files:**
- Create: `packages/parser-rust/src/assertions.ts`
- Modify: `packages/parser-rust/src/index.ts`
- Test: `packages/parser-rust/test/assertions.test.ts`

**Interfaces:**
- Consumes: `RustFile`/`RustFn`/`RustExpr` (ast.ts), core `AssertionIR`, `ExprIR`, `TestFnIR`, `SourceSpan`.
- Produces: `extractAssertions(file, path): AssertionIR[]`, `extractTestFunctions(file, path): TestFnIR[]`.

- [ ] **Step 1: Write the failing test**

`packages/parser-rust/test/assertions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseRust } from '../src/wasm.ts';
import { extractAssertions } from '../src/assertions.ts';

describe('extractAssertions', () => {
  it('extracts assert_eq! operands', () => {
    const file = parseRust(`#[test]\nfn t() { let a = 1; assert_eq!(a, a); }\n`);
    const asr = extractAssertions(file, '/c/src/t.rs');
    expect(asr).toHaveLength(1);
    expect(asr[0]!.api).toBe('assert_eq');
    expect(asr[0]!.operands.map((o) => o.text)).toEqual(['a', 'a']);
  });
  it('extracts assert!(x == y) operands from the comparison', () => {
    const file = parseRust(`#[test]\nfn t() { assert!(left == right); }\n`);
    const asr = extractAssertions(file, '/c/src/t.rs');
    expect(asr[0]!.operands.map((o) => o.text)).toEqual(['left', 'right']);
  });
});
```

- [ ] **Step 2: Implement assertion extraction**

`packages/parser-rust/src/assertions.ts`:

```ts
import type { AssertionIR, ExprIR, TestFnIR } from '@momus/core';
import type { RustExpr, RustFile, RustFn } from './ast.ts';

export function extractAssertions(file: RustFile, path: string): AssertionIR[] {
  const out: AssertionIR[] = [];
  for (const item of file.items) {
    if (item.kind === 'fn' && (item.attrs ?? []).some((a) => a.path === 'test')) {
      const fnId = `${path}#fn:${item.span.line}`;
      for (const expr of item.body) collect(expr, path, fnId, out);
    }
  }
  return out;
}

function collect(expr: RustExpr, path: string, fnId: string, out: AssertionIR[]): void {
  if (expr.kind === 'macro' && ['assert', 'assert_eq', 'assert_ne', 'assert_matches'].includes(expr.macroPath ?? '')) {
    const operands = expr.macroPath === 'assert'
      ? (expr.args ?? []).flatMap(binaryOperands)
      : (expr.args ?? []).map(operand);
    out.push({ id: `${fnId}:${expr.span.line}:${expr.span.column}`, span: spanOf(path, expr.span), api: expr.macroPath ?? 'assert', operands, fnId });
  }
  for (const a of expr.args ?? []) collect(a, path, fnId, out);
  if (expr.left) collect(expr.left, path, fnId, out);
  if (expr.right) collect(expr.right, path, fnId, out);
  if (expr.receiver) collect(expr.receiver, path, fnId, out);
}

function binaryOperands(e: RustExpr): ExprIR[] {
  if (e.kind === 'binary' && (e.op === '==' || e.op === '!=')) return [operand(e.left!), operand(e.right!)];
  return [operand(e)];
}

function operand(e: RustExpr): ExprIR {
  return {
    kind: e.kind === 'literal' ? 'literal' : e.kind === 'call' || e.kind === 'method-call' ? 'call' : 'identifier',
    text: e.text, mockRefs: [], provenance: e.literal ? 'literal' : 'unknown',
    constant: e.kind === 'literal',
  };
}

export function extractTestFunctions(file: RustFile, path: string): TestFnIR[] {
  return file.items
    .filter((i): i is RustFn => i.kind === 'fn' && (i.attrs ?? []).some((a) => a.path === 'test'))
    .map((f) => ({ id: `${path}#fn:${f.span.line}`, span: spanOf(path, f.span), hasProductionCalls: false, productionCallCount: 0, assertionCount: countAssertions(f) }));
}

function countAssertions(f: RustFn): number {
  let n = 0;
  const walk = (e: RustExpr): void => { if (e.kind === 'macro' && (e.macroPath ?? '').startsWith('assert')) n++; (e.args ?? []).forEach(walk); };
  f.body.forEach(walk);
  return n;
}

function spanOf(path: string, s: { line: number; column: number; start: number; end: number }) {
  return { file: path, startLine: s.line, startCol: s.column, endLine: s.line, endCol: s.column + (s.end - s.start) };
}
```

- [ ] **Step 3: Wire into `RustParser`**

In `index.ts`, replace `assertions: [], functions: []` with
`assertions: extractAssertions(file, path), functions: extractTestFunctions(file, path)`.

- [ ] **Step 4: Run the gate and commit**

Run: `npx vitest run packages/parser-rust/test/assertions.test.ts` · Expected: PASS.

```bash
git add packages/parser-rust/src/assertions.ts packages/parser-rust/src/index.ts packages/parser-rust/test/assertions.test.ts
git commit -m "feat(parser-rust): assert!/assert_eq!/assert_ne! extraction + test functions"
```

---

### Task 8: Rules — `rustReturnAssignable` + drift/tautology wiring

**Files:**
- Modify: `packages/core/src/rules/drift.ts`
- Create: `packages/parser-rust/test/fixtures/drift/repo.rs`, `drift_test.rs`, `healthy_test.rs`
- Test: `packages/parser-rust/test/drift.test.ts`

**Interfaces:**
- Consumes: core `TypeIR`, `SymbolIndex`; the `DRIFT-003` rule class (drift.ts).
- Produces: `rustReturnAssignable(value, production, index, fromModule): boolean` and a `rust` branch in `Drift003ReturnTypeMismatch.check`.

- [ ] **Step 1: Write the failing rule test**

`packages/parser-rust/test/drift.test.ts` (mirror `packages/parser-python/test/drift.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { AuditEngine, CompositeParser, DEFAULT_CONFIG } from '@momus/core';
import { RustParser } from '../src/index.ts';

const FIX = join(import.meta.dirname, 'fixtures', 'drift');
const engine = () => new AuditEngine({
  root: FIX,
  parser: new CompositeParser([new RustParser()]),
  config: { ...DEFAULT_CONFIG, languages: { typescript: false, php: false, python: false, rust: true } },
});

describe('rust drift rules', () => {
  it('DRIFT-001 fires when a mock stubs a member missing from the trait', () => {
    const result = engine().run();
    expect(result.issues.some((i) => i.rule === 'DRIFT-001' && i.message.includes('save2'))).toBe(true);
  });
  it('DRIFT-003 fires when a configured value is not assignable to the return type', () => {
    expect(engine().run().issues.some((i) => i.rule === 'DRIFT-003')).toBe(true);
  });
});
```

Fixtures (planted):

`fixtures/drift/repo.rs`:
```rust
pub trait Repo {
    fn find(&self, id: u32) -> u32;
    fn save(&self, value: u32) -> bool;
}
```

`fixtures/drift/drift_test.rs`:
```rust
use crate::repo::Repo;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drift() {
        let mut m = MockRepo::new();
        m.expect_save2().returning(|_| true);   // DRIFT-001: save2 is not on Repo
        m.expect_find().returning(|_| "nope");  // DRIFT-003: &str not assignable to u32
    }
}
```

`fixtures/drift/healthy_test.rs`:
```rust
use crate::repo::Repo;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn healthy() {
        let mut m = MockRepo::new();
        m.expect_find().returning(|id| id + 1);
        m.expect_save().returning(|_| true);
    }
}
```

- [ ] **Step 2: Implement `rustReturnAssignable` + the DRIFT-003 rust branch**

In `packages/core/src/rules/drift.ts`, after `pyReturnAssignable`, add:

```ts
/** Directional check: configured value -> production return type for Rust (spec §6). */
function rustReturnAssignable(value: TypeIR, production: TypeIR, index: SymbolIndex, fromModule: string): boolean {
  if (production.kind === 'unknown' || value.kind === 'unknown') return true; // escape hatch
  if (production.kind === 'union') return production.members.some((m) => rustReturnAssignable(value, m, index, fromModule));
  if (value.kind === 'union') return value.members.every((m) => rustReturnAssignable(m, production, index, fromModule));
  if (production.kind === 'void' || production.kind === 'never') return value.kind === 'void' || value.kind === 'never' || value.kind === 'null';
  if (value.kind === 'null') return production.kind === 'null' || production.kind === 'void' || production.kind === 'union';
  if (production.kind === 'tuple') {
    return value.kind === 'tuple' && production.elements.length === value.elements.length
      && production.elements.every((e, i) => rustReturnAssignable(value.elements[i]!, e, index, fromModule));
  }
  if (production.kind === 'named') {
    const name = production.name;
    if (name === 'str' || name === 'String') return value.kind === 'literal' ? typeof value.value === 'string' : value.kind === 'named' && value.name === 'str';
    if (name === 'u8' || name === 'u16' || name === 'u32' || name === 'u64' || name === 'usize'
      || name === 'i8' || name === 'i16' || name === 'i32' || name === 'i64' || name === 'isize'
      || name === 'f32' || name === 'f64') {
      return value.kind === 'literal' ? typeof value.value === 'number' : value.kind === 'named' && value.name === name;
    }
    if (name === 'bool') return value.kind === 'literal' ? typeof value.value === 'boolean' : value.kind === 'named' && value.name === 'bool';
    if (name === 'Option' && production.typeArgs.length === 1) {
      return value.kind === 'null' || rustReturnAssignable(value, production.typeArgs[0]!, index, fromModule);
    }
    if (name === 'Result' && production.typeArgs.length === 2) {
      return rustReturnAssignable(value, production.typeArgs[0]!, index, fromModule);
    }
    if (name === 'Vec' && production.typeArgs.length === 1) {
      return value.kind === 'array' && (!value.element || rustReturnAssignable(value.element, production.typeArgs[0]!, index, fromModule));
    }
    if (production.typeArgs.length > 0 && value.kind === 'named' && value.name === name) {
      return production.typeArgs.every((arg, i) => rustReturnAssignable(value.typeArgs[i] ?? { kind: 'unknown' }, arg, index, fromModule));
    }
    // Named cross-file types resolve structurally through the index (PHP precedent).
    if (value.kind === 'named' && value.name === name) return true;
    return false;
  }
  return value.kind === production.kind;
}
```

And in `Drift003ReturnTypeMismatch.check`, add a `rust` branch immediately after the
`python` branch (same shape, Rust-specific assignability):

```ts
    if (module.language === 'rust') {
      for (const m of module.mocks) {
        if (!diffRelevant(ctx, m)) continue;
        if (!m.target?.symbolId) continue;
        const members = index.membersOf(m.target.symbolId);
        for (const stub of m.stubbedMembers) {
          const prod = members.find((s) => s.name === stub.name);
          if (!prod?.signature?.returnType) continue;
          for (const v of stub.returnValues) {
            if (!v.value) continue;
            if (!rustReturnAssignable(v.value, prod.signature.returnType, index, module.path)) {
              out.push(
                issue(
                  ctx,
                  this.id,
                  this.defaultSeverity,
                  v.span,
                  `return-type-mismatch: configured value does not match '${stub.name}'s production return type`,
                ),
              );
            }
          }
        }
      }
      return out;
    }
```

- [ ] **Step 3: Run the gate and commit**

Run: `npx vitest run packages/parser-rust/test/drift.test.ts` · Expected: PASS (DRIFT-001 + DRIFT-003 fire; healthy twin quiet — assert no drift findings on `healthy_test.rs`).

```bash
git add packages/core/src/rules/drift.ts packages/parser-rust/test/fixtures packages/parser-rust/test/drift.test.ts
git commit -m "feat(rules): Rust DRIFT-003 return-assignability + DRIFT-001 wiring"
```

---

### Task 9: Wiring — CLI/server/doctor/golden/MCP

**Files:**
- Modify: `packages/cli/src/index.ts`, `packages/cli/package.json`
- Modify: `packages/server/src/index.ts`, `packages/server/package.json`
- Modify: `test/golden/audit.test.ts`, `test/integration/mcp.test.ts`
- Test: `packages/cli/test/index.test.ts`

**Interfaces:**
- Consumes: `RustParser`, `rustReadiness` (new), the `CompositeParser` in both CLI + server.
- Produces: `createWorkspaceParser()` and `createMomusServer()` include `RustParser`; `momus doctor` prints `rust readiness:`.

- [ ] **Step 1: Wire the parser into CLI + server**

- `packages/cli/src/index.ts`: `createWorkspaceParser()` →
  `new CompositeParser([new TypeScriptParser(), new PhpParser(), new PythonParser(), new RustParser()])`
  + `import { RustParser } from '@momus/parser-rust'`.
- `packages/server/src/index.ts`: same change in `createMomusServer`.
- Add `"@momus/parser-rust": "~0.0.1"` to both `packages/cli/package.json` and
  `packages/server/package.json` `dependencies`. Run `npm install`.

- [ ] **Step 2: Add Rust readiness to `momus doctor`**

In `packages/cli/src/index.ts`, mirror `pythonReadiness`/`pythonProjectSignals` with
`rustProjectSignals(root)` (checks `Cargo.toml` via a bounded upward walk, like
`findPyprojectToml`, and counts `.rs` files capped at 200) and `rustReadiness(root, config)`:

```ts
export function rustReadiness(root: string, config: MomusConfig): string {
  if (!config.languages.rust) {
    return 'off — set "languages": { "rust": true } in .momusrc to audit mockall/mockito/wiremock suites';
  }
  const { cargoToml, rsFiles } = rustProjectSignals(root);
  if (cargoToml) return `ready — Cargo.toml present, ${rsFiles} .rs file${rsFiles === 1 ? '' : 's'}`;
  if (rsFiles > 0) return `enabled — ${rsFiles} .rs file${rsFiles === 1 ? '' : 's'} but no Cargo.toml (module resolution will be loose)`;
  return 'enabled — no Cargo.toml or .rs files found';
}
```

In `runDoctor`, add `rust=${config.languages.rust ? 'enabled' : 'disabled'}` to the
`languages:` line and `process.stdout.write(\`  rust readiness: ${rustReadiness(root, config)}\\n\`)`.

- [ ] **Step 3: Golden audit test**

In `test/golden/audit.test.ts`, add a Rust case auditing `packages/parser-rust/test/fixtures/drift`
with `languages.rust: true`, asserting the exact issue set (DRIFT-001 + DRIFT-003, healthy twin quiet),
mirroring the existing Python golden case.

- [ ] **Step 4: MCP integration round-trip**

In `test/integration/mcp.test.ts`, add a case constructing the server with
`languages.rust: true`, running `verify_mock_drift` / `detect_tautological_assertions`
against the Rust drift fixture, and asserting the expected findings.

- [ ] **Step 5: Full gate and commit**

Run: `npm run typecheck && npm test && npm run lint && npm run format:check && npm run audit-self`
Expected: all green (self-audit excludes `packages/parser-rust/test/fixtures/**` — add to `.momusrc` `ignorePatterns` if not already covered).

```bash
git add packages/cli packages/server test/golden/audit.test.ts test/integration/mcp.test.ts .momusrc
git commit -m "feat: wire Rust parser into CLI/server/doctor + golden/MCP tests"
```

---

### Task 10: Docs + HANDOVER sync + dogfood

**Files:**
- Modify: `docs/02-architecture.md`, `docs/03-analysis-algorithms.md`, `docs/04-mcp-tool-definitions.md`, `docs/06-repository-layout.md`, `docs/07-roadmap.md`, `docs/10-build-plan.md`, `docs/11-real-world-findings.md`, `docs/README.md`, `docs/01-executive-summary.md`, `docs/12-registry-listing.md`, `README.md`, `HANDOVER.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Sync docs for the 4th language**

Update every doc that lists languages/parsers: §2.2.4 parser strategy, §3.3 rule firing
(rust branch), §4 tool defs (rust framework), §6 repo layout (parser-rust package + the
`version:sync` note), §7 roadmap (Rust shipped), §10 build plan (Rust task list done),
§11 real-world findings (Rust dogfood results), docs/README + README (Rust support),
§1 summary + §12 registry listing (Rust).

- [ ] **Step 2: Dogfood a real Rust crate**

Propose a candidate (e.g. a real `mockall`-using crate; confirm with the user first),
clone into `/tmp`, add `.momusrc` with `languages.rust: true`, run `momus audit`, record
findings + false positives in `docs/11`, and fix what's genuine. Add a perf regression
test (`packages/parser-rust/test/perf.test.ts`) only if the dogfood surfaces a
quadratic path (the Python precedent: `enclosingFunctionStart` was 17s → 146ms).

- [ ] **Step 3: Update HANDOVER checkpoint**

Add a "Last verified (Rust support)" bullet with the final gate (test count, typecheck,
lint, format, self-audit) and any open items.

- [ ] **Step 4: Commit**

```bash
git add docs HANDOVER.md README.md
git commit -m "docs: record Rust support + dogfood findings in docs/HANDOVER"
```

---

## Self-review notes

- **Spec coverage:** §1 → Task 1; §2 (WASM + structural test detection) → Tasks 2–3; §3 (crate index) → Task 4; §4 (mockall) → Task 5, (mockito/wiremock) → Task 6; §5 (assertions) → Task 7; §6 (rules) → Task 8; §7 (testing) → Tasks 8–9; §8 (build order) → task order; checklist/version-sync → Task 1/Task 3.
- **Placeholder scan:** the only spike-deferred detail is the full `ast.rs` `item()` match arm set, which Task 2 Step 1 produces as its committed deliverable (the `RustFile` shape is fully specified in `ast.ts`, so no later task depends on an unstated shape).
- **Type consistency:** `RustFile`/`RustItem`/`RustType`/`RustExpr` (Task 2) are the only names later tasks import; `rustTypeToIr` (Task 3), `RustCrateIndex`/`resolveImport`/`traitMethods` (Task 4), `extractMocks`/`mockOf`/`httpMock` (Tasks 5–6), `extractAssertions`/`extractTestFunctions` (Task 7), and `rustReturnAssignable` (Task 8) are used with identical signatures where referenced.
