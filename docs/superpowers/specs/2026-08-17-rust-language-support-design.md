# Rust language support — design

**Date:** 2026-08-17 · **Status:** approved for planning · **Branch:** `feat/rust-support`

Rust is the fourth language family for Momus, after TypeScript, PHP, and Python. This
spec captures the decisions and the §1–§8 design that follows from them. It is the
normative input to the `writing-plans` step; implementation does not begin until the
written spec is user-reviewed.

## 1. Decisions (locked)

1. **Type depth — semantic from day one.** Unlike Python (annotations-first, pyright
   deferred), Rust signatures are ~always annotated, so the v1 pass resolves types
   semantically: cross-item type aliases, generics, and trait/`impl` method signatures.
   No `SYS-003`-style "syntax only" fallback for *in-workspace* types; it is reserved
   for external-crate types (see §3).

2. **Semantic backend — `syn` + crate-wide index.** No external compiler/LSP. Every
   `.rs` file is parsed with `syn`, and a TypeScript crate index resolves `use`/`mod`
   paths, type aliases, generics, and trait/`impl` methods, reusing core's `SymbolIndex`.

3. **Scope — `mockall` + `mockito`/`wiremock`.** Trait/struct mocks (`mockall`) and HTTP
   mocks (`mockito`/`wiremock`). Test detection is structural (`#[test]` / `#[cfg(test)]`),
   assertions are `assert!` / `assert_eq!` / `assert_ne!` / `assert_matches!`.

4. **Delivery — `syn` via WASM.** A thin Rust wrapper compiles `syn` to `wasm32` and
   exposes `parseFile(source) → JSON AST`; it is loaded in-process by the Node parser.

5. **Architecture — thin WASM, fat TS.** The WASM blob only parses and serializes; all
   extraction, mock detection, and crate indexing live in `@momus/parser-rust` TypeScript,
   mirroring how every existing parser does its extraction in TS.

## 2. Design

### §1. Core stays N-language (minimal)

- `packages/core/src/languages.ts` gains:
  ```ts
  rust: { extensions: ['rs'], testFilePatterns: [], defaultEnabled: false },
  ```
  `testFilePatterns` is empty because Rust tests are **structural** (inline
  `#[cfg(test)] mod tests` and `tests/*.rs`), not filename-derived — test/production
  detection happens per-item in the parser, not in `discovery.ts`. `Language` =
  `keyof typeof LANGUAGES` extends automatically; `MomusConfig.languages` =
  `Record<Language, boolean>`; `DEFAULT_CONFIG.testFilePatterns` and the discovery
  extension regex derive from the registry (no hand-maintained lists).
- `MockFramework` += `'mockall' | 'mockito' | 'wiremock'`; `MockPattern` +=
  `'automock' | 'mock-macro' | 'mockito' | 'wiremock'` (flat IR contract unions — they
  describe frameworks/patterns, not languages).
- `IR_SCHEMA_VERSION` bump (4 → 5). `schemas/momusrc.schema.json` gains a `rust` boolean.
- `doctor` gains Rust-readiness mirroring `phpReadiness`/python readiness: the
  `languages.rust` gate, `Cargo.toml` presence, WASM wrapper availability, and a bounded
  `.rs` count.
- Release/publish: `release-please-config.json` `extra-files` +=
  `packages/parser-rust/package.json`; `scripts/publish.mjs` ORDER += `@momus/parser-rust`.
  (The `scripts/sync-versions.mjs` pre-commit hook keeps the new package at the current
  lockstep version — no hardcoded version.)

### §2. `@momus/parser-rust` + thin syn-WASM

- New workspace `packages/parser-rust` implementing `LanguageParser` (core types only),
  mirroring `parser-php`/`parser-python`. `canParse` `/\.rs$/i`.
- A small Rust crate (in `packages/parser-rust/wasm/`) compiles `syn` to
  `wasm32-unknown-unknown` and exposes `parseFile(source: &str) -> String` returning a
  **syn-faithful JSON AST**. `syn` types do not implement `Serialize`, so the wrapper
  ships a hand-written `to_json` walk covering: items (`fn`/`struct`/`enum`/`trait`/
  `impl`/`type`/`mod`/`use`/`macro`), signatures, types, attributes, and the expression
  trees of `#[test]` functions (the only expressions we need for assertions/mock calls).
- Test detection is per-item: a `fn` carrying `#[test]` or nested inside a `#[cfg(test)]`
  `mod` is a test; everything else is production. This feeds `ModuleIR` test/production
  provenance the same way filename patterns do for TS/PHP/Python.
- `resolveImport` resolves `use`/`mod` specifiers through the crate index (§3);
  conservative → `null` when the target is external or ambiguous.

### §3. Crate-wide semantic index

The "semantic from day one" heart. After parsing every `.rs` file reachable from
`Cargo.toml` (`[workspace] members` + the `mod` tree), the parser builds a crate symbol
index reusing core's `SymbolIndex`:

- Resolve `use a::b::{c, d as e}` aliases (PHP `use … as` precedent) and `mod` paths.
- Map `crate::module::Type` / `module::Type` / `self::` / `super::` paths → `symbolId`.
- Expand type aliases (`type Id = u32`) and resolve generic parameters/bounds into
  `SignatureIR` type text so DRIFT-002/003 see concrete signatures.
- Collect trait + `impl` method signatures (including supertraits) so a mock's target
  trait/struct is fully known for DRIFT-001/002/003.

**Honest boundary:** traits/types from external crates (`std`, `tokio`, `serde`,
third-party) that are not in the workspace are unresolvable → the affected finding is
skipped with `SYS-003`, exactly like Python's unannotated path. This is the only
degradation in v1.

### §4. Mock detection → MockIR

**`mockall` (trait/struct mocks):**

- `#[automock]` on a `trait`/`impl` and the `mock!` DSL are the two mock definitions.
  `syn` does **not** expand proc-macros, so the `mock!` token stream is parsed with a
  hand-modeled grammar:
  ```rust
  mock! {
      pub Foo {
          fn bar(&self, x: u32) -> u32;
      }
      impl Trait for Foo {
          fn baz(&self) -> i32;
      }
  }
  ```
  → `MockIR` targeting the trait/struct (resolved through §3), with `StubbedMemberIR`
  members for each `fn`.
- Construction: `MockFoo::new()` / `MockFoo::default()`.
- Config: `expect_method().with(predicate::eq(1)).returning(|x| x + 1)` /
  `.return_const(5)` / `.returning(…)`, plus `.times(n)` / `.once()` → `ConfiguredValueIR`
  (DRIFT-003 input); `.with(…)` predicates are mock-call metadata.

**`mockito` (HTTP):** `mock("GET", "/p").with_status(200).create()` →
`MockIR { pattern: 'mockito', target: route }`; `.assert()` / `.assert_async()` mark the
mock exercised.

**`wiremock` (HTTP):** `Mock::given(method("GET")).and(path("/p")).respond_with(…)`
mounted on a `MockServer` → `MockIR { pattern: 'wiremock', target: route }`;
`server.received_requests()…assert(…)` / `request_count(…)` mark it exercised.

### §5. Assertions + provenance

- `assert!(expr)` — operands extracted from the binary comparison (`==`/`!=`) when the
  body is one; otherwise conservative (`unknown`).
- `assert_eq!(l, r)` / `assert_ne!(l, r)` — operands are the two token args.
- `assert_matches!(x, pat)` — metadata-only (no operand comparison).
- `#[should_panic(expected = "…")]` — metadata (the `pytest.raises` analogue).
- TAUT-001 self-comparison: `assert_eq!(a, a)`, `assert!(x == x)`.
- Provenance reuses the existing `SourceKind`: mock config → `mock-config`, `.assert()` /
  `received_requests()` → `mock-call`, SUT calls → `production`, literals → `literal`;
  reachability marks mocks handed to SUT calls/returns/assertions (TAUT-005/006).

### §6. Rule mapping (no new rule-engine code)

Rules are IR-only; the parser just emits faithful IR.

- **`mockall`:** DRIFT-001 (stubbed member missing from the target trait/struct),
  DRIFT-002 (arity), DRIFT-003 (return assignability via a new `rustReturnAssignable`
  mirroring `phpReturnAssignable` — handles `Result<T,E>`, `Option<T>`, `Vec<T>`,
  references, `impl Trait`, tuples, unit, never, and generics), DRIFT-006 (stale mock vs
  a changed trait/impl, via diff scope).
- **`mockito`/`wiremock`:** reachability + tautology only — TAUT-005/006 and MOCK-*.
  No drift rules: an HTTP route has no static contract to drift against.
- **Not applicable:** DRIFT-004 (PHP original-constructor), DRIFT-005 (TS/JS `vi.mock`
  module factories).
- External-crate traits/types → `SYS-003` skip (see §3).

### §7. Testing & validation

- Fixture gallery: planted DRIFT-001/003, TAUT-001, DRIFT-005-reachability + healthy
  twins, excluded from `audit-self`.
- Parser + rule unit tests (TDD, vitest), a golden audit test, an MCP round-trip with
  `languages.rust: true`, and `doctor`/schema/release-config tests.
- Dogfood a real Rust crate (candidate proposed and confirmed before running), record
  findings + false positives in `docs/11`, fix what's genuine.

### §8. Build order

1. Core registry extension (§1) — green, no behavior change to TS/PHP/Python.
2. **WASM spike** (in `experiments/`, throwaway): compile `syn` to `wasm32`, confirm the
   `to_json` walk's fidelity on a sample corpus, and decide the load mechanism (Node
   `WebAssembly` vs WASI). This is the main unknown; it gates the rest.
3. Crate-wide semantic index (§3).
4. Symbols/imports + structural test detection (§2).
5. `mockall` mock detection (§4).
6. `mockito`/`wiremock` HTTP mocks (§4).
7. Assertions + provenance (§5).
8. Rules: `rustReturnAssignable` + drift/tautology wiring (§6).
9. Fixtures / golden / MCP / doctor / release-publish wiring (§7 + §1).
10. Dogfood + false-positive fixes.

## 3. "Add a language" checklist (unchanged, now exercised a 4th time)

Adding a language is: (1) a `languages.ts` registry entry; (2) a parser package
implementing `LanguageParser`; (3) wire the parser into CLI + server; (4) two
static-config edits — `release-please-config.json` `extra-files` and `scripts/publish.mjs`
ORDER; (5) `npm run version:sync` so the new package starts at the current lockstep
version (never hardcode). Plus framework/pattern IR enum members if the language
introduces new ones.

## 4. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `syn` → `wasm32` fails or the `to_json` walk is too lossy | Spike (§8.2) is the gate; fallback is a native `syn-dump` CLI (the rejected Approach B delivery) without changing the thin-WASM/fat-TS architecture. |
| Proc-macro mocks (`mock!`/`#[automock]`) are unexpanded in `syn` | Hand-modeled `mock!` DSL + `#[automock]` attr parse; the target trait is resolved from source, not expansion. |
| External-crate traits unresolvable | `SYS-003` skip (honest boundary), documented in findings; not a silent miss. |
| Rich Rust type system breaks DRIFT-003 assignability | `rustReturnAssignable` mirrors the proven PHP/TS structure; fixtures cover `Result`/`Option`/generics/tuples/references. |
| Structural test detection misfires | A fn is a test iff `#[test]` or inside `#[cfg(test)] mod`; `tests/*.rs` integration tests are whole-file test scope. |
| Crate index regresses TS/PHP/Python | It is additive; the existing 427 tests + golden audit + self-audit stay green as the gate. |

## 5. Open questions (answered at implementation, not blocking)

1. Exact `syn`-WASM load mechanism (Node `WebAssembly` vs WASI) and the `to_json` AST
   shape — the spike decides.
2. Which real Rust crate to dogfood — proposed and confirmed before running.
