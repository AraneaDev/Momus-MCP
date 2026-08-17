# 12. MCP Registry Listing Draft

This document contains the drafts for submitting Momus-MCP to the official Model Context Protocol (MCP) servers list and community registries.

## 1. Official Anthropic MCP Servers Registry (`modelcontextprotocol/servers`)

### `README.md` Entry

Add the following under the appropriate category (e.g., **Development Tools** or **Testing**):

```markdown
- [@momus/mcp-server](https://github.com/AraneaDev/Momus-MCP) - Unsparing mock and test integrity auditor for TypeScript and PHP coding agents. Detects test contract drift and tautological assertions statically.
```

### Server Details for Official Directory

If the registry requires a detailed JSON/YAML entry or issue submission:

- **Name**: Momus-MCP
- **Description**: An unsparing mock & test integrity auditor. Momus statically analyzes TypeScript (Vitest/Jest) and PHP (PHPUnit/Pest) test suites to catch "false green" tests where mocks have drifted from their production contracts, or where tautological assertions test the mock instead of the system.
- **Source**: `https://github.com/AraneaDev/Momus-MCP`
- **Installation / Usage**:
  ```bash
  npx -y @momus/mcp-server
  ```
- **Language**: TypeScript (Node.js)
- **Features**:
  - Test fidelity audits (`audit_test_fidelity`)
  - Drift detection (`verify_mock_drift`)
  - Tautological assertion detection (`detect_tautological_assertions`)
  - Mock contract synthesis (`synthesize_mock_contract`)

---

## 2. Community Registries (e.g., Smithery, Glama)

### Smithery (`smithery.yaml`)

If we decide to publish directly to Smithery, we can include this configuration in the repository root:

```yaml
startCommand:
  type: stdio
  command: npx
  args:
    - "-y"
    - "@momus/mcp-server"
```

### Glama.ai Listing

- **Server Name**: Momus-MCP
- **Repository URL**: `https://github.com/AraneaDev/Momus-MCP`
- **Homepage / Docs**: `https://github.com/AraneaDev/Momus-MCP`
- **Short Description**: Stop your coding agents from writing false-green tests. Momus is a strict test integrity auditor for TS and PHP.
- **Transport**: Stdio
- **Command**:
  ```json
  {
    "command": "npx",
    "args": ["-y", "@momus/mcp-server"]
  }
  ```

---

## 3. Claude Desktop Configuration Snippet

This snippet is already drafted in our README, but provided here as part of the listing data, in case registries scrape it:

```json
{
  "mcpServers": {
    "momus-mcp": {
      "command": "npx",
      "args": ["-y", "@momus/mcp-server"]
    }
  }
}
```

## Next Steps for Publishing

1. **NPM Publish**: The `@momus/*` packages must be published to NPM so that `npx -y @momus/mcp-server` resolves correctly. This is currently blocked by NPM credentials.
2. **Submit PR**: Open a Pull Request to `modelcontextprotocol/servers` adding the README entry.
3. **Community Submission**: Submit the repository URL to Glama and Smithery via their respective submission forms or CLI tools.
