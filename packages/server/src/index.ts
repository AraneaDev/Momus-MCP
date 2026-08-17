/**
 * Momus-MCP server (spec docs/04). Subpath imports per F2; no stdout writes (F8);
 * annotations + structuredContent per §4.1.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { watch } from 'chokidar';
import {
  AuditEngine,
  CompositeParser,
  gitChangedPaths,
  loadConfig,
  buildMarkdownReport,
  buildJsonEnvelope,
  filterResult,
  RULES_CATALOG,
  type MomusConfig,
  type AuditResult,
  type TypeIR,
  type ParseCache,
} from '@momus/core';
import {
  TypeScriptParser,
  invalidateProgramCache,
  getProgram,
  tsReturnExampleChecked,
  promiseTypeArg,
} from '@momus/parser-typescript';
import { PhpParser } from '@momus/parser-php';
import { PythonParser } from '@momus/parser-python';
import { RustParser } from '@momus/parser-rust';
import { openParseCache } from './cache.ts';

export { SqliteParseCache, openParseCache } from './cache.ts';

export interface MomusServerOptions {
  root: string;
  config?: MomusConfig;
  /** Pre-opened parse cache to reuse (serveHttp shares one across sessions). */
  cache?: ParseCache;
}

const ANN = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// Server version tracks the released package version (release-please bumps all
// @momus/* package.jsons in lockstep; package.json always ships with src/).
const SERVER_VERSION = (() => {
  try {
    const require = createRequire(import.meta.url);
    return (require('../package.json') as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export function createMomusServer(opts: MomusServerOptions): McpServer {
  const root = opts.root;
  const config = opts.config ?? loadConfig(root);
  const parser = new CompositeParser([new TypeScriptParser(), new PhpParser(), new PythonParser(), new RustParser()]);
  const cache = opts.cache ?? openParseCache(root, config.cache);
  const server = new McpServer(
    { name: 'momus-mcp', version: SERVER_VERSION },
    { capabilities: { tools: { listChanged: true } } },
  );
  // Only close the cache when this server opened it (serveHttp shares a single cache).
  if (cache && !opts.cache) server.server.onclose = () => cache.close?.();

  const runAudit = (args: {
    paths?: string[];
    maxIssues?: number;
    includeSuppressed?: boolean;
    includeUnresolved?: boolean;
  }): AuditResult =>
    new AuditEngine({
      root,
      parser,
      config,
      cache,
      paths: args.paths,
      maxIssues: args.maxIssues,
      includeSuppressed: args.includeSuppressed,
      includeUnresolved: args.includeUnresolved,
    }).run();

  const respond = (tool: string, result: AuditResult, label: string) => {
    const text = buildMarkdownReport(result, {
      workspaceRoot: root,
      verbosity: config.tokenBudget.verbosity,
      scopeLabel: label,
    });
    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: buildJsonEnvelope(result, { tool, workspaceRoot: root }),
    };
  };

  server.tool(
    'audit_test_fidelity',
    'Deep static audit of a test file: every mock/stub/spy checked against its real production dependency (members, signatures, return types) plus tautological assertion detection. Read-only; never executes tests.',
    {
      filePath: z.string().describe('Test file path, workspace-relative (e.g. tests/order.test.ts)'),
      rules: z.array(z.string()).optional().describe('Optional rule filter (TAUT-xxx / DRIFT-xxx / MOCK-xxx)'),
      maxIssues: z.number().int().min(0).max(500).default(50).describe('0 = summary-only'),
      includeSuppressed: z.boolean().default(false),
    },
    { ...ANN, title: 'Audit Test Fidelity' },
    async ({ filePath, maxIssues, includeSuppressed }) => {
      const result = runAudit({ paths: [filePath], maxIssues, includeSuppressed });
      return respond('audit_test_fidelity', result, filePath);
    },
  );

  server.tool(
    'detect_tautological_assertions',
    'Scans test files for assertions that cannot fail: self-comparisons, mock-echo assertions, constant tautologies, mock-only assertions, zero-reach stubs, unconfigured spy assertions. Read-only.',
    {
      paths: z.array(z.string()).optional().describe('Files or globs; defaults to all test files'),
      maxIssues: z.number().int().min(0).max(500).default(50).describe('0 = summary-only'),
    },
    { ...ANN, title: 'Detect Tautological Assertions' },
    async ({ paths, maxIssues }) => {
      const result = runAudit({ paths, maxIssues });
      const filtered = filterResult(result, (i) => i.rule.startsWith('TAUT'));
      return respond('detect_tautological_assertions', filtered, paths?.join(', ') || 'workspace');
    },
  );

  server.tool(
    'verify_mock_drift',
    'Fast scan for test doubles that no longer match their production contracts: missing members, signature/return-type mismatches, missing module exports. Read-only.',
    {
      scope: z.enum(['workspace', 'git-diff']).default('workspace').describe('git-diff requires baseRef'),
      baseRef: z.string().optional().describe('Git ref for git-diff scope'),
      paths: z.array(z.string()).optional(),
      includeUnresolved: z.boolean().default(false).describe('Include DRIFT-000 info entries'),
      maxIssues: z.number().int().min(0).max(500).default(50).describe('0 = summary-only'),
    },
    { ...ANN, title: 'Verify Mock Drift' },
    async ({ scope, baseRef, paths, includeUnresolved, maxIssues }) => {
      if (scope === 'git-diff' && !baseRef) {
        return {
          content: [{ type: 'text', text: '## Error\n`verify_mock_drift`: baseRef is required when scope=git-diff.' }],
          isError: true,
        };
      }
      let diff: { baseRef: string; changedPaths: string[] } | undefined;
      if (scope === 'git-diff') {
        try {
          diff = { baseRef: baseRef!, changedPaths: gitChangedPaths(root, baseRef!) };
        } catch (e) {
          return {
            content: [
              {
                type: 'text',
                text: `## Error\ngit-diff scope failed (${root}): ${(e as Error).message.split('\n')[0]}`,
              },
            ],
            isError: true,
          };
        }
      }
      const result = new AuditEngine({ root, parser, config, cache, paths, includeUnresolved, maxIssues, diff }).run();
      const filtered = filterResult(result, (i) => i.rule.startsWith('DRIFT'));
      return respond('verify_mock_drift', filtered, `${scope}${baseRef ? ' vs ' + baseRef : ''}`);
    },
  );

  server.tool(
    'synthesize_mock_contract',
    'Generates a strict typed mock fixture template directly from a production class/interface AST. Read-only; writes nothing.',
    {
      targetPath: z.string().describe('Production file declaring the class/interface (workspace-relative)'),
      symbolName: z.string().optional().describe('Class/interface to mock; defaults to primary export'),
      framework: z
        .enum(['vitest', 'jest', 'phpunit', 'pest', 'pytest', 'unittest', 'mockall', 'mockito', 'wiremock'])
        .default('vitest'),
      includeReturnValues: z.boolean().default(true),
    },
    { ...ANN, title: 'Synthesize Mock Contract' },
    async ({ targetPath, symbolName, framework, includeReturnValues }) => {
      const result = synthesizeContract(root, targetPath, symbolName, framework, includeReturnValues);
      if ('error' in result) {
        return { content: [{ type: 'text', text: `## Error\n${result.error}` }], isError: true };
      }
      const fence =
        framework === 'phpunit' || framework === 'pest'
          ? 'php'
          : framework === 'pytest' || framework === 'unittest'
            ? 'python'
            : framework === 'mockall' || framework === 'mockito' || framework === 'wiremock'
              ? 'rust'
              : 'ts';
      return {
        content: [{ type: 'text', text: '```' + fence + '\n' + result.template + '\n```' }],
        structuredContent: {
          schemaVersion: 1,
          tool: 'synthesize_mock_contract',
          result: { summary: result.summary, template: result.template, contract: result.contract, notes: [] },
        },
      };
    },
  );

  server.tool(
    'list_rules',
    'Returns the rule catalog with default severities and suppression syntax. Call this first to learn what Momus checks in this workspace.',
    {},
    { ...ANN, title: 'List Rules' },
    async () => {
      const rules = RULES_CATALOG.map((r) => {
        const override = config.rules[r.id];
        const sev = typeof override === 'object' ? override.severity : override;
        return { ...r, severity: sev ?? r.severity, enabled: (sev ?? r.severity) !== 'off' };
      });
      const text =
        '# Rules\n' +
        rules.map((r) => `- ${r.id} ${r.name} (${r.severity}) — ${r.description}`).join('\n') +
        '\n\nSuppression: `// @momus-ignore`, `// @momus-ignore:RULE`, `/** @momus-ignore */`, `// @momus-ignore-file` (docs/03 §3.5)';
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          schemaVersion: 1,
          tool: 'list_rules',
          result: {
            rules,
            suppressionSyntax: '// @momus-ignore[:RULE] · /** @momus-ignore */ · // @momus-ignore-file',
            configFile: '.momusrc',
          },
        },
      };
    },
  );

  return server;
}

export async function serve(opts: MomusServerOptions): Promise<void> {
  const server = createMomusServer(opts);
  await server.connect(new StdioServerTransport());
}

const SOURCE_RE = /\.(ts|tsx|js|jsx|mts|cts|mjs|php|py|rs)$/i;

/**
 * Watch the workspace for source-file changes (spec docs/06 §6.5, Phase 3): every add/change/
 * unlink of a TS/JS/PHP file invalidates the memoized ts.Program cache so the next tool call
 * reflects on-disk edits without a restart. `onChange` fires for each relevant path (for tests/
 * hooks).
 */
export function watchWorkspace(
  root: string,
  opts: { onChange?: (path: string) => void } = {},
): { close: () => Promise<void> } {
  const watcher = watch(root, {
    ignored: [
      /(^|[\\/])node_modules[\\/]/,
      /(^|[\\/])\.git[\\/]/,
      /(^|[\\/])dist[\\/]/,
      /(^|[\\/])vendor[\\/]/,
      /(^|[\\/])coverage[\\/]/,
      /(^|[\\/])\.momus[\\/]/,
      /(^|[\\/])\.venv[\\/]/,
      /(^|[\\/])venv[\\/]/,
      /(^|[\\/])__pycache__[\\/]/,
      /(^|[\\/])target[\\/]/,
    ],
    ignoreInitial: true,
    persistent: true,
  });
  const invalidate = (path: string) => {
    if (!SOURCE_RE.test(path)) return;
    invalidateProgramCache();
    opts.onChange?.(path);
  };
  watcher.on('add', invalidate).on('change', invalidate).on('unlink', invalidate);
  return { close: () => watcher.close() };
}

export interface HttpServeOptions extends MomusServerOptions {
  host?: string;
  port?: number;
  path?: string;
}

/**
 * Streamable HTTP transport (spec docs/04 §4.1, Phase 3). Stateless single-session mode;
 * all state lives in the workspace. Returns the bound port and a close() for tests.
 */
export async function serveHttp(opts: HttpServeOptions): Promise<{ port: number; close: () => Promise<void> }> {
  const path = opts.path ?? '/mcp';
  // One transport per MCP session (SDK Streamable HTTP is stateful per session; tools stay stateless).
  // A single parse cache is shared across sessions and closed once when the server shuts down.
  const config = opts.config ?? loadConfig(opts.root);
  const cache = openParseCache(opts.root, config.cache);
  const sessionOpts: HttpServeOptions = { ...opts, cache };
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const httpServer = createServer((req, res) => {
    void handleHttpRequest(req, res, path, transports, sessionOpts);
  });
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 3000;
  await new Promise<void>((resolveListen) => httpServer.listen(port, host, () => resolveListen()));
  const actualPort = (httpServer.address() as AddressInfo).port;
  process.stderr.write(`momus-mcp Streamable HTTP: http://${host}:${actualPort}${path}\n`);
  return {
    port: actualPort,
    close: async () => {
      await Promise.all([...transports.values()].map((transport) => transport.close()));
      transports.clear();
      await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
      cache?.close();
    },
  };
}

async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  transports: Map<string, StreamableHTTPServerTransport>,
  opts: HttpServeOptions,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== path) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  try {
    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;
    if (existing) {
      await existing.handleRequest(req, res);
      return;
    }
    if (req.method === 'POST' && !sessionId) {
      const body = await readRequestBody(req);
      const parsed = body ? JSON.parse(body) : undefined;
      if (!isInitializeRequest(parsed)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
            id: null,
          }),
        );
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      transport.onerror = (e) => {
        process.stderr.write(`momus-mcp transport error: ${(e as Error).message}\n`);
      };
      await createMomusServer(opts).connect(transport);
      await transport.handleRequest(req, res, parsed);
      return;
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id: null,
      }),
    );
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: `Internal server error: ${(e as Error).message}` },
          id: null,
        }),
      );
    }
  }
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolveBody(data));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- synth contract
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';

/** Type text for a parameter, inferring from its default initializer when unannotated. */
function paramTypeText(p: ts.ParameterDeclaration, sf: ts.SourceFile): string {
  if (p.type) return p.type.getText(sf);
  const init = p.initializer;
  if (!init) return 'unknown';
  const K = ts.SyntaxKind;
  if (init.kind === K.NumericLiteral || init.kind === K.BigIntLiteral) return 'number';
  if (ts.isPrefixUnaryExpression(init) && init.operator === K.MinusToken) return 'number';
  if (init.kind === K.StringLiteral || init.kind === K.NoSubstitutionTemplateLiteral) return 'string';
  if (init.kind === K.TrueKeyword || init.kind === K.FalseKeyword) return 'boolean';
  if (ts.isArrayLiteralExpression(init)) return 'unknown[]';
  if (ts.isObjectLiteralExpression(init)) return 'Record<string, unknown>';
  return 'unknown';
}

export function synthesizeContract(
  root: string,
  targetPath: string,
  symbolName: string | undefined,
  framework: string,
  includeReturnValues: boolean,
):
  | { template: string; contract: Array<{ member: string; signature: string; returnType: string }>; summary: object }
  | { error: string } {
  const abs = resolve(root, targetPath);
  if (!existsSync(abs)) return { error: `NOT_FOUND: ${targetPath} does not exist under ${root}` };
  const source = readFileSync(abs, 'utf8');
  if (/\.php$/i.test(abs)) {
    return synthesizePhpContract(abs, source, targetPath, symbolName, framework, includeReturnValues);
  }
  if (/\.py$/i.test(abs)) {
    return synthesizePythonContract(abs, source, targetPath, symbolName, framework, includeReturnValues);
  }
  if (/\.rs$/i.test(abs)) {
    return synthesizeRustContract(abs, source, targetPath, symbolName, framework, includeReturnValues);
  }
  const sf = ts.createSourceFile(abs, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const decls = sf.statements.filter(
    (s): s is ts.ClassDeclaration | ts.InterfaceDeclaration =>
      (ts.isClassDeclaration(s) || ts.isInterfaceDeclaration(s)) && !!s.name,
  );
  // Default to the first class when no symbol is named (backward-compatible), falling back to
  // the first interface only when the file declares no class.
  const target = symbolName
    ? decls.find((s) => s.name?.text === symbolName)
    : (decls.find((s) => ts.isClassDeclaration(s)) ?? decls[0]);
  if (!target?.name) return { error: `no class or interface found in ${targetPath}` };
  const className = target.name.text;
  const isInterface = ts.isInterfaceDeclaration(target);
  // Type-aware return examples: resolve named interface/class returns through the checker so
  // `User` / `Promise<User>` emit a data-shape literal instead of `undefined`. Falls back to
  // syntax-only `tsReturnExample` when the file isn't in a resolvable program.
  const handle = getProgram(abs);
  const checker = handle.program.getTypeChecker();
  const programSf = handle.program.getSourceFile(abs);
  const programTarget = programSf?.statements.find(
    (s): s is ts.ClassDeclaration | ts.InterfaceDeclaration =>
      (ts.isClassDeclaration(s) || ts.isInterfaceDeclaration(s)) && s.name?.text === className,
  );
  const programTypeNodes = new Map<string, ts.TypeNode | undefined>();
  for (const pm of programTarget?.members ?? []) {
    if (
      (ts.isMethodDeclaration(pm) ||
        ts.isMethodSignature(pm) ||
        ts.isGetAccessorDeclaration(pm) ||
        ts.isPropertySignature(pm)) &&
      pm.name &&
      pm.type
    ) {
      programTypeNodes.set(pm.name.getText(programSf), pm.type);
    }
  }
  // Class-level generics (`Box<T>`) are out of scope at the mock site → concrete to `unknown`
  // (both in member types and in the `Partial<Box<unknown>>` target).
  const classTypeParams = (target.typeParameters ?? []).map((tp) => tp.name.getText(sf));
  const concretize = (text: string, extra: string[] = []): string => {
    const names = [...classTypeParams, ...extra];
    return names.length === 0 ? text : text.replace(new RegExp(`\\b(${names.join('|')})\\b`, 'g'), 'unknown');
  };
  const exampleFor = (type: ts.TypeNode | undefined): string => tsReturnExampleChecked(checker, type);
  const contract: Array<{ member: string; signature: string; returnType: string }> = [];
  const lines: string[] = [];
  for (const m of target.members) {
    if (ts.isMethodDeclaration(m) || ts.isMethodSignature(m)) {
      // interface members carry no modifiers → implicitly public
      const flags = ts.isMethodDeclaration(m) ? ts.getCombinedModifierFlags(m) : 0;
      const isPublicInstance = !(
        flags &
        (ts.ModifierFlags.Private | ts.ModifierFlags.Protected | ts.ModifierFlags.Static)
      );
      if (!isPublicInstance) continue;
      const name = m.name.getText(sf);
      const params = m.parameters
        .map((p) => {
          const pname = p.name.getText(sf);
          const ptype = paramTypeText(p, sf);
          return `${pname}${p.questionToken ? '?' : ''}${ptype !== 'unknown' ? ': ' + ptype : ''}`;
        })
        .join(', ');
      const ret = m.type ? m.type.getText(sf) : 'unknown';
      const sig = `${name}(${params}): ${ret}`;
      contract.push({ member: name, signature: sig, returnType: ret });
      const programType = programTypeNodes.get(name) ?? m.type;
      const retVal = includeReturnValues ? exampleFor(programType) : 'undefined';
      const promiseArg = promiseTypeArg(programType) ?? promiseTypeArg(m.type);
      // Method-level generics (`identity<T>(x: T): T`) are out of scope at the mock site; the
      // emitted `vi.fn<[x: T], T>()` would reference an undefined `T`. Concrete the type params
      // to `unknown` in the mock template (the signature comment keeps the real generic).
      const methodTypeParams = (m.typeParameters ?? []).map((tp) => tp.name.getText(sf));
      lines.push(`  // ${sig}`);
      if (framework === 'vitest' || framework === 'jest') {
        const fn = framework === 'vitest' ? 'vi' : 'jest';
        const paramTypes = m.parameters
          .map((p) => {
            const pname = p.name.getText(sf);
            const optional = p.questionToken ? '?' : '';
            const variadic = p.dotDotDotToken ? '...' : '';
            const ptype = concretize(paramTypeText(p, sf), methodTypeParams);
            return `${variadic}${pname}${optional}: ${ptype}`;
          })
          .join(', ');
        const fnType = `${fn}.fn<[${paramTypes}], ${concretize(ret, methodTypeParams)}>()`;
        lines.push(
          promiseArg
            ? `  ${name}: ${fnType}.mockResolvedValue(${exampleFor(promiseArg)}),`
            : `  ${name}: ${fnType}.mockReturnValue(${retVal}),`,
        );
      } else {
        lines.push(`  ${name}: (${params}) => ${retVal},`);
      }
    } else if (ts.isGetAccessorDeclaration(m)) {
      const name = m.name.getText(sf);
      const programType = programTypeNodes.get(name) ?? m.type;
      contract.push({
        member: name,
        signature: `get ${name}(): ${m.type?.getText(sf) ?? 'unknown'}`,
        returnType: m.type?.getText(sf) ?? 'unknown',
      });
      lines.push(`  // get ${name}(): ${m.type?.getText(sf) ?? 'unknown'}`);
      lines.push(`  get ${name}() { return ${exampleFor(programType)}; },`);
    } else if (isInterface && ts.isPropertySignature(m)) {
      // interface data properties are plain values in the mock (not vi.fn stubs)
      const name = m.name.getText(sf);
      const programType = programTypeNodes.get(name) ?? m.type;
      contract.push({
        member: name,
        signature: `${name}${m.questionToken ? '?' : ''}: ${m.type?.getText(sf) ?? 'unknown'}`,
        returnType: m.type?.getText(sf) ?? 'unknown',
      });
      lines.push(`  ${name}: ${exampleFor(programType)},`);
    }
  }
  const genericArg = classTypeParams.length > 0 ? `<${classTypeParams.map(() => 'unknown').join(', ')}>` : '';
  const template = [
    `// Generated by momus synthesize_mock_contract — ${className} (${framework})`,
    `// Contract verified against ${targetPath} (${contract.length} public members)`,
    `const ${lowerFirst(className)}Mock = {`,
    ...lines,
    `} satisfies Partial<${className}${genericArg}>;`,
  ].join('\n');
  return {
    template,
    contract,
    summary: { targetPath, symbol: className, framework, members: contract.length },
  };
}

/** PHP path: parse the production class with the PHP plugin and emit phpunit/pest templates. */
function synthesizePhpContract(
  abs: string,
  source: string,
  targetPath: string,
  symbolName: string | undefined,
  framework: string,
  includeReturnValues: boolean,
):
  | { template: string; contract: Array<{ member: string; signature: string; returnType: string }>; summary: object }
  | { error: string } {
  const module = new PhpParser().parseModule(abs, source, { config: undefined, resolveImport: () => null });
  const cls = symbolName ? module.symbols.find((s) => s.name === symbolName) : module.symbols[0];
  if (!cls) return { error: `no class found in ${targetPath}` };
  const className = cls.name;
  const methods = cls.members.filter(
    (m) => m.name !== '__construct' && m.visibility !== 'private' && m.visibility !== 'protected' && !m.isStatic,
  );
  const contract: Array<{ member: string; signature: string; returnType: string }> = [];
  const lines: string[] = [];
  for (const m of methods) {
    const params = (m.signature?.parameters ?? [])
      .map((p) => {
        const prefix = `${p.variadic ? '...' : ''}$${p.name}`;
        return p.type ? `${renderPhpType(p.type)} ${prefix}` : prefix;
      })
      .join(', ');
    const ret = m.signature?.returnType ? renderPhpType(m.signature.returnType) : 'mixed';
    const sig = `${m.name}(${params})${m.signature?.returnType ? ': ' + ret : ''}`;
    contract.push({ member: m.name, signature: sig, returnType: ret });
    const retVal = includeReturnValues ? phpReturnExample(m.signature?.returnType) : 'null';
    lines.push(`  // ${sig}`);
    lines.push(
      framework === 'phpunit'
        ? `$mock->method('${m.name}')->willReturn(${retVal});`
        : `$mock->shouldReceive('${m.name}')->andReturn(${retVal});`,
    );
    // Methods documented with `@throws` get a ready-made exception-path stub (commented out).
    for (const thrown of m.signature?.throws ?? []) {
      const fqcn = thrown.startsWith('\\') ? thrown : `\\${thrown}`;
      lines.push(
        framework === 'phpunit'
          ? `  // @throws ${thrown} → $mock->method('${m.name}')->willThrowException(new ${fqcn}());`
          : `  // @throws ${thrown} → $mock->shouldReceive('${m.name}')->andThrow(new ${fqcn}());`,
      );
    }
  }
  const template = [
    `// Generated by momus synthesize_mock_contract — ${className} (${framework})`,
    `// Contract verified against ${targetPath} (${contract.length} public members)`,
    framework === 'phpunit' ? `$mock = $this->createMock(${className}::class);` : `$mock = mock(${className}::class);`,
    ...lines,
  ].join('\n');
  return {
    template,
    contract,
    summary: { targetPath, symbol: className, framework, members: contract.length },
  };
}

/** Render a language-neutral TypeIR back to a readable PHPDoc-ish type string. */
function renderPhpType(type: TypeIR): string {
  switch (type.kind) {
    case 'named':
      return type.typeArgs.length ? `${type.name}<${type.typeArgs.map(renderPhpType).join(', ')}>` : type.name;
    case 'union':
      return type.members.map(renderPhpType).join('|');
    case 'intersection':
      return type.members.map(renderPhpType).join('&');
    case 'literal':
      return JSON.stringify(type.value);
    case 'array':
      return type.element ? `${renderPhpType(type.element)}[]` : 'array';
    case 'tuple':
      return `[${type.elements.map(renderPhpType).join(', ')}]`;
    case 'function':
      return 'callable';
    case 'void':
    case 'never':
    case 'null':
    case 'undefined':
      return type.kind;
    case 'unknown':
      return 'mixed';
  }
}

/** A minimal, type-appropriate placeholder return value for the synthesized stub. */
function phpReturnExample(type: TypeIR | undefined): string {
  if (!type) return 'null';
  switch (type.kind) {
    case 'void':
    case 'null':
    case 'never':
    case 'undefined':
      return 'null';
    case 'array':
    case 'tuple':
      return '[]';
    case 'literal':
      return JSON.stringify(type.value);
    case 'unknown':
      return 'null';
    case 'named': {
      if (type.name === 'int' || type.name === 'float') return '0';
      if (type.name === 'string') return "''";
      if (type.name === 'bool') return 'false';
      if (type.name === 'array') return '[]';
      return 'null';
    }
    case 'union': {
      const nonNull = type.members.find((member) => member.kind !== 'null');
      return nonNull ? phpReturnExample(nonNull) : 'null';
    }
    case 'intersection':
      return 'null';
    case 'function':
      return 'null';
  }
}

function lowerFirst(s: string): string {
  return s[0]!.toLowerCase() + s.slice(1);
}

function synthesizePythonContract(
  abs: string,
  source: string,
  targetPath: string,
  symbolName: string | undefined,
  framework: string,
  includeReturnValues: boolean,
):
  | { template: string; contract: Array<{ member: string; signature: string; returnType: string }>; summary: object }
  | { error: string } {
  const module = new PythonParser().parseModule(abs, source, { config: undefined, resolveImport: () => null });
  const cls = symbolName
    ? module.symbols.find((s) => s.name === symbolName)
    : (module.symbols.find((s) => s.kind === 'class') ?? module.symbols[0]);
  if (!cls) return { error: `no class found in ${targetPath}` };
  const className = cls.name;
  const methods = cls.members.filter((m) => m.kind === 'method' && !m.name.startsWith('__'));
  const contract: Array<{ member: string; signature: string; returnType: string }> = [];
  const lines: string[] = [];
  for (const m of methods) {
    const params = (m.signature?.parameters ?? [])
      .filter((p) => p.name !== 'self' && p.name !== 'cls')
      .map((p) => {
        const prefix = `${p.variadic ? '*' : ''}${p.name}`;
        return p.type ? `${prefix}: ${renderPyType(p.type)}` : prefix;
      })
      .join(', ');
    const ret = m.signature?.returnType ? renderPyType(m.signature.returnType) : 'Any';
    const sig = `${m.name}(${params})${m.signature?.returnType ? ' -> ' + ret : ''}`;
    contract.push({ member: m.name, signature: sig, returnType: ret });
    const retVal = includeReturnValues ? pyReturnExample(m.signature?.returnType) : 'None';
    lines.push(`  # ${sig}`);
    lines.push(`  with patch.object(${className}, '${m.name}', return_value=${retVal}):`);
    lines.push('      pass');
  }
  const template = [
    `# Generated by momus synthesize_mock_contract — ${className} (${framework})`,
    `# Contract verified against ${targetPath} (${contract.length} public members)`,
    'from unittest.mock import patch',
    '',
    ...lines,
  ].join('\n');
  return {
    template,
    contract,
    summary: { targetPath, symbol: className, framework, members: contract.length },
  };
}

function renderPyType(type: TypeIR): string {
  switch (type.kind) {
    case 'named':
      return type.typeArgs.length ? `${type.name}[${type.typeArgs.map(renderPyType).join(', ')}]` : type.name;
    case 'union':
      return type.members.map(renderPyType).join(' | ');
    case 'intersection':
      return type.members.map(renderPyType).join(' & ');
    case 'literal':
      return typeof type.value === 'string' ? `'${type.value}'` : String(type.value);
    case 'array':
      return type.element ? `list[${renderPyType(type.element)}]` : 'list';
    case 'tuple':
      return `tuple[${type.elements.map(renderPyType).join(', ')}]`;
    case 'function':
      return 'Callable';
    case 'void':
    case 'never':
    case 'null':
    case 'undefined':
      return 'None';
    case 'unknown':
      return 'Any';
  }
}

function pyReturnExample(type: TypeIR | undefined): string {
  if (!type) return 'None';
  switch (type.kind) {
    case 'void':
    case 'null':
    case 'never':
    case 'undefined':
      return 'None';
    case 'array':
    case 'tuple':
      return '[]';
    case 'literal':
      return typeof type.value === 'string'
        ? `'${type.value}'`
        : type.value === true
          ? 'True'
          : type.value === false
            ? 'False'
            : String(type.value);
    case 'unknown':
      return 'None';
    case 'named': {
      const name = type.name;
      if (name === 'int' || name === 'float') return '0';
      if (name === 'str') return "''";
      if (name === 'bool') return 'False';
      if (name === 'list' || name === 'dict' || name === 'tuple' || name === 'set') return '[]';
      return 'None';
    }
    case 'union': {
      const nonNull = type.members.find((member) => member.kind !== 'null');
      return nonNull ? pyReturnExample(nonNull) : 'None';
    }
    case 'intersection':
    case 'function':
      return 'None';
  }
}

function synthesizeRustContract(
  abs: string,
  source: string,
  targetPath: string,
  symbolName: string | undefined,
  framework: string,
  includeReturnValues: boolean,
):
  | { template: string; contract: Array<{ member: string; signature: string; returnType: string }>; summary: object }
  | { error: string } {
  const module = new RustParser().parseModule(abs, source, { config: undefined, resolveImport: () => null });
  const sym = symbolName
    ? module.symbols.find((s) => s.name === symbolName)
    : module.symbols.find((s) => s.kind === 'interface' || s.kind === 'class' || s.kind === 'function');
  if (!sym) return { error: `no trait/struct found in ${targetPath}` };
  const name = sym.name;
  const methods = sym.members.filter((m) => m.kind === 'method');
  const contract: Array<{ member: string; signature: string; returnType: string }> = [];
  const sigs: Array<{ name: string; params: string; ret: string }> = [];
  for (const m of methods) {
    const params = (m.signature?.parameters ?? [])
      .map((p) => `${p.name}: ${renderRustType(p.type ?? { kind: 'unknown' })}`)
      .join(', ');
    const ret = m.signature?.returnType ? renderRustType(m.signature.returnType) : '()';
    const sig = `fn ${m.name}(&self${params ? ', ' + params : ''}) -> ${ret};`;
    contract.push({ member: m.name, signature: sig, returnType: ret });
    sigs.push({ name: m.name, params, ret });
  }
  let body: string[];
  if (framework === 'mockall') {
    const mockName = `Mock${name}`;
    const implLines = sigs.map((s) => `        fn ${s.name}(&self${s.params ? ', ' + s.params : ''}) -> ${s.ret};`);
    const setupLines = methods.map((m) => {
      const args = (m.signature?.parameters ?? []).map((p) => p.name);
      const retVal = includeReturnValues ? rustReturnExample(m.signature?.returnType) : 'todo!()';
      return `    mock.expect_${m.name}().returning(|${args.join(', ')}| ${retVal});`;
    });
    body = [
      `mock! {`,
      `    pub ${mockName} {}`,
      `    impl ${name} for ${mockName} {`,
      ...implLines,
      `    }`,
      `}`,
      ``,
      `#[test]`,
      `fn test_${lowerFirst(name)}() {`,
      `    let mut mock = ${mockName}::new();`,
      ...setupLines,
      `}`,
    ];
  } else {
    // mockito / wiremock target HTTP routes; the symbol carries no route info, so emit a
    // labeled scaffold the user wires to the real endpoint.
    body =
      framework === 'mockito'
        ? [
            `// Scaffold: mockito mocks HTTP endpoints — wire the route below to the real one.`,
            `let mut server = mockito::Server::new();`,
            `let _m = server.mock("GET", "/path")`,
            `    .with_status(200)`,
            `    .with_body("")`,
            `    .create();`,
          ]
        : [
            `// Scaffold: wiremock mocks HTTP requests — wire the matcher below to the real one.`,
            `Mock::given(method("GET"))`,
            `    .and(path("/path"))`,
            `    .respond_with(ResponseTemplate::new(200))`,
            `    .mount(&server)`,
            `    .await;`,
          ];
  }
  const template = [
    `// Generated by momus synthesize_mock_contract — ${name} (${framework})`,
    `// Contract verified against ${targetPath} (${contract.length} public members)`,
    '',
    ...body,
  ].join('\n');
  return {
    template,
    contract,
    summary: { targetPath, symbol: name, framework, members: contract.length },
  };
}

function renderRustType(type: TypeIR): string {
  switch (type.kind) {
    case 'named':
      return type.typeArgs.length ? `${type.name}<${type.typeArgs.map(renderRustType).join(', ')}>` : type.name;
    case 'void':
      return '()';
    case 'never':
      return '!';
    case 'tuple':
      return `(${type.elements.map(renderRustType).join(', ')})`;
    case 'literal':
      return JSON.stringify(type.value);
    case 'array':
      return type.element ? `Vec<${renderRustType(type.element)}>` : 'Vec<()>';
    case 'unknown':
      return '_';
    default:
      return '()';
  }
}

function rustReturnExample(type: TypeIR | undefined): string {
  if (!type) return 'todo!()';
  switch (type.kind) {
    case 'void':
      return '()';
    case 'never':
      return 'panic!()';
    case 'tuple':
      return `(${type.elements.map(rustReturnExample).join(', ')})`;
    case 'literal':
      return JSON.stringify(type.value);
    case 'unknown':
      return 'todo!()';
    case 'named': {
      const name = type.name;
      const ints = new Set(['u8', 'u16', 'u32', 'u64', 'usize', 'i8', 'i16', 'i32', 'i64', 'isize']);
      if (ints.has(name)) return '0';
      if (name === 'f32' || name === 'f64') return '0.0';
      if (name === 'bool') return 'false';
      if (name === 'String') return 'String::from("")';
      if (name === 'str' || name === '&str') return '""';
      if (name === 'char') return "'a'";
      if (name === 'Option') return 'None';
      if (name === 'Result') {
        const ok = type.typeArgs[0] ? rustReturnExample(type.typeArgs[0]) : '()';
        return `Ok(${ok})`;
      }
      if (name === 'Vec') return 'vec![]';
      return 'todo!()';
    }
    case 'union':
    case 'intersection':
    case 'array':
    case 'function':
    case 'null':
    case 'undefined':
      return 'todo!()';
  }
}
