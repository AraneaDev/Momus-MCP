/**
 * Momus-MCP server (spec docs/04). Subpath imports per F2; no stdout writes (F8);
 * annotations + structuredContent per §4.1.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  isInitializeRequest,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
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
  findUpwards,
  countFilesBySuffix,
  collectFixable,
  editsByFile,
  buildFixDiff,
  applyFixToFiles,
  phpProjectSignals,
  pythonProjectSignals,
  rustProjectSignals,
  type MomusConfig,
  type AuditResult,
  type TypeIR,
  type ParseCache,
  type ModuleIR,
  type Issue,
  type MockIR,
  type SymbolIR,
  type AssertionIR,
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
  /**
   * Watch the workspace and notify subscribers of `momus://issues/latest` when a source file
   * changes. Off by default: a watcher is a real fs handle, and a caller that only makes tool
   * calls should not pay for one. `momus serve --watch` turns it on.
   */
  watch?: boolean;
}

const ANN = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const RULES_URI = 'momus://rules';
const CONFIG_URI = 'momus://config';
const ISSUES_URI = 'momus://issues/latest';

/**
 * Absolute path for a workspace-relative input, or undefined when it escapes the root.
 * The check is on the resolved path, so `../` and absolute inputs are both caught.
 */
export function resolveInWorkspace(root: string, path: string): string | undefined {
  const rootAbs = resolve(root);
  const abs = isAbsolute(path) ? resolve(path) : resolve(rootAbs, path);
  const rel = relative(rootAbs, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return abs;
}

/** Tool execution error in the docs/04 §4.3 envelope shape. */
function errorResult(tool: string, code: string, message: string, hint: string) {
  return {
    content: [{ type: 'text' as const, text: `## Error\n\`${tool}\`: ${message}` }],
    structuredContent: { schemaVersion: 1, tool, error: { code, message, hint } },
    isError: true,
  };
}

/**
 * Collapse findings that share a root cause into one entry each.
 *
 * The key is the rule plus the evidence that distinguishes one cause from another — a renamed
 * production member flagged in eight test files is one rename, not eight problems, and an
 * agent that fixes it once clears all eight. The full issue list is still returned alongside,
 * so line-level work is unaffected; this is an index over it, not a replacement.
 *
 * Ordered by count so the biggest lever is first, then by rule id for determinism (docs/02
 * §2.4.3 — identical workspace, identical output).
 */
function groupByCause(result: AuditResult, root: string) {
  const causes = new Map<string, { rule: string; cause: string; count: number; files: Set<string> }>();
  for (const issue of result.issues) {
    // `evidence` is the per-rule discriminator (the missing member, the echoed value); without
    // one, every finding of that rule in the workspace is treated as the same cause.
    const key = `${issue.rule}\u0000${issue.evidence ?? ''}`;
    const rel = relative(root, issue.span.file).replace(/\\/g, '/');
    const existing = causes.get(key);
    if (existing) {
      existing.count++;
      existing.files.add(rel);
    } else {
      causes.set(key, {
        rule: issue.rule,
        cause: CAUSE_BY_RULE[issue.rule] ?? issue.message,
        count: 1,
        files: new Set([rel]),
      });
    }
  }
  const ordered = [...causes.values()]
    .map((c) => ({ rule: c.rule, cause: c.cause, count: c.count, files: [...c.files].sort() }))
    .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));
  return { causes: ordered, totalCauses: ordered.length, totalIssues: result.issues.length };
}

/**
 * `resolveIssue`'s two outcomes, spelled out rather than inferred. Left to inference, TS
 * normalises the union by adding `error?: undefined` to the success branch, which makes
 * `'error' in found` stop discriminating and lets `undefined` leak into every handler's
 * return type.
 */
interface ResolvedIssueFailure {
  error: ReturnType<typeof errorResult>;
}
interface ResolvedIssue {
  abs: string;
  rel: string;
  issue: Issue;
  matches: Issue[];
  audit: AuditResult;
}

/**
 * A rule's severity after config overrides. `.momusrc` may carry either a bare severity or a
 * `{ severity }` object, so both shapes have to be unwrapped — comparing the raw entry to
 * 'off' silently reports every rule as enabled.
 */
function effectiveSeverity(config: MomusConfig, rule: { id: string; severity: string }): string {
  const override = config.rules[rule.id];
  const sev = typeof override === 'object' ? override.severity : override;
  return sev ?? rule.severity;
}

/** Same skip set the other language counters use; a vendored tsconfig proves nothing. */
const TS_SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', 'vendor', 'dist']);

interface LanguageStatus {
  enabled: boolean;
  /** `off` = disabled in config · `ready` = manifest found · `degraded` = files but no manifest · `empty` = nothing to audit. */
  status: 'off' | 'ready' | 'degraded' | 'empty';
  detail: string;
}

/**
 * Per-language readiness, structured. The CLI's `doctor` prints prose built from the same
 * `@momus/core` signals; this returns the status as a value so an agent can branch on it
 * instead of parsing a sentence.
 */
function languageStatuses(root: string, config: MomusConfig): Record<string, LanguageStatus> {
  const off = (lang: string, hint: string): LanguageStatus => ({
    enabled: false,
    status: 'off',
    detail: `disabled — set "languages": { "${lang}": true } in .momusrc to audit ${hint}`,
  });
  const fromSignals = (
    manifest: string,
    present: boolean,
    files: number,
    ext: string,
    loose: string,
  ): LanguageStatus => {
    if (present) return { enabled: true, status: 'ready', detail: `${manifest} present, ${files} ${ext} file(s)` };
    if (files > 0)
      return { enabled: true, status: 'degraded', detail: `${files} ${ext} file(s) but no ${manifest} (${loose})` };
    return { enabled: true, status: 'empty', detail: `no ${manifest} or ${ext} files found` };
  };

  const out: Record<string, LanguageStatus> = {};
  // The TS parser resolves a tsconfig by walking UP from each source file (program.ts), so a
  // monorepo whose root holds only tsconfig.base.json is still fully type-aware through its
  // per-package configs. Checking the root alone reported Momus's own repo as degraded.
  const tsconfig = findUpwards(root, 'tsconfig.json') || countFilesBySuffix(root, 'tsconfig.json', 1, TS_SKIP_DIRS) > 0;
  out.typescript = config.languages.typescript
    ? tsconfig
      ? { enabled: true, status: 'ready', detail: 'tsconfig.json found, type-aware analysis available' }
      : { enabled: true, status: 'degraded', detail: 'no tsconfig.json (syntax-only mode; DRIFT-002/003 degrade)' }
    : off('typescript', 'Vitest/Jest suites');
  const php = phpProjectSignals(root);
  out.php = config.languages.php
    ? fromSignals('composer.json', php.composerJson, php.phpFiles, '.php', 'class resolution will be loose')
    : off('php', 'PHPUnit/Pest suites');
  const py = pythonProjectSignals(root);
  out.python = config.languages.python
    ? fromSignals('pyproject.toml', py.pyprojectToml, py.pyFiles, '.py', 'import resolution will be loose')
    : off('python', 'pytest/unittest suites');
  const rs = rustProjectSignals(root);
  out.rust = config.languages.rust
    ? fromSignals('Cargo.toml', rs.cargoToml, rs.rsFiles, '.rs', 'module resolution will be loose')
    : off('rust', 'mockall/mockito/wiremock suites');
  return out;
}

/**
 * Per-rule cause sentences: the 14 catalogued rules plus DRIFT-000, which is not catalogued
 * but can still be emitted under `includeUnresolved`. A fixed map, not free text: the
 * explanation an agent acts on has to be the same every run for the same rule, and composing
 * prose per finding would make the output non-deterministic (docs/02 §2.4.3) and unreviewable.
 */
const CAUSE_BY_RULE: Record<string, string> = {
  'TAUT-001':
    'Both sides of the comparison are the same expression, so the assertion holds no matter what the code does.',
  'TAUT-002':
    'The asserted value is the one the mock was stubbed to return, so the assertion re-states the stub instead of checking the subject.',
  'TAUT-003': 'Both operands are compile-time constants, so the comparison is decided before the code under test runs.',
  'TAUT-004':
    'Every operand is mock-derived and the enclosing test calls no production code, so nothing the subject does can change the result.',
  'TAUT-005':
    'The mock is configured but nothing invokes it and no assertion references it, so the stub is decorative.',
  'TAUT-006':
    'The spy has no stub, no recorded invocation, and the enclosing test runs no production code, so nothing could have called it.',
  'DRIFT-000': 'The mock target could not be resolved to a production symbol, so its contract cannot be checked.',
  'DRIFT-001':
    'The stubbed member does not exist on the production type: the double promises an API the real dependency no longer has.',
  'DRIFT-002':
    'The double\u2019s signature does not match production: a call valid against the mock would not type-check against the real dependency.',
  'DRIFT-003':
    'The configured return value is not assignable to the production return type, so the test feeds the subject a shape it can never receive.',
  'DRIFT-004': 'The double\u2019s constructor no longer matches the production constructor.',
  'DRIFT-005': 'The mocked module does not export the name being stubbed.',
  'DRIFT-006': 'A production change since the base ref touched this mock\u2019s target, so the double may be stale.',
  'MOCK-001':
    'Nearly every dependency is mocked and almost no assertion operand comes from production, so the test largely exercises its own doubles.',
  'MOCK-002':
    'The test mocks the module it is also exercising as the subject, so the thing under test is partly replaced by a stub.',
};

const irSpan = (s: { startLine: number; startCol: number; endLine: number; endCol: number }) => ({
  line: s.startLine,
  column: s.startCol,
  endLine: s.endLine,
  endColumn: s.endCol,
});

/** IR projections: stable, span-flattened shapes so agents never re-read the file to locate a node. */
function irMock(m: MockIR) {
  return {
    id: m.id,
    pattern: m.pattern,
    framework: m.framework,
    ...irSpan(m.span),
    target: m.target,
    stubbedMembers: m.stubbedMembers.map((s) => ({ name: s.name, api: s.api, returnValues: s.returnValues.length })),
    configuredValues: m.configuredValues.length,
    invocationSites: m.invocationSites.map((s) => s.startLine),
  };
}

function irSymbol(s: SymbolIR, exports: readonly string[]) {
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    ...irSpan(s.span),
    // SymbolIR carries no export flag; the module's `exports` list is the source of truth,
    // and it is what DRIFT-005 checks a mocked name against.
    exported: exports.includes(s.name),
    members: s.members.length,
    ...(s.visibility ? { visibility: s.visibility } : {}),
  };
}

function irAssertion(a: AssertionIR) {
  return {
    id: a.id,
    api: a.api,
    ...irSpan(a.span),
    fnId: a.fnId,
    operands: a.operands.map((o) => ({ text: o.text, provenance: o.provenance, mockRefs: o.mockRefs })),
  };
}

/** Compact human/LLM view; the structured content carries the full slice. */
function renderIrReport(rel: string, module: ModuleIR, kind: string): string {
  const lines = [
    `# Momus IR — ${rel}`,
    `${module.language} · ${module.kind} · framework: ${module.framework ?? 'none'} · slice: ${kind}`,
    '',
  ];
  if (kind === 'all' || kind === 'mocks') {
    lines.push(`## Mocks (${module.mocks.length})`);
    for (const m of module.mocks) {
      const reached =
        m.invocationSites.length > 0
          ? `reached@${m.invocationSites.map((s) => s.startLine).join(',')}`
          : 'never reached';
      const target = m.target?.memberName ?? m.target?.exportName ?? m.target?.modulePath ?? 'unresolved';
      lines.push(
        `- \`${rel}:${m.span.startLine}\` ${m.pattern} → ${target} · ${m.configuredValues.length} configured · ${reached}`,
      );
    }
    lines.push('');
  }
  if (kind === 'all' || kind === 'symbols') {
    lines.push(`## Symbols (${module.symbols.length})`);
    for (const s of module.symbols) {
      lines.push(
        `- \`${rel}:${s.span.startLine}\` ${s.kind} ${s.name}${module.exports.includes(s.name) ? ' (exported)' : ''}`,
      );
    }
    lines.push('');
  }
  if (kind === 'all' || kind === 'assertions') {
    lines.push(`## Assertions (${module.assertions.length})`);
    for (const a of module.assertions) {
      lines.push(`- \`${rel}:${a.span.startLine}\` ${a.api}(${a.operands.map((o) => o.provenance).join(', ')})`);
    }
    lines.push('');
  }
  if (module.diagnostics.length > 0) {
    lines.push(`## Parse diagnostics (${module.diagnostics.length})`);
    for (const d of module.diagnostics) lines.push(`- ${d.severity}: ${d.message}`);
  }
  return lines.join('\n').trimEnd();
}

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
    {
      capabilities: {
        tools: { listChanged: true },
        // `subscribe` is what makes notifications/resources/updated meaningful: a client that
        // subscribes to momus://issues/latest is told when a file change invalidated it.
        // docs/04 §4.1 documented a resources capability the server never declared — this is
        // that declaration, corrected to match what is actually served.
        resources: { subscribe: true, listChanged: false },
      },
    },
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

  /**
   * Newest audit this session has produced, served as `momus://issues/latest`. Not state the
   * protocol depends on — it is re-derivable by calling any audit tool — so a client that
   * never reads the resource is unaffected, and a restart simply starts empty.
   */
  let latestAudit: { result: AuditResult; tool: string; at: string } | undefined;

  const respond = (tool: string, result: AuditResult, label: string) => {
    latestAudit = { result, tool, at: new Date().toISOString() };
    notifyIssuesUpdated();
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
    'Deep static audit of a test file: every mock/stub/spy checked against its real production dependency (members, signatures, return types) plus tautological assertion detection.',
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
    'Scans test files for assertions that cannot fail: self-comparisons, mock-echo assertions, constant tautologies, mock-only assertions, zero-reach stubs, unconfigured spy assertions.',
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
    'Generates a strict typed mock fixture template directly from a production class/interface AST.',
    {
      targetPath: z.string().describe('Production file declaring the class/interface (workspace-relative)'),
      symbolName: z.string().optional().describe('Class/interface to mock; defaults to primary export'),
      framework: z
        .enum([
          'vitest',
          'jest',
          'phpunit',
          'pest',
          'pytest',
          'unittest',
          'mockall',
          'mockito',
          'wiremock',
          'httpmock',
          'mry',
          'faux',
          'mockers',
          'mockiato',
          'mocktopus',
          'mock_derive',
          'galvanic',
        ])
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
            : framework === 'mockall' ||
                framework === 'mockito' ||
                framework === 'wiremock' ||
                framework === 'httpmock' ||
                framework === 'mry' ||
                framework === 'faux' ||
                framework === 'mockers' ||
                framework === 'mockiato' ||
                framework === 'mocktopus' ||
                framework === 'mock_derive' ||
                framework === 'galvanic'
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

  /**
   * Resolve `{path, rule, line?}` to one issue by re-auditing just that file. Shared by
   * explain/preview/apply so all three address a finding identically; the parse cache makes
   * the narrow re-audit cheap.
   */
  const resolveIssue = (
    tool: string,
    path: string,
    rule: string,
    line?: number,
  ): ResolvedIssueFailure | ResolvedIssue => {
    const abs = resolveInWorkspace(root, path);
    if (!abs) {
      return {
        error: errorResult(
          tool,
          'NOT_FOUND',
          `path escapes the workspace root: ${path}`,
          'Pass a workspace-relative path inside the audited root.',
        ),
      };
    }
    if (!existsSync(abs)) {
      return { error: errorResult(tool, 'NOT_FOUND', `no such file: ${path}`, 'Pass a path that exists.') };
    }
    const rel = relative(root, abs).replace(/\\/g, '/');
    const audit = new AuditEngine({ root, parser, config, cache, paths: [rel], maxIssues: 500 }).run();
    const matches = audit.issues.filter((i) => i.rule === rule && (line === undefined || i.span.startLine === line));
    const issue = matches[0];
    if (!issue) {
      const seen = [...new Set(audit.issues.map((i) => `${i.rule}@${i.span.startLine}`))].join(', ');
      return {
        error: errorResult(
          tool,
          'NOT_FOUND',
          `no ${rule} finding${line === undefined ? '' : ` at line ${line}`} in ${path}`,
          seen ? `This file reports: ${seen}.` : 'This file reports no findings.',
        ),
      };
    }
    return { abs, rel, issue, matches, audit };
  };

  /** Short content hash: the freshness token an apply is checked against. */
  const contentHashOf = (abs: string): string =>
    createHash('sha256').update(readFileSync(abs, 'utf8')).digest('hex').slice(0, 16);

  const parseFile = (abs: string): ModuleIR =>
    parser.parseModule(abs, readFileSync(abs, 'utf8'), {
      config,
      resolveImport: (spec) => parser.resolveImport(spec, abs),
    });

  /**
   * The production side of a DRIFT finding: which real symbol the double stood in for, and
   * what that symbol actually exposes. "`totalForX` does not exist" only becomes actionable
   * once the agent can see that `totalFor` does.
   *
   * Resolved through the mock's `target.symbolId`, which is `<production file>#<Symbol>` (the
   * id convention in ir.ts), so a second single-file parse answers it — no workspace index
   * needed, and both parses are cache-backed.
   */
  const resolveDependency = (testFile: string, line: number) => {
    let mock;
    try {
      mock = parseFile(testFile).mocks.find((m) => m.span.startLine === line);
    } catch {
      return undefined;
    }
    const symbolId = mock?.target?.symbolId;
    const hash = symbolId === undefined ? -1 : symbolId.lastIndexOf('#');
    if (symbolId === undefined || hash < 0) return undefined;
    const depFile = symbolId.slice(0, hash);
    const symbolName = symbolId.slice(hash + 1);
    if (!existsSync(depFile)) return undefined;
    let symbol;
    try {
      symbol = parseFile(depFile).symbols.find((sym) => sym.name === symbolName);
    } catch {
      return undefined;
    }
    if (!symbol) return undefined;
    return {
      symbol: symbolName,
      file: relative(root, depFile).replace(/\\/g, '/'),
      kind: symbol.kind,
      line: symbol.span.startLine,
      members: symbol.members.map((m) => m.name).sort(),
      ...(mock?.target?.memberName ? { stubbed: mock.target.memberName } : {}),
    };
  };

  /**
   * Tell subscribed clients the audit snapshot moved on. Best-effort: a transport that is not
   * connected yet, or a client that never subscribed, must not turn a successful audit into a
   * failed tool call.
   */
  const notifyIssuesUpdated = () => {
    void server.server.sendResourceUpdated({ uri: ISSUES_URI }).catch(() => undefined);
  };

  const jsonResource = (uri: string, build: () => unknown) => ({
    contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(build(), null, 2) }],
  });

  server.registerResource(
    'rules',
    RULES_URI,
    { title: 'Rule catalog', description: 'The rule catalog with effective severities.', mimeType: 'application/json' },
    async () =>
      jsonResource(RULES_URI, () => ({
        rules: RULES_CATALOG.map((r) => {
          const severity = effectiveSeverity(config, r);
          return { id: r.id, name: r.name, severity, enabled: severity !== 'off', description: r.description };
        }),
      })),
  );

  server.registerResource(
    'config',
    CONFIG_URI,
    { title: 'Merged config', description: 'The effective .momusrc for this workspace.', mimeType: 'application/json' },
    async () => jsonResource(CONFIG_URI, () => config),
  );

  server.registerResource(
    'issues',
    ISSUES_URI,
    {
      title: 'Latest audit',
      description: 'Snapshot of the most recent audit run in this session.',
      mimeType: 'application/json',
    },
    async () =>
      jsonResource(ISSUES_URI, () =>
        latestAudit
          ? {
              audited: true,
              tool: latestAudit.tool,
              at: latestAudit.at,
              ...(buildJsonEnvelope(latestAudit.result, { workspaceRoot: root, tool: latestAudit.tool })
                .result as object),
            }
          : { audited: false, hint: 'Call audit_workspace (or any audit tool) to populate this.' },
      ),
  );

  // McpServer declares the resources capability but does not itself answer resources/subscribe,
  // so a client that subscribes gets "Method not found" and never receives an update. The
  // subscription set is per-session and advisory — notifications are broadcast to the
  // connected client either way; tracking it keeps unsubscribe honest.
  const subscriptions = new Set<string>();
  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    subscriptions.add(request.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    subscriptions.delete(request.params.uri);
    return {};
  });

  if (opts.watch) {
    // A source edit makes the snapshot stale even though no tool ran, which is exactly the
    // case polling cannot see. watchWorkspace already invalidates the ts.Program cache.
    const watcher = watchWorkspace(root, { onChange: () => notifyIssuesUpdated() });
    const closeCache = server.server.onclose;
    server.server.onclose = () => {
      void watcher.close();
      closeCache?.();
    };
  }

  server.tool(
    'apply_issue_fix',
    'Applies the auto-fix for exactly one finding, then re-audits the file and reports what cleared. Requires the contentHash from preview_issue_fix. The only tool that writes.',
    {
      path: z.string().describe('Test file path, workspace-relative'),
      rule: z.string().describe('Rule id from a prior audit'),
      line: z.number().int().min(1).optional().describe('Disambiguates a repeated rule'),
      contentHash: z.string().describe('contentHash from preview_issue_fix; refuses if the file moved on'),
    },
    {
      ...ANN,
      title: 'Apply Issue Fix',
      // The one tool that writes. A client decides whether to prompt from these, so a writer
      // advertised as read-only would be applied silently.
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
    async ({ path, rule, line, contentHash }) => {
      // Order matters: containment and freshness are checked before anything is read for
      // editing, so a refusal never depends on having already parsed attacker-chosen input.
      const found = resolveIssue('apply_issue_fix', path, rule, line);
      if ('error' in found) return found.error;
      const { abs, rel, issue, audit } = found;
      const actual = contentHashOf(abs);
      if (actual !== contentHash) {
        return errorResult(
          'apply_issue_fix',
          'STALE_CONTENT',
          `${rel} changed since the fix was previewed`,
          'Call preview_issue_fix again and apply with the contentHash it returns.',
        );
      }
      const fixable = collectFixable([issue]);
      if (fixable.length === 0) {
        return errorResult(
          'apply_issue_fix',
          'NOT_FIXABLE',
          `${issue.rule} at ${rel}:${issue.span.startLine} has no mechanically applicable fix`,
          'Semantic findings (TAUT-001/002/003) carry a described fix only; edit the test yourself.',
        );
      }
      const edits = editsByFile(fixable);
      const diff = buildFixDiff(root, edits);
      applyFixToFiles(root, edits);
      // The type-aware TS program is cached per workspace and still holds the pre-write
      // source, so without this the re-audit re-reports the finding we just fixed. The
      // watcher does the same on every file event.
      invalidateProgramCache();
      // The write is not the claim — the re-audit is. Report what actually cleared.
      const after = new AuditEngine({ root, parser, config, cache, paths: [rel], maxIssues: 500 }).run();
      const key = (i: Issue) => `${i.rule}@${i.span.startLine}`;
      const remaining = new Set(after.issues.map(key));
      const cleared = audit.issues.map(key).filter((k) => !remaining.has(k));
      const result = {
        path: rel,
        rule: issue.rule,
        line: issue.span.startLine,
        applied: true,
        description: issue.fix?.description ?? '',
        diff,
        issuesBefore: audit.issues.length,
        issuesAfter: after.issues.length,
        cleared,
        introduced: after.issues.map(key).filter((k) => !audit.issues.map(key).includes(k)),
        contentHash: contentHashOf(abs),
      };
      const text = [
        `# Applied ${issue.rule} — ${rel}:${issue.span.startLine}`,
        `${result.description}`,
        '',
        `${result.issuesBefore} → ${result.issuesAfter} findings in this file${cleared.length ? ` · cleared ${cleared.join(', ')}` : ''}`,
        '',
        '```diff',
        diff.trimEnd(),
        '```',
      ].join('\n');
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: { schemaVersion: 1, tool: 'apply_issue_fix', result },
      };
    },
  );

  server.tool(
    'preview_issue_fix',
    'Unified diff for the auto-fix of exactly one finding, applying nothing. Semantic findings answer fixable:false with a reason rather than erroring. Read-only.',
    {
      path: z.string().describe('Test file path, workspace-relative'),
      rule: z.string().describe('Rule id from a prior audit'),
      line: z.number().int().min(1).optional().describe('Disambiguates a repeated rule'),
    },
    { ...ANN, title: 'Preview Issue Fix' },
    async ({ path, rule, line }) => {
      const found = resolveIssue('preview_issue_fix', path, rule, line);
      if ('error' in found) return found.error;
      const { abs, rel, issue } = found;
      const fixable = collectFixable([issue]);
      const contentHash = contentHashOf(abs);
      if (fixable.length === 0) {
        // Not an error: TAUT-001/002/003 are semantic and carry descriptive suggestions only
        // (docs/03 §3.6), so "nothing to apply" is the correct, expected answer.
        const result = {
          path: rel,
          rule: issue.rule,
          line: issue.span.startLine,
          fixable: false,
          reason: issue.fix
            ? `${issue.rule} has no auto-fix: ${issue.fix.description}`
            : `${issue.rule} has no auto-fix (no mechanically applicable edit)`,
          contentHash,
        };
        return {
          content: [{ type: 'text' as const, text: `# ${issue.rule} — not auto-fixable\n${result.reason}` }],
          structuredContent: { schemaVersion: 1, tool: 'preview_issue_fix', result },
        };
      }
      const diff = buildFixDiff(root, editsByFile(fixable));
      const result = {
        path: rel,
        rule: issue.rule,
        line: issue.span.startLine,
        fixable: true,
        description: issue.fix?.description ?? '',
        diff,
        contentHash,
      };
      return {
        content: [
          {
            type: 'text' as const,
            text: `# ${issue.rule} — ${rel}:${issue.span.startLine}\n${result.description}\n\n\`\`\`diff\n${diff}\`\`\``,
          },
        ],
        structuredContent: { schemaVersion: 1, tool: 'preview_issue_fix', result },
      };
    },
  );

  server.tool(
    'audit_workspace',
    'Every rule across the whole workspace in one call, with findings grouped by root cause so an agent fixes causes, not lines. Read-only.',
    {
      scope: z.enum(['workspace', 'git-diff']).default('workspace').describe('git-diff requires baseRef'),
      baseRef: z.string().optional().describe('Git ref for git-diff scope'),
      paths: z.array(z.string()).optional().describe('Files/globs to restrict the sweep to'),
      maxIssues: z.number().int().min(0).max(500).default(100).describe('0 = summary-only'),
      includeSuppressed: z.boolean().default(false),
      dedupe: z.boolean().default(true).describe('Group findings by root cause'),
    },
    { ...ANN, title: 'Audit Workspace' },
    async ({ scope, baseRef, paths, maxIssues, includeSuppressed, dedupe }) => {
      if (scope === 'git-diff' && !baseRef) {
        return errorResult(
          'audit_workspace',
          'INVALID_BASE_REF',
          'baseRef is required when scope=git-diff',
          "Pass a ref such as 'main', or use scope='workspace'.",
        );
      }
      let diff: { baseRef: string; changedPaths: string[] } | undefined;
      if (scope === 'git-diff') {
        try {
          diff = { baseRef: baseRef!, changedPaths: gitChangedPaths(root, baseRef!) };
        } catch (e) {
          return errorResult(
            'audit_workspace',
            'INVALID_BASE_REF',
            `cannot resolve baseRef '${baseRef}': ${(e as Error).message.split('\n')[0]}`,
            'Pass an existing ref, or use scope=workspace.',
          );
        }
      }
      const result = new AuditEngine({
        root,
        parser,
        config,
        cache,
        paths,
        maxIssues,
        includeSuppressed,
        diff,
      }).run();
      const base = respond('audit_workspace', result, `${scope}${baseRef ? ' vs ' + baseRef : ''}`);
      if (!dedupe) return base;
      const structured = base.structuredContent as { result?: Record<string, unknown> };
      if (structured.result) structured.result.dedupe = groupByCause(result, root);
      return base;
    },
  );

  server.tool(
    'doctor_status',
    'Workspace readiness in one call: per-language status, the rule catalog, and cache health. Ask before a sweep to learn whether coverage will be degraded. Read-only.',
    {},
    { ...ANN, title: 'Doctor Status' },
    async () => {
      const languages = languageStatuses(root, config);
      const disabledRules = RULES_CATALOG.filter((r) => effectiveSeverity(config, r) === 'off').map((r) => r.id);
      const result = {
        root,
        node: process.version,
        languages,
        rules: {
          total: RULES_CATALOG.length,
          enabled: RULES_CATALOG.length - disabledRules.length,
          disabled: disabledRules,
        },
        cache: { enabled: config.cache.enabled, dir: config.cache.dir },
      };
      const text = [
        `# Momus doctor — ${root}`,
        `node ${process.version} · ${result.rules.enabled}/${result.rules.total} rules enabled · cache ${config.cache.enabled ? 'on' : 'off'}`,
        '',
        '## Languages',
        ...Object.entries(languages).map(([name, l]) => `- **${name}** — ${l.status}: ${l.detail}`),
      ].join('\n');
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: { schemaVersion: 1, tool: 'doctor_status', result },
      };
    },
  );

  server.tool(
    'explain_issue',
    'Resolves one finding to its root cause: the rule that fired, the source span, and a per-rule cause sentence. Address it by path + rule (+ line when a rule fires more than once). Read-only.',
    {
      path: z.string().describe('Test file path, workspace-relative'),
      rule: z.string().describe('Rule id from a prior audit, e.g. TAUT-002'),
      line: z.number().int().min(1).optional().describe('Disambiguates a rule that fired more than once'),
    },
    { ...ANN, title: 'Explain Issue' },
    async ({ path, rule, line }) => {
      const found = resolveIssue('explain_issue', path, rule, line);
      if ('error' in found) return found.error;
      const { abs, rel, issue, matches } = found;
      const source = readFileSync(abs, 'utf8').split(/\r?\n/);
      const from = Math.max(1, issue.span.startLine - 1);
      const to = Math.min(source.length, issue.span.endLine + 1);
      const snippet = [];
      for (let n = from; n <= to; n++) snippet.push({ line: n, text: source[n - 1] ?? '' });
      const result = {
        path: rel,
        rule: issue.rule,
        severity: issue.severity,
        message: issue.message,
        ...(issue.rule.startsWith('DRIFT') ? { dependency: resolveDependency(abs, issue.span.startLine) } : {}),
        cause: CAUSE_BY_RULE[issue.rule] ?? 'This rule fired; see the message for the specific condition.',
        line: issue.span.startLine,
        column: issue.span.startCol,
        snippet,
        ...(issue.evidence ? { evidence: issue.evidence } : {}),
        ...(issue.fix ? { fix: { description: issue.fix.description, code: issue.fix.code } } : {}),
        otherMatches: matches.length - 1,
      };
      const text = [
        `# ${issue.rule} — ${result.path}:${result.line}`,
        `${issue.severity} · ${issue.message}`,
        '',
        '## Why',
        result.cause,
        '',
        '## Source',
        '```',
        ...snippet.map((l) => `${String(l.line).padStart(4)} | ${l.text}`),
        '```',
        ...(issue.fix ? ['', `## Fix`, issue.fix.description] : []),
      ].join('\n');
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: { schemaVersion: 1, tool: 'explain_issue', result },
      };
    },
  );

  server.tool(
    'get_ir',
    'Returns the parser IR for one file (mocks, symbols, assertions) — the same shapes the rules consume. The "why did this fire / why did it not" debug surface. Read-only.',
    {
      path: z.string().describe('File path, workspace-relative'),
      kind: z.enum(['mocks', 'symbols', 'assertions', 'all']).default('all').describe('IR slice to return'),
    },
    { ...ANN, title: 'Get IR' },
    async ({ path, kind }) => {
      const abs = resolveInWorkspace(root, path);
      if (!abs) {
        return errorResult(
          'get_ir',
          'NOT_FOUND',
          `path escapes the workspace root: ${path}`,
          'Pass a workspace-relative path inside the audited root.',
        );
      }
      if (!existsSync(abs)) {
        return errorResult('get_ir', 'NOT_FOUND', `no such file: ${path}`, 'Pass a path that exists in the workspace.');
      }
      const source = readFileSync(abs, 'utf8');
      if (!parser.canParse(abs, source)) {
        return errorResult(
          'get_ir',
          'PARSE_ERROR',
          `no parser claims ${path}`,
          'Check which languages are enabled in .momusrc.',
        );
      }
      const module: ModuleIR = parser.parseModule(abs, source, {
        config,
        resolveImport: (spec) => parser.resolveImport(spec, abs),
      });
      const rel = relative(root, abs).replace(/\\/g, '/');
      const result: Record<string, unknown> = {
        path: rel,
        language: module.language,
        kind: module.kind,
        framework: module.framework,
        diagnostics: module.diagnostics,
      };
      if (kind === 'all' || kind === 'mocks') result.mocks = module.mocks.map(irMock);
      if (kind === 'all' || kind === 'symbols')
        result.symbols = module.symbols.map((sym) => irSymbol(sym, module.exports));
      if (kind === 'all' || kind === 'assertions') result.assertions = module.assertions.map(irAssertion);
      return {
        content: [{ type: 'text' as const, text: renderIrReport(rel, module, kind) }],
        structuredContent: { schemaVersion: 1, tool: 'get_ir', result },
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
        const sev = effectiveSeverity(config, r);
        return { ...r, severity: sev, enabled: sev !== 'off' };
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
            suppressionSyntax: '// @momus-ignore[:RULE] · /** @momus-ignore */ · // @momus-ignore-file[:RULE]',
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
// fs/path bindings come from the single import block at the top of this file.
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
  if (framework === 'faux') {
    // faux instruments the type in place (`#[faux::create]` + `#[faux::methods]`) and configures
    // via `faux::when!(mock.method).then(...)`.
    const setupLines = methods.map((m) => {
      const retVal = includeReturnValues ? rustReturnExample(m.signature?.returnType) : 'todo!()';
      return `    faux::when!(mock.${m.name}).then(|_| ${retVal});`;
    });
    body = [
      `#[faux::create]`,
      `pub struct ${name} {}`,
      ``,
      `#[faux::methods]`,
      `impl ${name} {`,
      ...sigs.map((s) => `    pub fn ${s.name}(&self${s.params ? ', ' + s.params : ''}) -> ${s.ret};`),
      `}`,
      ``,
      `#[test]`,
      `fn test_${lowerFirst(name)}() {`,
      `    let mut mock = ${name}::faux();`,
      ...setupLines,
      `}`,
    ];
  } else if (framework === 'mry') {
    // mry instruments the type in place (`#[mry::mry]`) and configures via `mock_<method>`.
    const mockName = `Mock${name}`;
    const implLines = sigs.map((s) => `        fn ${s.name}(&self${s.params ? ', ' + s.params : ''}) -> ${s.ret};`);
    const setupLines = methods.map((m) => {
      const retVal = includeReturnValues ? rustReturnExample(m.signature?.returnType) : 'todo!()';
      return `    mock.mock_${m.name}(mry::Any).returns(${retVal});`;
    });
    body = [
      `#[mry::mry]`,
      `impl ${name} {`,
      ...implLines,
      `}`,
      ``,
      `#[test]`,
      `fn test_${lowerFirst(name)}() {`,
      `    let mut mock = ${mockName}::default();`,
      ...setupLines,
      `}`,
    ];
  } else if (framework === 'mockers') {
    // mockers instruments the trait (`#[mocked]`) and configures expectations on the handle via
    // `scenario.expect(handle.<method>(…).and_return(…))`.
    const traitLines = sigs.map((s) => `    fn ${s.name}(&self${s.params ? ', ' + s.params : ''}) -> ${s.ret};`);
    const setupLines = methods.map((m) => {
      const retVal = includeReturnValues ? rustReturnExample(m.signature?.returnType) : 'todo!()';
      return `    scenario.expect(handle.${m.name}(ANY).and_return(${retVal}));`;
    });
    body = [
      `#[mocked]`,
      `trait ${name} {`,
      ...traitLines,
      `}`,
      ``,
      `#[test]`,
      `fn test_${lowerFirst(name)}() {`,
      `    let scenario = Scenario::new();`,
      `    let (mock, handle) = scenario.create_mock_for::<dyn ${name}>();`,
      ...setupLines,
      `}`,
    ];
  } else if (framework === 'mockiato') {
    // mockiato instruments the trait (`#[mockable]`, generated `NameMock`) and configures via
    // `mock.expect_<method>(…).returns(…)`.
    const mockName = `${name}Mock`;
    const traitLines = sigs.map((s) => `    fn ${s.name}(&self${s.params ? ', ' + s.params : ''}) -> ${s.ret};`);
    const setupLines = methods.map((m) => {
      const retVal = includeReturnValues ? rustReturnExample(m.signature?.returnType) : 'todo!()';
      return `    mock.expect_${m.name}(mockiato::Argument::any).returns(${retVal});`;
    });
    body = [
      `#[mockable]`,
      `trait ${name} {`,
      ...traitLines,
      `}`,
      ``,
      `#[test]`,
      `fn test_${lowerFirst(name)}() {`,
      `    let mut mock = ${mockName}::new();`,
      ...setupLines,
      `}`,
    ];
  } else if (framework === 'mocktopus') {
    // mocktopus instruments functions/methods in place (`#[mockable]`) and replaces them via
    // `Name::method.mock_safe(…)` / `.mock_raw(…)` with a `MockResult::Return` value.
    const implLines = sigs.map(
      (s) => `    fn ${s.name}(&self${s.params ? ', ' + s.params : ''}) -> ${s.ret} { todo!() }`,
    );
    const setupLines = methods.map((m) => {
      const retVal = includeReturnValues ? rustReturnExample(m.signature?.returnType) : 'todo!()';
      return `    unsafe { ${name}::${m.name}.mock_raw(|_| MockResult::Return(${retVal})); }`;
    });
    body = [
      `#[mockable]`,
      `impl ${name} {`,
      ...implLines,
      `}`,
      ``,
      `#[test]`,
      `fn test_${lowerFirst(name)}() {`,
      ...setupLines,
      `}`,
    ];
  } else if (framework === 'mock_derive') {
    // mock_derive instruments the trait (`#[mock]`, generated `Mock<Name>`) and configures via
    // `mock.method_<method>(…).first_call().set_result(…)` + `mock.set_<method>(…)`.
    const mockName = `Mock${name}`;
    const traitLines = sigs.map((s) => `    fn ${s.name}(&self${s.params ? ', ' + s.params : ''}) -> ${s.ret};`);
    const setupLines = methods.map((m) => {
      const retVal = includeReturnValues ? rustReturnExample(m.signature?.returnType) : 'todo!()';
      return `    mock.set_${m.name}(mock.method_${m.name}().first_call().set_result(${retVal}));`;
    });
    body = [
      `#[mock]`,
      `trait ${name} {`,
      ...traitLines,
      `}`,
      ``,
      `#[test]`,
      `fn test_${lowerFirst(name)}() {`,
      `    let mut mock = ${mockName}::new();`,
      ...setupLines,
      `}`,
    ];
  } else if (framework === 'galvanic') {
    // galvanic instruments the trait (`#[mockable]`) and configures via the `given! { … }` DSL
    // (`<mock as Trait>::method(…) then_return …`), enabled per-test with `#[use_mocks]`.
    const traitLines = sigs.map((s) => `    fn ${s.name}(&self${s.params ? ', ' + s.params : ''}) -> ${s.ret};`);
    const setupLines = methods.map((m) => {
      const retVal = includeReturnValues ? rustReturnExample(m.signature?.returnType) : 'todo!()';
      return `        <mock as ${name}>::${m.name}(galvanic_mock::matchers::any()) then_return ${retVal} always;`;
    });
    body = [
      `#[mockable]`,
      `trait ${name} {`,
      ...traitLines,
      `}`,
      ``,
      `#[test]`,
      `#[use_mocks]`,
      `fn test_${lowerFirst(name)}() {`,
      `    let mock = new_mock!(${name});`,
      ``,
      `    given! {`,
      ...setupLines,
      `    }`,
      `}`,
    ];
  } else if (framework === 'mockall') {
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
    // mockito / wiremock / httpmock target HTTP routes; the symbol carries no route info, so
    // emit a labeled scaffold the user wires to the real endpoint.
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
        : framework === 'httpmock'
          ? [
              `// Scaffold: httpmock mocks HTTP endpoints — wire the matcher below to the real one.`,
              `let server = httpmock::MockServer::start();`,
              `let _m = server.mock(|when, then| {`,
              `    when.method(GET).path("/path");`,
              `    then.status(200).body("");`,
              `});`,
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
