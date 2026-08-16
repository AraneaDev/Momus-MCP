import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMomusServer, serveHttp, watchWorkspace } from '@momus/mcp-server';
import { DEFAULT_CONFIG } from '@momus/core';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'packages',
  'parser-typescript',
  'test',
  'fixtures',
);

describe('Momus MCP server (in-memory transport)', () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const pair = InMemoryTransport.createLinkedPair();
    // disable the persistent cache so tests never write into the in-repo fixture tree
    const server = createMomusServer({
      root: FIXTURES,
      config: { ...DEFAULT_CONFIG, cache: { dir: '.momus/cache', enabled: false } },
    });
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

    // Perf budget §2.7: serialized tools/list must fit one prompt context page (< 4 KB).
    // The SDK's ListToolsResult shape is { tools: [...] }, so serialize the tool array.
    const payload = JSON.stringify({ tools });
    expect(Buffer.byteLength(payload, 'utf8')).toBeLessThan(4096);
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

  it('verify_mock_drift errors when git-diff scope runs outside a git repo', async () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'momus-no-git-'));
    try {
      const pair = InMemoryTransport.createLinkedPair();
      const server = createMomusServer({ root: nonRepo });
      await server.connect(pair[0]);
      const client = new Client({ name: 'momus-nogit-test', version: '1.0.0' }, { capabilities: {} });
      await client.connect(pair[1]);
      try {
        const res = await client.callTool({
          name: 'verify_mock_drift',
          arguments: { scope: 'git-diff', baseRef: 'HEAD' },
        });
        expect(res.isError).toBe(true);
        expect(res.content[0]!.text).toContain('git-diff scope failed');
      } finally {
        await server.close();
      }
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
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
    expect(sc.result.rules.length).toBe(14);
    expect(sc.result.rules.find((r) => r.id === 'TAUT-002')?.severity).toBe('error');
    expect(sc.result.rules.find((r) => r.id === 'DRIFT-006')?.severity).toBe('warning');
  });
});

describe('Momus MCP server (git-diff scope)', () => {
  function gitRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'momus-mcp-git-'));
    const run = (cmd: string) =>
      execFileSync('git', ['-C', dir, ...cmd.split(' ').filter(Boolean).slice(1)], { encoding: 'utf8', stdio: 'pipe' });
    run('git init -q -b main');
    run('git config user.email mcp@momus.dev');
    run('git config user.name mcp');
    mkdirSync(join(dir, 'src', 'services'), { recursive: true });
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'services', 'ledger.ts'),
      'export class LedgerService {\n  totalFor(): number { return 0; }\n}\n',
    );
    writeFileSync(
      join(dir, 'tests', 'ledger.test.ts'),
      [
        "import { describe, expect, it, vi } from 'vitest';",
        "import { LedgerService } from '../src/services/ledger';",
        "describe('LedgerService', () => {",
        "  it('spies on a member', () => {",
        '    const service = new LedgerService();',
        "    const spy = vi.spyOn(service, 'totalFor');",
        '    expect(spy).toHaveBeenCalled();',
        '  });',
        '});',
        '',
      ].join('\n'),
    );
    run('git add -A');
    run('git commit -qm initial');
    return dir;
  }

  it('verify_mock_drift scope=git-diff surfaces DRIFT-006 for mocks left stale', async () => {
    const repo = gitRepo();
    try {
      writeFileSync(
        join(repo, 'src', 'services', 'ledger.ts'),
        'export class LedgerService {\n  totalForRenamed(): number { return 0; }\n}\n',
      );
      const pair = InMemoryTransport.createLinkedPair();
      const server = createMomusServer({ root: repo });
      await server.connect(pair[0]);
      const client = new Client({ name: 'momus-git-test', version: '1.0.0' }, { capabilities: {} });
      await client.connect(pair[1]);
      try {
        const res = await client.callTool({
          name: 'verify_mock_drift',
          arguments: { scope: 'git-diff', baseRef: 'HEAD' },
        });
        expect(res.isError).toBeFalsy();
        const sc = res.structuredContent as { result: { issues: Array<{ rule: string }> } };
        expect(sc.result.issues.some((issue) => issue.rule === 'DRIFT-006')).toBe(true);
        expect(sc.result.issues.some((issue) => issue.rule === 'DRIFT-001')).toBe(true);
        const text = res.content[0]!.text;
        expect(text).toContain('git-diff vs HEAD');
      } finally {
        await server.close();
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
    // git repo setup + a full workspace parse can exceed the 5s default under parallel
    // coverage instrumentation (this test flaked twice with a 5000ms timeout)
  }, 20_000);
});

describe('Momus MCP server (Streamable HTTP)', () => {
  it('serves tools over HTTP and answers a round-trip', { timeout: 30_000 }, async () => {
    const handle = await serveHttp({
      root: FIXTURES,
      port: 0,
      config: { ...DEFAULT_CONFIG, cache: { dir: '.momus/cache', enabled: false } },
    });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`));
    const client = new Client({ name: 'momus-http-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(5);
      expect(tools.map((t) => t.name)).toContain('verify_mock_drift');
      const res = await client.callTool({ name: 'verify_mock_drift', arguments: {} });
      expect(res.isError).toBeFalsy();
      const sc = res.structuredContent as { result: { issues: Array<{ rule: string }> } };
      expect(sc.result.issues.some((issue) => issue.rule.startsWith('DRIFT'))).toBe(true);
    } finally {
      await client.close();
      await handle.close();
    }
  });
});

describe('Momus MCP server (watch mode)', () => {
  it('watchWorkspace fires onChange for source-file additions', { timeout: 15_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'momus-watch-'));
    const changed: string[] = [];
    const watcher = watchWorkspace(dir, { onChange: (path) => changed.push(path) });
    try {
      // let chokidar's initial scan of the empty dir settle
      await new Promise((resolve) => setTimeout(resolve, 400));
      writeFileSync(join(dir, 'foo.ts'), 'export const x = 1;\n');
      await waitFor(() => changed.length > 0, 5_000);
      expect(changed.some((p) => p.endsWith('foo.ts'))).toBe(true);
    } finally {
      await watcher.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('Momus MCP server (PHP language selection)', () => {
  let client: Client;
  let cleanup: () => Promise<void>;
  const PHP_FIXTURES = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'packages',
    'parser-php',
    'test',
    'fixtures',
  );

  beforeAll(async () => {
    const pair = InMemoryTransport.createLinkedPair();
    const config = {
      ...DEFAULT_CONFIG,
      languages: { typescript: false, php: true },
      cache: { dir: '.momus/cache', enabled: false },
    };
    const server = createMomusServer({ root: PHP_FIXTURES, config });
    cleanup = () => server.close();
    await server.connect(pair[0]);
    client = new Client({ name: 'momus-php-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(pair[1]);
  });

  afterAll(async () => {
    await cleanup();
  });

  it('routes PHP audits through the composite parser', async () => {
    const res = await client.callTool({ name: 'verify_mock_drift', arguments: {} });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { result: { issues: Array<{ rule: string }> } };
    expect(sc.result.issues.some((issue) => issue.rule === 'DRIFT-001')).toBe(true);
    expect(sc.result.issues.some((issue) => issue.rule === 'DRIFT-004')).toBe(true);
  });

  it('synthesizes a phpunit mock template from a PHP production class', async () => {
    const res = await client.callTool({
      name: 'synthesize_mock_contract',
      arguments: { targetPath: 'src/DocblockService.php', framework: 'phpunit' },
    });
    expect(res.isError).toBeFalsy();
    const text = res.content[0]!.text;
    expect(text).toContain('```php');
    expect(text).toContain('$mock = $this->createMock(DocblockService::class);');
    expect(text).toContain("method('findById')");
    expect(text).toContain("method('fetchIds')");
    expect(text).toContain('willReturn');
    // @throws-documented methods surface as commented willThrowException stubs
    expect(text).toContain(
      "// @throws RuntimeException → $mock->method('publish')->willThrowException(new \\RuntimeException());",
    );
    const sc = res.structuredContent as { result: { summary: { members: number } } };
    expect(sc.result.summary.members).toBe(4);
  });

  it('synthesizes a pest mock template from a PHP production class', async () => {
    const res = await client.callTool({
      name: 'synthesize_mock_contract',
      arguments: { targetPath: 'src/InvoiceRepository.php', framework: 'pest' },
    });
    expect(res.isError).toBeFalsy();
    const text = res.content[0]!.text;
    expect(text).toContain('$mock = mock(InvoiceRepository::class);');
    expect(text).toContain("shouldReceive('findById')");
    expect(text).toContain('andReturn');
    const sc = res.structuredContent as { result: { summary: { members: number } } };
    expect(sc.result.summary.members).toBe(2);
  });

  it('renders docblock type syntax and @throws into a pest template', async () => {
    const res = await client.callTool({
      name: 'synthesize_mock_contract',
      arguments: { targetPath: 'src/DocblockTypes.php', framework: 'pest' },
    });
    expect(res.isError).toBeFalsy();
    const text = res.content[0]!.text;
    // nullable (rendered as a union) + nested-array + @throws rendering on the same method
    expect(text).toContain('nested(Invoice|null $maybe): Invoice[][]');
    expect(text).toContain(
      "// @throws DomainException → $mock->shouldReceive('nested')->andThrow(new \\DomainException());",
    );
    // intersection params and generic array returns render through the TypeIR printer
    expect(text).toContain('combined(CollabA&CollabB $both): string[]');
    expect(text).toContain('genericMap(): Invoice[]');
    expect(text).toContain("shouldReceive('combined')->andReturn([]);");
    const sc = res.structuredContent as { result: { summary: { members: number } } };
    expect(sc.result.summary.members).toBe(4);
  });
});
