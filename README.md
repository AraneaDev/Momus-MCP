# Momus-MCP

Momus is a deterministic, read-only static auditor for TypeScript and JavaScript test suites. It finds **false-green tests** caused by tautological assertions, mock-contract drift, and mock hygiene problems—without executing the application or its tests.

## Quickstart

Requirements: Node.js 20 or newer.

```bash
npx momus audit .
```

Momus exits with:

- `0` when no error-level findings are present
- `1` when error-level findings are present
- `2` for usage or configuration errors
- `3` for unexpected internal errors

Useful commands:

```bash
npx momus audit . --json                 # machine-readable report
npx momus audit tests/order.test.ts      # audit a specific path
npx momus drift                          # mock-contract drift only
npx momus contract src/services/ledger.ts
npx momus rules                          # list rules and severities
npx momus init                           # create a .momusrc config
npx momus doctor                         # inspect the local setup
```

Momus reads `.momusrc` from the workspace root when present. Run `npx momus --help` for the complete command synopsis.

## MCP server

The MCP server uses stdio and is read-only. Add it to an MCP client with the workspace you want to audit as `MOMUS_ROOT`.

### Claude Desktop

Add an entry to the client's MCP configuration file:

```json
{
  "mcpServers": {
    "momus": {
      "command": "npx",
      "args": ["-y", "@momus/mcp-server"],
      "env": {
        "MOMUS_ROOT": "/absolute/path/to/your/project"
      }
    }
  }
}
```

### Cursor and other MCP clients

Use the same command and arguments in the client's MCP server configuration:

```json
{
  "command": "npx",
  "args": ["-y", "@momus/mcp-server"],
  "env": {
    "MOMUS_ROOT": "/absolute/path/to/your/project"
  }
}
```

The server exposes `audit_test_fidelity`, `detect_tautological_assertions`, `verify_mock_drift`, `synthesize_mock_contract`, and `list_rules`.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run audit-self
```

The repository uses npm workspaces. The package sources are intentionally run from TypeScript source during this pre-publish release; the workspace's local bin links make `npx momus` available after `npm ci`.

## Configuration and suppressions

Use `.momusrc` to select test patterns, enable or disable rules, set issue limits, and configure ignored paths. Intentional exceptions can be marked in source with:

```ts
// @momus-ignore:TAUT-002
expect(result).toEqual(configuredValue);
```

See the specification for the complete suppression grammar and configuration schema.

## Documentation

- [`docs/README.md`](docs/README.md) — specification index and project status
- [`docs/03-analysis-algorithms.md`](docs/03-analysis-algorithms.md) — rules and detection algorithms
- [`docs/04-mcp-tool-definitions.md`](docs/04-mcp-tool-definitions.md) — MCP tool contracts
- [`docs/05-output-format.md`](docs/05-output-format.md) — Markdown and JSON output schemas
- [`docs/10-build-plan.md`](docs/10-build-plan.md) — implementation status and sequenced plan
- [`HANDOVER.md`](HANDOVER.md) — current engineering handover

## License

MIT
