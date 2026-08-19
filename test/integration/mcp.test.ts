import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('reports the released package version in serverInfo', async () => {
    const init = await client.getServerVersion();
    expect(init.name).toBe('momus-mcp');
    // Tracks @momus/mcp-server's package.json (read at runtime), which release-please
    // bumps in lockstep. Read the expected version from the package itself rather than
    // hardcoding, so the test passes on release branches (where it is legitimately bumped).
    const pkg = JSON.parse(readFileSync(join(FIXTURES, '..', '..', '..', 'server', 'package.json'), 'utf8'));
    expect(init.version).toBe(pkg.version);
  });

  it('advertises exactly the published tools with annotations', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'audit_test_fidelity',
      'audit_workspace',
      'detect_tautological_assertions',
      'doctor_status',
      'explain_issue',
      'get_ir',
      'list_rules',
      'synthesize_mock_contract',
      'verify_mock_drift',
    ]);
    const audit = tools.find((t) => t.name === 'audit_test_fidelity')!;
    expect(audit.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(audit.inputSchema.properties?.filePath).toBeDefined();

    // Perf budget docs/02 §2.7: the whole surface stays small, and no single tool bloats.
    // The SDK's ListToolsResult shape is { tools: [...] }, so serialize the tool array.
    const payload = JSON.stringify({ tools });
    expect(Buffer.byteLength(payload, 'utf8')).toBeLessThan(12288);
    // The per-tool cap is the one that does the real work: it is what the original 4 KB
    // total was protecting, and unlike the total it does not need revisiting per tool added.
    for (const tool of tools) {
      expect
        .soft(Buffer.byteLength(JSON.stringify(tool), 'utf8'), `${tool.name} exceeds the per-tool budget`)
        .toBeLessThan(1024);
    }
  });

  it('audit_test_fidelity returns findings in markdown + structuredContent', async () => {
    const res = await client.callTool({
      name: 'audit_test_fidelity',
      arguments: { filePath: 'tests/ledger.test.ts' },
    });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { result: { issues: Array<{ rule: string; line: number }> } };
    const rules = sc.result.issues.map((i) => `${i.rule}@${i.line}`).sort();
    expect(rules).toEqual(['DRIFT-001@16', 'TAUT-002@11', 'TAUT-004@39', 'TAUT-006@39']);
    // markdown text present and token-budgeted
    const text = res.content[0]!.text;
    expect(text).toContain('TAUT-002');
  });

  it('get_ir returns the parsed mocks for a test file', async () => {
    const res = await client.callTool({
      name: 'get_ir',
      arguments: { path: 'tests/ledger.test.ts', kind: 'mocks' },
    });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as {
      result: { path: string; mocks: Array<{ pattern: string; line: number }> };
    };
    expect(sc.result.path).toBe('tests/ledger.test.ts');
    // service.totalForX (planted DRIFT-001), service.totalFor (healthy), stub.totalFor (TAUT-006)
    expect(sc.result.mocks.filter((m) => m.pattern === 'vi.spyOn').map((m) => m.line)).toEqual([16, 25, 38]);
  });

  it('get_ir refuses a path that escapes the workspace root', async () => {
    const res = await client.callTool({
      name: 'get_ir',
      arguments: { path: '../../../../etc/passwd' },
    });
    expect(res.isError).toBe(true);
    const sc = res.structuredContent as { error: { code: string; message: string } };
    expect(sc.error.code).toBe('NOT_FOUND');
    expect(sc.error.message).toContain('escapes the workspace root');
  });

  it('get_ir reports a missing file as a typed error, not a crash', async () => {
    const res = await client.callTool({ name: 'get_ir', arguments: { path: 'tests/nope.test.ts' } });
    expect(res.isError).toBe(true);
    const sc = res.structuredContent as { error: { code: string; message: string } };
    expect(sc.error.code).toBe('NOT_FOUND');
    expect(sc.error.message).toContain('no such file');
  });

  it('get_ir reports a file no parser claims as a typed error', async () => {
    // tsconfig.json sits in the fixture root and no LanguageParser claims .json.
    const res = await client.callTool({ name: 'get_ir', arguments: { path: 'tsconfig.json' } });
    expect(res.isError).toBe(true);
    const sc = res.structuredContent as { error: { code: string; message: string } };
    expect(sc.error.code).toBe('PARSE_ERROR');
    expect(sc.error.message).toContain('no parser claims');
  });

  it('get_ir exposes assertion operand provenance, which is what explains a TAUT finding', async () => {
    const res = await client.callTool({
      name: 'get_ir',
      arguments: { path: 'tests/ledger.test.ts', kind: 'assertions' },
    });
    const sc = res.structuredContent as {
      result: {
        assertions: Array<{ line: number; api: string; operands: Array<{ provenance: string }> }>;
        mocks?: unknown;
        symbols?: unknown;
      };
    };
    // The planted TAUT-002 on line 11 is a mock-config operand echoed against a literal.
    const echo = sc.result.assertions.find((a) => a.line === 11)!;
    expect(echo.api).toBe('toBe');
    expect(echo.operands.map((o) => o.provenance)).toEqual(['mock-config', 'literal']);
    // A filtered slice carries only what was asked for.
    expect(sc.result.mocks).toBeUndefined();
    expect(sc.result.symbols).toBeUndefined();
  });

  it('explain_issue resolves a finding to its rule, source snippet and cause', async () => {
    const res = await client.callTool({
      name: 'explain_issue',
      arguments: { path: 'tests/ledger.test.ts', rule: 'TAUT-002', line: 11 },
    });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as {
      result: {
        rule: string;
        severity: string;
        message: string;
        cause: string;
        snippet: Array<{ line: number; text: string }>;
      };
    };
    expect(sc.result.rule).toBe('TAUT-002');
    expect(sc.result.severity).toBe('error');
    // span +/- 1 line around the assertion
    expect(sc.result.snippet.map((l) => l.line)).toEqual([10, 11, 12]);
    expect(sc.result.snippet.find((l) => l.line === 11)!.text).toContain('expect(mocked.getTotal()).toBe(42)');
    // a per-rule explainer sentence, not free text
    expect(sc.result.cause).toContain('stubbed');
  });

  it('explain_issue names the findings the file does have when the requested one is absent', async () => {
    const res = await client.callTool({
      name: 'explain_issue',
      arguments: { path: 'tests/ledger.test.ts', rule: 'DRIFT-003' },
    });
    expect(res.isError).toBe(true);
    const sc = res.structuredContent as { error: { code: string; hint: string } };
    expect(sc.error.code).toBe('NOT_FOUND');
    // The hint is what stops an agent guessing rule ids one call at a time.
    expect(sc.error.hint).toContain('TAUT-002@11');
    expect(sc.error.hint).toContain('DRIFT-001@16');
  });

  it('doctor_status reports per-language readiness and the rule catalog', async () => {
    const res = await client.callTool({ name: 'doctor_status', arguments: {} });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as {
      result: {
        languages: Record<string, { enabled: boolean; status: string; detail: string }>;
        rules: { total: number; enabled: number };
        cache: { enabled: boolean };
      };
    };
    // The fixture root has a tsconfig.json, so TS analysis is type-aware.
    expect(sc.result.languages.typescript).toMatchObject({ enabled: true, status: 'ready' });
    // PHP is off by default, which is a different thing from "enabled but unusable".
    expect(sc.result.languages.php).toMatchObject({ enabled: false, status: 'off' });
    expect(sc.result.languages.php.detail).toContain('.momusrc');
    // DRIFT-000 is not catalogued — it is the opt-in unresolvable-target info rule.
    expect(sc.result.rules.total).toBe(14);
    // This server is constructed with the cache disabled.
    expect(sc.result.cache.enabled).toBe(false);
  });

  it('audit_workspace sweeps every rule across the workspace in one call', async () => {
    const res = await client.callTool({ name: 'audit_workspace', arguments: {} });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as {
      result: { summary: { issues: number; errors: number }; issues: Array<{ rule: string }> };
    };
    // The planted-violations fixture: same 11 findings the golden audit pins.
    expect(sc.result.summary.issues).toBe(11);
    expect(sc.result.summary.errors).toBe(6);
    const rules = new Set(sc.result.issues.map((i) => i.rule));
    // A sweep spans rule families, unlike the single-family tools.
    expect(rules.has('TAUT-002')).toBe(true);
    expect(rules.has('DRIFT-001')).toBe(true);
  });

  it('audit_workspace groups findings that share a root cause', async () => {
    const res = await client.callTool({ name: 'audit_workspace', arguments: {} });
    const sc = res.structuredContent as {
      result: { dedupe: { causes: Array<{ rule: string; count: number; files: string[] }> } };
    };
    // TAUT-002 fires 5 times across two files; as one cause that is a single line for an
    // agent to act on rather than five to correlate by hand.
    const echo = sc.result.dedupe.causes.find((c) => c.rule === 'TAUT-002')!;
    expect(echo.count).toBe(5);
    expect(echo.files.sort()).toEqual(['tests/before-each.test.ts', 'tests/ledger.test.ts']);
    // Causes are ordered by how much they explain, so the biggest lever comes first.
    expect(sc.result.dedupe.causes[0]!.rule).toBe('TAUT-002');
  });

  it('explain_issue shows the production members a DRIFT-001 stub could have meant', async () => {
    // The planted spy targets LedgerService.totalForX, which does not exist. Naming what the
    // real type does expose is the whole answer to "so what should it have been".
    const res = await client.callTool({
      name: 'explain_issue',
      arguments: { path: 'tests/ledger.test.ts', rule: 'DRIFT-001' },
    });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as {
      result: { dependency?: { symbol: string; file: string; members: string[] } };
    };
    expect(sc.result.dependency?.symbol).toContain('LedgerService');
    expect(sc.result.dependency?.members).toContain('totalFor');
    expect(sc.result.dependency?.file).toBe('src/services/ledger.ts');
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

  it('verify_mock_drift scope=git-diff surfaces PHP drift for a renamed method', { timeout: 20_000 }, async () => {
    const repo = mkdtempSync(join(tmpdir(), 'momus-mcp-php-git-'));
    const run = (cmd: string) =>
      execFileSync('git', ['-C', repo, ...cmd.split(' ').filter(Boolean).slice(1)], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    try {
      run('git init -q -b main');
      run('git config user.email mcp@momus.dev');
      run('git config user.name mcp');
      mkdirSync(join(repo, 'src'), { recursive: true });
      mkdirSync(join(repo, 'tests'), { recursive: true });
      writeFileSync(join(repo, '.momusrc'), '{ "languages": { "php": true, "typescript": false } }\n');
      writeFileSync(
        join(repo, 'src', 'Worker.php'),
        '<?php\nclass Worker {\n  public function client(\n    $descriptor,\n    $policy\n  ): ProcessScannerClient {\n    return new ProcessScannerClient();\n  }\n}\n',
      );
      writeFileSync(
        join(repo, 'tests', 'WorkerTest.php'),
        "<?php\nclass WorkerTest extends TestCase {\n  public function testStub() {\n    $pool = $this->createStub(Worker::class);\n    $pool->method('client')->willReturn(new ProcessScannerClient());\n  }\n}\n",
      );
      run('git add -A');
      run('git commit -qm initial');
      // rename the method in production; the test's stub is now stale
      writeFileSync(
        join(repo, 'src', 'Worker.php'),
        '<?php\nclass Worker {\n  public function clientRenamed(\n    $descriptor,\n    $policy\n  ): ProcessScannerClient {\n    return new ProcessScannerClient();\n  }\n}\n',
      );

      const pair = InMemoryTransport.createLinkedPair();
      const server = createMomusServer({ root: repo });
      await server.connect(pair[0]);
      const client = new Client({ name: 'momus-php-git-test', version: '1.0.0' }, { capabilities: {} });
      await client.connect(pair[1]);
      try {
        const res = await client.callTool({
          name: 'verify_mock_drift',
          arguments: { scope: 'git-diff', baseRef: 'HEAD' },
        });
        expect(res.isError).toBeFalsy();
        const sc = res.structuredContent as { result: { issues: Array<{ rule: string }> } };
        // PHP class-target mocks participate in diff scope like TS ones
        expect(sc.result.issues.some((issue) => issue.rule === 'DRIFT-001')).toBe(true);
        expect(sc.result.issues.some((issue) => issue.rule === 'DRIFT-006')).toBe(true);
      } finally {
        await server.close();
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
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
      expect(tools).toHaveLength(9);
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

  it('watchWorkspace watches .rs files but ignores venv/build dirs', { timeout: 15_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'momus-watch-rs-'));
    mkdirSync(join(dir, '.venv'), { recursive: true });
    const changed: string[] = [];
    const watcher = watchWorkspace(dir, { onChange: (path) => changed.push(path) });
    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      writeFileSync(join(dir, 'lib.rs'), 'fn main() {}\n');
      await waitFor(() => changed.some((p) => p.endsWith('lib.rs')), 5_000);
      expect(changed.some((p) => p.endsWith('lib.rs'))).toBe(true);
      // a file under an ignored venv dir must not fire onChange
      writeFileSync(join(dir, '.venv', 'x.py'), 'x = 1\n');
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(changed.some((p) => p.includes('.venv'))).toBe(false);
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
    // union return: the non-null member drives the example value ('int|string' → 0)
    expect(text).toContain('either(): int|string');
    expect(text).toContain("shouldReceive('either')->andReturn(0);");
    // intersection + callable returns stay conservative (null)
    expect(text).toContain('both(): CollabA&CollabB');
    expect(text).toContain("shouldReceive('both')->andReturn(null);");
    expect(text).toContain('factory(): callable(): int');
    expect(text).toContain("shouldReceive('factory')->andReturn(null);");
    const sc = res.structuredContent as { result: { summary: { members: number } } };
    expect(sc.result.summary.members).toBe(7);
  });
});

describe('Momus MCP server (doctor_status with a disabled rule)', () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const pair = InMemoryTransport.createLinkedPair();
    const server = createMomusServer({
      root: FIXTURES,
      config: {
        ...DEFAULT_CONFIG,
        cache: { dir: '.momus/cache', enabled: false },
        // A .momusrc severity override is an object, not a bare string.
        rules: { 'TAUT-005': { severity: 'off' } },
      },
    });
    cleanup = () => server.close();
    await server.connect(pair[0]);
    client = new Client({ name: 'momus-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(pair[1]);
  });

  afterAll(async () => {
    await cleanup();
  });

  it('counts a rule switched off in .momusrc as disabled', async () => {
    const res = await client.callTool({ name: 'doctor_status', arguments: {} });
    const sc = res.structuredContent as {
      result: { rules: { total: number; enabled: number; disabled: string[] } };
    };
    expect(sc.result.rules.disabled).toEqual(['TAUT-005']);
    expect(sc.result.rules.enabled).toBe(sc.result.rules.total - 1);
  });
});

describe('Momus MCP server (doctor_status in a monorepo)', () => {
  it('reports TypeScript ready when the tsconfig governs a subdirectory, not the root', async () => {
    // Momus's own shape: tsconfig.base.json at the root, real tsconfig.json per package. The
    // parser resolves tsconfig by walking up from each FILE, so those files are fully
    // type-aware; reporting "degraded" here tells an agent to expect a loss of DRIFT-002/003
    // coverage it is not actually going to suffer.
    const workspace = mkdtempSync(join(tmpdir(), 'momus-monorepo-'));
    try {
      mkdirSync(join(workspace, 'packages', 'core', 'src'), { recursive: true });
      writeFileSync(join(workspace, 'tsconfig.base.json'), '{"compilerOptions":{"strict":true}}');
      writeFileSync(join(workspace, 'packages', 'core', 'tsconfig.json'), '{"include":["src"]}');
      writeFileSync(join(workspace, 'packages', 'core', 'src', 'a.ts'), 'export const a = 1;\n');

      const pair = InMemoryTransport.createLinkedPair();
      const server = createMomusServer({
        root: workspace,
        config: { ...DEFAULT_CONFIG, cache: { dir: '.momus/cache', enabled: false } },
      });
      await server.connect(pair[0]);
      const c = new Client({ name: 'momus-monorepo', version: '1.0.0' }, { capabilities: {} });
      await c.connect(pair[1]);
      try {
        const res = await c.callTool({ name: 'doctor_status', arguments: {} });
        const sc = res.structuredContent as {
          result: { languages: { typescript: { status: string } } };
        };
        expect(sc.result.languages.typescript.status).toBe('ready');
      } finally {
        await server.close();
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('still reports TypeScript degraded when the workspace has no tsconfig at all', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'momus-notsconfig-'));
    try {
      writeFileSync(join(workspace, 'a.ts'), 'export const a = 1;\n');
      const pair = InMemoryTransport.createLinkedPair();
      const server = createMomusServer({
        root: workspace,
        config: { ...DEFAULT_CONFIG, cache: { dir: '.momus/cache', enabled: false } },
      });
      await server.connect(pair[0]);
      const c = new Client({ name: 'momus-notsconfig', version: '1.0.0' }, { capabilities: {} });
      await c.connect(pair[1]);
      try {
        const res = await c.callTool({ name: 'doctor_status', arguments: {} });
        const sc = res.structuredContent as {
          result: { languages: { typescript: { status: string } } };
        };
        expect(sc.result.languages.typescript.status).toBe('degraded');
      } finally {
        await server.close();
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('Momus MCP server (Python language selection)', () => {
  let client: Client;
  let cleanup: () => Promise<void>;
  const PY_FIXTURES = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'packages',
    'parser-python',
    'test',
    'fixtures',
    'drift',
  );

  beforeAll(async () => {
    const pair = InMemoryTransport.createLinkedPair();
    const config = {
      ...DEFAULT_CONFIG,
      languages: { typescript: false, php: false, python: true },
      cache: { dir: '.momus/cache', enabled: false },
    };
    const server = createMomusServer({ root: PY_FIXTURES, config });
    cleanup = () => server.close();
    await server.connect(pair[0]);
    client = new Client({ name: 'momus-python-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(pair[1]);
  });

  afterAll(async () => {
    await cleanup();
  });

  it('routes Python audits through the composite parser', async () => {
    const res = await client.callTool({ name: 'verify_mock_drift', arguments: {} });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { result: { issues: Array<{ rule: string }> } };
    expect(sc.result.issues.some((issue) => issue.rule === 'DRIFT-001')).toBe(true);
    expect(sc.result.issues.some((issue) => issue.rule === 'DRIFT-003')).toBe(true);
  });

  it('detect_tautological_assertions surfaces the zero-reach stub', async () => {
    const res = await client.callTool({ name: 'detect_tautological_assertions', arguments: {} });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { result: { issues: Array<{ rule: string }> } };
    expect(sc.result.issues.every((issue) => issue.rule.startsWith('TAUT'))).toBe(true);
    expect(sc.result.issues.some((issue) => issue.rule === 'TAUT-005')).toBe(true);
  });

  it('synthesizes a pytest mock from a Python class', async () => {
    const res = await client.callTool({
      name: 'synthesize_mock_contract',
      arguments: { targetPath: 'repo.py', symbolName: 'Repo', framework: 'pytest' },
    });
    expect(res.isError).toBeFalsy();
    const text = res.content[0]!.text;
    expect(text).toContain('```python');
    expect(text).toContain("patch.object(Repo, 'save'");
    expect(text).toContain('return_value');
    const sc = res.structuredContent as { result: { summary: { members: number } } };
    expect(sc.result.summary.members).toBe(3);
  });
});

describe('Momus MCP server (Rust language selection)', () => {
  let client: Client;
  let cleanup: () => Promise<void>;
  const RUST_FIXTURES = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'packages',
    'parser-rust',
    'test',
    'fixtures',
    'drift',
  );

  beforeAll(async () => {
    const pair = InMemoryTransport.createLinkedPair();
    const config = {
      ...DEFAULT_CONFIG,
      languages: { typescript: false, php: false, python: false, rust: true },
      cache: { dir: '.momus/cache', enabled: false },
    };
    const server = createMomusServer({ root: RUST_FIXTURES, config });
    cleanup = () => server.close();
    await server.connect(pair[0]);
    client = new Client({ name: 'momus-rust-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(pair[1]);
  });

  afterAll(async () => {
    await cleanup();
  });

  it('routes Rust audits through the composite parser', async () => {
    const res = await client.callTool({ name: 'verify_mock_drift', arguments: {} });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { result: { issues: Array<{ rule: string }> } };
    expect(sc.result.issues.some((issue) => issue.rule === 'DRIFT-001')).toBe(true);
    expect(sc.result.issues.some((issue) => issue.rule === 'DRIFT-003')).toBe(true);
  });

  it('detect_tautological_assertions surfaces the zero-reach stub', async () => {
    const res = await client.callTool({ name: 'detect_tautological_assertions', arguments: {} });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { result: { issues: Array<{ rule: string }> } };
    expect(sc.result.issues.every((issue) => issue.rule.startsWith('TAUT'))).toBe(true);
    expect(sc.result.issues.some((issue) => issue.rule === 'TAUT-005')).toBe(true);
  });

  it('synthesizes a mockall mock from a Rust trait', async () => {
    const res = await client.callTool({
      name: 'synthesize_mock_contract',
      arguments: { targetPath: 'repo.rs', symbolName: 'Repo', framework: 'mockall' },
    });
    expect(res.isError).toBeFalsy();
    const text = res.content[0]!.text;
    expect(text).toContain('```rust');
    expect(text).toContain('mock!');
    expect(text).toContain('expect_find');
    const sc = res.structuredContent as { result: { summary: { members: number } } };
    expect(sc.result.summary.members).toBe(3); // find, save, record
  });

  it('synthesizes a mockito scaffold from a Rust trait', async () => {
    const res = await client.callTool({
      name: 'synthesize_mock_contract',
      arguments: { targetPath: 'repo.rs', symbolName: 'Repo', framework: 'mockito' },
    });
    expect(res.isError).toBeFalsy();
    const text = res.content[0]!.text;
    expect(text).toContain('```rust');
    expect(text).toContain('mockito::Server');
  });

  it('synthesizes type-derived return examples for rich Rust signatures', async () => {
    const res = await client.callTool({
      name: 'synthesize_mock_contract',
      arguments: { targetPath: 'types.rs', symbolName: 'Widget', framework: 'mockall' },
    });
    expect(res.isError).toBeFalsy();
    const text = res.content[0]!.text;
    expect(text).toContain('String::from("")');
    expect(text).toContain('None');
    expect(text).toContain('Ok(vec![])');
    expect(text).toContain('false');
    expect(text).toContain("'a'");
    expect(text).toContain('(0, false)');
    expect(text).toContain('panic!()'); // never-returning fn keeps an honest placeholder
  });
});
