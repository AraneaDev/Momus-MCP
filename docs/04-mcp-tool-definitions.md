# 4. MCP Tool Definitions & JSON Schemas

> Normative. The complete MCP tool surface for `momus-mcp`, conforming to the MCP
> specification (2026-07-28 revision): `tools/list` manifest, per-tool input/output schemas
> (JSON Schema draft 2020-12), example payloads, and the agent usage protocol.

## 4.1 Server identity & capabilities

```json
{
  "protocolVersion": "2026-07-28",
  "capabilities": {
    "tools": { "listChanged": true },
    "resources": { "subscribe": false, "listChanged": false }
  },
  "serverInfo": { "name": "momus-mcp", "version": "0.0.1" }
}
```

`serverInfo.version` is read from `@momus/mcp-server`'s package.json at runtime (release-please
bumps it in lockstep with the other `@momus/*` packages).

- **Transport:** `stdio` by default; `--transport http` enables Streamable HTTP (implemented).
- **Tools are returned in deterministic order** (catalog order below) for client caching and
  prompt-cache stability.
- **All tools are read-only:** `readOnlyHint: true`, `destructiveHint: false`,
  `idempotentHint: true`, `openWorldHint: false` (results depend only on the workspace
  snapshot; identical inputs + identical workspace ⇒ identical output).
- **No tool accepts or returns handles/state** (stateless per MCP guidance); state lives in the
  workspace, which is the only "handle" ever needed.
- **Language gating:** the server honors `.momusrc` `languages.{typescript,php,python}` — files of
  a disabled language are discovered but skipped (never indexed or reported on). Python audits
  route through the `@momus/parser-python` plugin when `languages.python: true`.
- **Transport hygiene (validated — `09-validation-report.md` F8):** over stdio, stdout IS the
  protocol channel. The server MUST NOT write to stdout (no `console.log`, no debug output);
  all logging goes to `stderr` or an injectable logger that defaults to no-op in server mode.
  A single stray stdout write corrupts the first `tools/call` response.
- **`outputSchema` note (validated — `09-validation-report.md` F10):** SDK 1.29/1.30
  `McpServer.tool()` has no `outputSchema` parameter. The schemas in §4.2 remain normative
  documentation for clients and for future SDK versions, but are not wired into tool
  registration in v1 (clients validate `structuredContent` instead).
- Tool results carry **both** `content[0].text` (Markdown report, human/LLM readable) **and**
  `structuredContent` (JSON envelope) — clients may consume either; per spec, structured
  results must also be serialized in the text block.

## 4.2 Tool manifest (`tools/list`)

```json
{
  "resultType": "complete",
  "tools": [
    {
      "name": "audit_test_fidelity",
      "title": "Audit Test Fidelity",
      "description": "Deep static audit of a test file: checks every mock/stub/spy against its real production dependency (members, signatures, return types) and flags tautological or unproven assertions. Read-only; never executes tests. Returns issues with file:line, rule, reason, and fix.",
      "inputSchema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "filePath": { "type": "string", "description": "Path to the test file, workspace-relative (e.g. 'tests/order.test.ts')." },
          "rules": { "type": "array", "items": { "type": "string", "pattern": "^(TAUT|DRIFT|MOCK)-\\d{3}$" }, "description": "Optional rule filter; defaults to all enabled rules." },
          "maxIssues": { "type": "integer", "minimum": 0, "maximum": 500, "default": 50, "description": "Cap on issues returned; 0 = summary-only report. Results are sorted by severity first." },
          "includeSuppressed": { "type": "boolean", "default": false, "description": "Also return suppressed findings (span + rule + reason)." }
        },
        "required": ["filePath"],
        "additionalProperties": false
      },
      "outputSchema": { "$ref": "#/$defs/AuditReport" },
      "annotations": { "title": "Audit Test Fidelity", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
    },
    {
      "name": "detect_tautological_assertions",
      "title": "Detect Tautological Assertions",
      "description": "Scans test files for assertions that cannot fail: self-comparisons, mock-echo assertions (asserting a stubbed value against the stub's own return), constant tautologies, mock-only assertions, zero-reach stubs, and unconfigured spy assertions. Read-only.",
      "inputSchema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "paths": { "type": "array", "items": { "type": "string" }, "description": "Files or globs (e.g. ['tests/**/*.test.ts']). Defaults to all test files in the workspace." },
          "rules": { "type": "array", "items": { "type": "string", "enum": ["TAUT-001", "TAUT-002", "TAUT-003", "TAUT-004", "TAUT-005", "TAUT-006"] }, "description": "Subset of tautology rules to run; defaults to all." },
          "maxIssues": { "type": "integer", "minimum": 0, "maximum": 500, "default": 50, "description": "Cap on issues returned; 0 = summary-only report." }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputSchema": { "$ref": "#/$defs/AuditReport" },
      "annotations": { "title": "Detect Tautological Assertions", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
    },
    {
      "name": "verify_mock_drift",
      "title": "Verify Mock Drift",
      "description": "Fast scan for test doubles that no longer match their production contracts: mocked members that don't exist, signature/return-type mismatches, missing module exports, constructor drift, and (in git-diff scope) mocks left stale by production changes. Read-only.",
      "inputSchema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "scope": { "type": "string", "enum": ["workspace", "git-diff"], "default": "workspace", "description": "'workspace': audit all test files. 'git-diff': audit only mocks whose targets changed vs baseRef (also enables DRIFT-006)." },
          "baseRef": { "type": "string", "description": "Git ref for git-diff scope, e.g. 'main' or 'HEAD~1'. Required when scope='git-diff'." },
          "paths": { "type": "array", "items": { "type": "string" }, "description": "Restrict scan to these files/globs." },
          "includeUnresolved": { "type": "boolean", "default": false, "description": "Include DRIFT-000 info entries for mocks whose targets could not be resolved." },
          "maxIssues": { "type": "integer", "minimum": 0, "maximum": 500, "default": 50, "description": "Cap on issues returned; 0 = summary-only report." }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputSchema": { "$ref": "#/$defs/AuditReport" },
      "annotations": { "title": "Verify Mock Drift", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
    },
    {
      "name": "synthesize_mock_contract",
      "title": "Synthesize Mock Contract",
      "description": "Generates a strict, typed mock fixture template directly from a production class/interface AST: correct member names, signatures, parameter lists, and typed return stubs. Returns the template as a code block in the report. Read-only; writes nothing.",
      "inputSchema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "targetPath": { "type": "string", "description": "Path to the production file declaring the class/interface to mock (workspace-relative)." },
          "symbolName": { "type": "string", "description": "Name of the class/interface within targetPath to mock. Defaults to the primary export/class." },
          "framework": { "type": "string", "enum": ["vitest", "jest", "phpunit", "pest"], "description": "Mock style to generate." },
          "includeConstructor": { "type": "boolean", "default": true, "description": "Emit constructor call with placeholder args (PHPUnit: createMock + disableOriginalConstructor note)." },
          "includeReturnValues": { "type": "boolean", "default": true, "description": "Emit typed return stubs (mockReturnValue with shape placeholders) for each method." },
          "includeDefaults": { "type": "boolean", "default": false, "description": "Fill return stubs with default-constructed values instead of shape placeholders." }
        },
        "required": ["targetPath", "framework"],
        "additionalProperties": false
      },
      "outputSchema": { "$ref": "#/$defs/SynthReport" },
      "annotations": { "title": "Synthesize Mock Contract", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
    },
    {
      "name": "list_rules",
      "title": "List Rules",
      "description": "Returns the rule catalog with default severities, per-workspace overrides, and suppression syntax. Call this first to learn what Momus checks in this workspace and what is disabled.",
      "inputSchema": { "type": "object", "additionalProperties": false },
      "outputSchema": { "$ref": "#/$defs/RulesReport" },
      "annotations": { "title": "List Rules", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
    }
  ]
}
```

> `#/$defs/*` referenced above are defined in `05-output-format.md` §5.4.1 (JSON envelope schema).
> The MCP client sees only `inputSchema` (inline); `outputSchema`/`$defs` are inlined by the
> SDK at server build time.

## 4.3 Shared result envelope

Every tool returns:

```json
{
  "resultType": "complete",
  "content": [{ "type": "text", "text": "<markdown report, see §5>" }],
  "structuredContent": { "schemaVersion": 1, "tool": "<tool name>", "result": { /* per-tool */ } },
  "isError": false
}
```

Errors (unknown path, unparseable config, git failure) are **tool execution errors**:

```json
{
  "resultType": "complete",
  "content": [{ "type": "text", "text": "## Error\n`verify_mock_drift`: cannot resolve baseRef 'main': no such ref. Check `git rev-parse --verify main`." }],
  "structuredContent": { "schemaVersion": 1, "tool": "verify_mock_drift", "error": { "code": "INVALID_BASE_REF", "message": "cannot resolve baseRef 'main'", "hint": "Pass an existing ref, or use scope='workspace'." } },
  "isError": true
}
```

Error codes: `NOT_FOUND` (path outside workspace / missing file), `INVALID_BASE_REF`,
`CONFIG_ERROR` (`SYS-005`), `PARSE_ERROR` (`SYS-001`), `INTERNAL`.

## 4.4 Example payloads

### 4.4.1 `audit_test_fidelity`

Request:

```json
{ "name": "audit_test_fidelity", "arguments": { "filePath": "tests/order.test.ts" } }
```

Response (text block abbreviated; full report format in `05-output-format.md`):

```json
{
  "content": [{
    "type": "text",
    "text": "# Momus audit — tests/order.test.ts\nAudited 1 file · 3 issues (2 error · 1 warning) · 12ms\n\n- `tests/order.test.ts:42:9` **TAUT-002** error — asserts stubbed value against itself; mock echoes its own return\n  ```ts\n  // fix: expect(service.place(inv)).toEqual({ id: expect.any(String), status: 'paid' })\n  ```\n- `tests/order.test.ts:58:5` **DRIFT-001** error — `LedgerService.totalFor` no longer exists on target; renamed to `totalCentsFor`\n  ```ts\n  // fix: vi.spyOn(ledger, 'totalCentsFor')\n  ```\n- `tests/order.test.ts:61:5` **MOCK-001** warning — 4/5 dependencies mocked, 0 production-provenance assertions\n  ```ts\n  // fix: use the real PricingService with a stubbed Db\n  ```"
  }],
  "structuredContent": {
    "schemaVersion": 1,
    "tool": "audit_test_fidelity",
    "result": {
      "summary": { "filesAudited": 1, "issues": 3, "errors": 2, "warnings": 1, "infos": 0, "suppressed": 0, "durationMs": 12 },
      "indexStats": { "modules": 14, "symbols": 89, "mocks": 5 },
      "issues": [
        {
          "rule": "TAUT-002", "severity": "error",
          "file": "tests/order.test.ts", "line": 42, "column": 9, "endLine": 42, "endColumn": 41,
          "message": "asserts stubbed value against itself; mock echoes its own return",
          "evidence": "expect(mock.total()).toBe(4200)  // mockReturnValue(4200) above",
          "fix": { "kind": "replace", "span": { "startLine": 42, "startCol": 9, "endLine": 42, "endCol": 41 }, "code": "expect(service.place(inv)).toEqual({ id: expect.any(String), status: 'paid' })", "description": "assert against a production-derived value" },
          "tokens": 31
        },
        {
          "rule": "DRIFT-001", "severity": "error",
          "file": "tests/order.test.ts", "line": 58, "column": 5, "endLine": 58, "endColumn": 33,
          "message": "`LedgerService.totalFor` no longer exists on target; renamed to `totalCentsFor`",
          "evidence": "vi.spyOn(ledger, 'totalFor')",
          "fix": { "kind": "replace", "code": "vi.spyOn(ledger, 'totalCentsFor')", "description": "update spy target to current member" },
          "tokens": 27
        },
        {
          "rule": "MOCK-001", "severity": "warning",
          "file": "tests/order.test.ts", "line": 61, "column": 1, "endLine": 61, "endColumn": 1,
          "message": "4/5 dependencies mocked and no production-provenance assertions; over-mocked",
          "evidence": "mocks: Db, LedgerService, PricingService, Mailer",
          "fix": { "kind": "delete", "code": "", "description": "replace PricingService mock with real instance + stubbed Db" },
          "tokens": 22
        }
      ],
      "suppressed": []
    }
  },
  "isError": false
}
```

### 4.4.2 `verify_mock_drift` (git-diff scope)

Request:

```json
{ "name": "verify_mock_drift", "arguments": { "scope": "git-diff", "baseRef": "main" } }
```

Response `result` (abbreviated):

```json
{
  "summary": { "filesAudited": 9, "issues": 1, "errors": 1, "warnings": 0, "infos": 0, "suppressed": 0, "durationMs": 410, "diffBase": "main", "changedFiles": 3, "staleMockCandidates": 1 },
  "issues": [
    {
      "rule": "DRIFT-001", "severity": "error",
      "file": "tests/invoice.test.ts", "line": 12, "column": 7, "endLine": 12, "endColumn": 42,
      "message": "`InvoiceRepository.fetch` removed from target (was renamed to `findByRef`)",
      "evidence": "->shouldReceive('fetch')",
      "fix": { "kind": "replace", "code": "->shouldReceive('findByRef')", "description": "rename stub to current member" },
      "tokens": 24
    }
  ]
}
```

### 4.4.3 `synthesize_mock_contract`

Request:

```json
{
  "name": "synthesize_mock_contract",
  "arguments": { "targetPath": "src/services/ledger.ts", "symbolName": "LedgerService", "framework": "vitest", "includeReturnValues": true }
}
```

Response `result` (abbreviated):

```json
{
  "summary": { "targetPath": "src/services/ledger.ts", "symbol": "LedgerService", "framework": "vitest", "members": 3, "durationMs": 8 },
  "template": "```ts\n// Generated by momus synthesize_mock_contract — LedgerService\n// Contract verified against src/services/ledger.ts (3 public members)\nconst ledgerMock = {\n  // totalFor(invoiceId: string): Promise<Invoice>\n  totalFor: vi.fn<[invoiceId: string], Promise<Invoice>>().mockResolvedValue({\n    id: expect.any(String) as string,\n    totalCents: expect.any(Number) as number,\n  }),\n  // markPaid(invoiceId: string): Promise<void>\n  markPaid: vi.fn<[invoiceId: string], Promise<void>>().mockResolvedValue(undefined),\n  // balance(): Promise<number>\n  balance: vi.fn<[], Promise<number>>().mockResolvedValue(0),\n} satisfies Partial<LedgerService>;\n```",
  "contract": [
    { "member": "totalFor", "signature": "totalFor(invoiceId: string): Promise<Invoice>", "returnType": "Invoice" },
    { "member": "markPaid", "signature": "markPaid(invoiceId: string): Promise<void>", "returnType": "void" },
    { "member": "balance", "signature": "balance(): Promise<number>", "returnType": "number" }
  ],
  "notes": ["Protected/private members omitted.", "Overloads collapsed to first signature; see contract list."]
}
```

### 4.4.4 `list_rules`

Response `result` (abbreviated):

```json
{
  "rules": [
    { "id": "TAUT-002", "name": "mock-echo", "severity": "error", "phase": 1, "description": "assertion compares against the stub's own configured return", "enabled": true },
    { "id": "MOCK-001", "name": "mock-saturation", "severity": "warning", "phase": 1, "description": "over-mocking heuristic: ≥70% deps mocked with no production-provenance assertions", "enabled": true }
  ],
  "suppressionSyntax": "// @momus-ignore · // @momus-ignore:RULE-ID · /** @momus-ignore */ · // @momus-ignore-file (see docs/03 §3.5)",
  "configFile": ".momusrc"
}
```

## 4.5 Agent usage protocol (normative guidance for LLM clients)

| Situation | Tool to call | Why |
|---|---|---|
| Agent is about to mark a task resolved with a green suite | `audit_test_fidelity` on each changed test file | Final integrity gate before "done". |
| A test is failing and the agent is tempted to stub the failing dependency | `audit_test_fidelity` + `verify_mock_drift` on the file | Surfaces whether the stub under construction would erase the bug (TAUT-004/MOCK-001) or drift (DRIFT-*). |
| A test fails after a production refactor/rename | `verify_mock_drift` with `scope:"git-diff", baseRef:"<branch base>"` | Finds mocks left behind by the change (DRIFT-001/006). |
| Agent needs to write a new mock for an existing class | `synthesize_mock_contract` | Correct members/signatures/return shapes up front. |
| Agent inherits an unfamiliar test suite | `list_rules` then `detect_tautological_assertions` on the suite | Learn what's checked; find unproven tests cheaply. |
| Agent believes a finding is a false positive | `list_rules` + config docs (`03-analysis-algorithms.md` §3.6) | Suppress explicitly with `@momus-ignore` + reason, never by editing the report. |

**Conventions:**

- Never call a Momus tool "just in case" on every turn — they are deterministic and cheap, but
  each call costs prompt tokens; prefer `verify_mock_drift` (workspace, fast) over
  `audit_test_fidelity` (deep, per-file) for broad sweeps.
- When a tool returns issues, apply fixes, then re-run the same tool — results must converge
  to zero before the task is marked done (the Momus loop).
- Suppressions must carry intent: prefer `// @momus-ignore:RULE` (scoped) over
  `// @momus-ignore-file`, and never suppress without understanding the finding.

---

**Next:** [`05-output-format.md`](./05-output-format.md) — report grammar and token budget.
