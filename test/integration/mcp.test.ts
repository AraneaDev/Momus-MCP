import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMomusServer } from '@momus/mcp-server';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'parser-typescript', 'test', 'fixtures');

describe('Momus MCP server (in-memory transport)', () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const pair = InMemoryTransport.createLinkedPair();
    const server = createMomusServer({ root: FIXTURES });
    cleanup = () => server.close();
    await server.connect(pair[0]);
    client = new Client({ name: 'momus-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(pair[1]);
  });

  afterAll(async () => {
    await cleanup();
  });

  it('advertises exactly the five tools with annotations', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'audit_test_fidelity',
      'detect_tautological_assertions',
      'list_rules',
      'synthesize_mock_contract',
      'verify_mock_drift',
    ]);
    const audit = tools.find((t) => t.name === 'audit_test_fidelity')!;
    expect(audit.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(audit.inputSchema.properties?.filePath).toBeDefined();
  });

  it('audit_test_fidelity returns findings in markdown + structuredContent', async () => {
    const res = await client.callTool({
      name: 'audit_test_fidelity',
      arguments: { filePath: 'tests/ledger.test.ts' },
    });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { result: { issues: Array<{ rule: string; line: number }> } };
    const rules = sc.result.issues.map((i) => `${i.rule}@${i.line}`).sort();
    expect(rules).toEqual(['DRIFT-001@16', 'TAUT-002@11', 'TAUT-006@18']);
    // markdown text present and token-budgeted
    const text = res.content[0]!.text;
    expect(text).toContain('TAUT-002');
  });

  it('detect_tautological_assertions returns only TAUT rules', async () => {
    const res = await client.callTool({ name: 'detect_tautological_assertions', arguments: {} });
    const sc = res.structuredContent as { result: { issues: Array<{ rule: string }> } };
    expect(sc.result.issues.length).toBeGreaterThan(0);
    expect(sc.result.issues.every((i) => i.rule.startsWith('TAUT'))).toBe(true);
  });

  it('verify_mock_drift returns only DRIFT rules', async () => {
    const res = await client.callTool({ name: 'verify_mock_drift', arguments: {} });
    const sc = res.structuredContent as { result: { issues: Array<{ rule: string }> } };
    expect(sc.result.issues.length).toBeGreaterThan(0);
    expect(sc.result.issues.every((i) => i.rule.startsWith('DRIFT'))).toBe(true);
  });

  it('verify_mock_drift errors without baseRef when scope=git-diff', async () => {
    const res = await client.callTool({ name: 'verify_mock_drift', arguments: { scope: 'git-diff' } });
    expect(res.isError).toBe(true);
  });

  it('synthesize_mock_contract generates a template from production AST', async () => {
    const res = await client.callTool({
      name: 'synthesize_mock_contract',
      arguments: { targetPath: 'src/services/ledger.ts' },
    });
    expect(res.isError).toBeFalsy();
    const text = res.content[0]!.text;
    expect(text).toContain('totalFor');
    const sc = res.structuredContent as { result: { summary: { members: number } } };
    expect(sc.result.summary.members).toBe(1);
  });

  it('synthesize_mock_contract errors for missing files', async () => {
    const res = await client.callTool({
      name: 'synthesize_mock_contract',
      arguments: { targetPath: 'src/nope.ts' },
    });
    expect(res.isError).toBe(true);
  });

  it('list_rules returns the catalog with severities', async () => {
    const res = await client.callTool({ name: 'list_rules', arguments: {} });
    const sc = res.structuredContent as { result: { rules: Array<{ id: string; severity: string }> } };
    expect(sc.result.rules.length).toBe(12);
    expect(sc.result.rules.find((r) => r.id === 'TAUT-002')?.severity).toBe('error');
  });
});
