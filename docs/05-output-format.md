# 5. Output Format & Token Efficiency

> Normative. Defines the exact Markdown and JSON report schemas returned to LLMs, the
> per-issue token budget, and the formatter's contract.

## 5.1 Token budget contract

| Budget | Value | Enforced by |
|---|---|---|
| Per-issue rendered line | **< 100 tokens** (target mean ≈ 30) | Formatter; asserted in golden tests via the `tokens` field |
| `message` field | ≤ 80 characters | Rule authoring lint |
| `fix.description` | ≤ 60 characters | Rule authoring lint |
| `evidence` | ≤ 60 characters (code excerpt) | Rule authoring lint |
| `maxIssuesPerReport` | 50 default, configurable | Formatter (truncates, reports `truncated: true`) |
| Tool descriptions (all tools) | ≤ 200 tokens each | Authoring lint; verified in CI |
| `tools/list` serialized | < 4 KB | CI assertion |

Token estimation: `tokens ≈ ceil(chars / 4)` (conservative for code) + 4 overhead per line.
Golden tests assert the estimate equals the rendered line's actual tokenization under a
reference tokenizer (TikToken `cl100k_base` at dev time only — runtime never tokenizes).

## 5.2 Issue line grammar (canonical)

```
{file}:{line}:{col} [{RULE-ID}] {severity} — {message} — fix: {fix.description}
```

Examples (each < 100 tokens):

```
tests/order.test.ts:42:9 [TAUT-002] error — asserts stubbed value against itself; mock echoes its own return — fix: assert against a production-derived value
tests/order.test.ts:58:5 [DRIFT-001] error — LedgerService.totalFor removed from target (renamed totalCentsFor) — fix: vi.spyOn(ledger, 'totalCentsFor')
tests/order.test.ts:61:1 [MOCK-001] warning — 4/5 deps mocked, 0 production-provenance assertions — fix: use real PricingService with stubbed Db
```

Rules of the grammar:

1. `file` is always workspace-relative (`src/…`, `tests/…`) — never absolute, never `../`-escaped.
2. `severity` is one of `error`, `warning`, `info`.
3. The em-dash separator is ` — ` (U+2014) — consistent across Markdown and JSON `message` fields.
4. When a `fix.code` snippet exists it appears in a code block directly under the line (in
   Markdown) or as `fix.code` (in JSON); it is *not* part of the line's token count.

## 5.3 Markdown report

### 5.3.1 Full report (default verbosity)

```markdown
# Momus audit — tests/order.test.ts

Audited 1 file · 3 issues (2 error · 1 warning) · 12ms

## Errors
- `tests/order.test.ts:42:9` **TAUT-002** — asserts stubbed value against itself; mock echoes its own return
  ```ts
  // fix: expect(service.place(inv)).toEqual({ id: expect.any(String), status: 'paid' })
  ```
- `tests/order.test.ts:58:5` **DRIFT-001** — `LedgerService.totalFor` removed from target (renamed `totalCentsFor`)
  ```ts
  // fix: vi.spyOn(ledger, 'totalCentsFor')
  ```

## Warnings
- `tests/order.test.ts:61:1` **MOCK-001** — 4/5 deps mocked, 0 production-provenance assertions
  ```ts
  // fix: use the real PricingService with a stubbed Db
  ```

## Notes
- `tests/order.test.ts:3:1` **SYS-003** — 2 imports unresolved (type-aware checks downgraded)
```
_3 findings suppressed (TAUT-002 ×1, MOCK-001 ×1, DRIFT-003 ×1)_ — shown only when suppressions exist

- Issue lines are grouped by severity (`## Errors` → `## Warnings` → `## Notes`), sorted by
  (file, line, column) within each group.
- `## Notes` holds `info` severity issues **and** system diagnostics (`SYS-*`).
- The header line is exactly one line: file(s) audited · issue counts · duration.
- Suppressed findings are listed as an italic single line unless `includeSuppressed: true`
  (then they render as `## Suppressed` with the same line grammar plus the reason).
- Truncation: when `issues > maxIssuesPerReport`, the last section becomes
  `_… 17 more issues omitted (maxIssues=50) — pass maxIssues to raise the cap_`.

### 5.3.2 Summary-only mode

The text block is the summary line only:

```markdown
# Momus audit — 12 files · 4 issues (2 error · 1 warning · 1 info) · 410ms — CLEAN:false
```

`CLEAN:true` iff zero `error`/`warning` issues (system diagnostics and `info` don't block).
Used when `maxIssues: 0` is passed or verbosity `summary` is configured.

## 5.4 JSON envelope (structuredContent)

```json
{
  "schemaVersion": 1,
  "tool": "<tool name>",
  "result": {
    "summary": {
      "filesAudited": 12,
      "issues": 4,
      "errors": 2,
      "warnings": 1,
      "infos": 1,
      "suppressed": 3,
      "durationMs": 410,
      "truncated": false,
      "diffBase": "main",
      "changedFiles": 3,
      "staleMockCandidates": 1
    },
    "indexStats": { "modules": 214, "symbols": 1302, "mocks": 47 },
    "issues": [
      {
        "rule": "DRIFT-001",
        "severity": "error",
        "file": "tests/invoice.test.ts",
        "line": 12,
        "column": 7,
        "endLine": 12,
        "endColumn": 42,
        "message": "`InvoiceRepository.fetch` removed from target (was renamed to `findByRef`)",
        "evidence": "->shouldReceive('fetch')",
        "fix": {
          "kind": "replace",
          "span": { "startLine": 12, "startCol": 7, "endLine": 12, "endCol": 42 },
          "code": "->shouldReceive('findByRef')",
          "description": "rename stub to current member"
        },
        "tokens": 24
      }
    ],
    "suppressed": [
      { "rule": "TAUT-002", "file": "tests/order.test.ts", "line": 42, "reason": "intentional: asserting the stub's wiring in an integration harness" }
    ],
    "diagnostics": [
      { "code": "SYS-003", "severity": "info", "file": "tests/order.test.ts", "message": "2 imports unresolved; type-aware checks downgraded" }
    ]
  }
}
```

### 5.4.1 Schema (`$defs`, inlined by the SDK into outputSchema)

```json
{
  "$defs": {
    "Issue": {
      "type": "object",
      "properties": {
        "rule": { "type": "string", "pattern": "^(TAUT|DRIFT|MOCK|SYS)-\\d{3}$" },
        "severity": { "enum": ["error", "warning", "info"] },
        "file": { "type": "string" },
        "line": { "type": "integer", "minimum": 1 },
        "column": { "type": "integer", "minimum": 1 },
        "endLine": { "type": "integer", "minimum": 1 },
        "endColumn": { "type": "integer", "minimum": 1 },
        "message": { "type": "string", "maxLength": 80 },
        "evidence": { "type": "string", "maxLength": 60 },
        "fix": {
          "type": "object",
          "properties": {
            "kind": { "enum": ["replace", "insert", "delete"] },
            "span": { "type": "object", "properties": { "startLine": { "type": "integer" }, "startCol": { "type": "integer" }, "endLine": { "type": "integer" }, "endCol": { "type": "integer" } } },
            "code": { "type": "string" },
            "description": { "type": "string", "maxLength": 60 }
          }
        },
        "tokens": { "type": "integer" }
      },
      "required": ["rule", "severity", "file", "line", "column", "endLine", "endColumn", "message", "tokens"]
    },
    "AuditReport": {
      "type": "object",
      "properties": {
        "summary": { "type": "object" },
        "indexStats": { "type": "object" },
        "issues": { "type": "array", "items": { "$ref": "#/$defs/Issue" } },
        "suppressed": { "type": "array", "items": { "$ref": "#/$defs/Issue" } },
        "diagnostics": { "type": "array", "items": { "type": "object" } }
      },
      "required": ["summary", "issues"]
    },
    "SynthReport": {
      "type": "object",
      "properties": {
        "summary": { "type": "object" },
        "template": { "type": "string" },
        "contract": { "type": "array", "items": { "type": "object" } },
        "notes": { "type": "array", "items": { "type": "string" } }
      },
      "required": ["summary", "template", "contract"]
    },
    "RulesReport": {
      "type": "object",
      "properties": {
        "rules": { "type": "array", "items": { "type": "object" } },
        "suppressionSyntax": { "type": "string" },
        "configFile": { "type": "string" }
      },
      "required": ["rules", "suppressionSyntax"]
    }
  }
}
```

### 5.4.2 JSON field rules

1. `line`/`column` are 1-based; `endCol` is exclusive; spans always satisfy
   `endLine > line || (endLine === line && endCol >= column)`.
2. `fix.code` may contain newlines; it is a literal replacement for `fix.span` (or an insertion
   point when `kind === 'insert'`, with `span` covering zero width).
3. `tokens` is the estimated token count of the **rendered Markdown line** (grammar §5.2),
   asserted < 100.
4. The `summary.durationMs` is the time spent in analysis only (parse + rules + format),
   excluding discovery of unchanged cached files.
5. `diagnostics` are never empty-silenced: if none, the array is omitted entirely.

## 5.5 Determinism guarantees

- Issue ordering is `(severityRank: error=0, warning=1, info=2, file, line, col, ruleId)`.
- `summary` numbers are computed after suppression filtering, before truncation.
- The same workspace state produces byte-identical Markdown **and** identical
  `structuredContent` (JSON key order fixed by the serializer).
- No timestamps, machine names, or absolute paths appear anywhere in output.

## 5.6 Agent-facing usage notes (included in every tool description)

- Apply each `fix.code` (or `fix.description` when code is absent), then re-run the tool;
  convergence to zero issues is the definition of "resolved" under Momus.
- Findings with `severity: error` are statically provable and should be treated as blockers.
  `warning` and `info` are heuristics — read the reason, then either fix, scope-suppress with
  `@momus-ignore:RULE`, or adjust `.momusrc` severity.

---

**Next:** [`06-repository-layout.md`](./06-repository-layout.md) — repo structure, stack, CI/CD, test strategy.
