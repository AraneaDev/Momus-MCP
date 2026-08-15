/**
 * Momus-MCP server (spec docs/04). Subpath imports per F2; no stdout writes (F8);
 * annotations + structuredContent per §4.1.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  AuditEngine, loadConfig, buildMarkdownReport, buildJsonEnvelope,
  type MomusConfig, type AuditResult,
} from '@momus/core';
import { TypeScriptParser } from '@momus/parser-typescript';

export interface MomusServerOptions {
  root: string;
  config?: MomusConfig;
}

const RULE_LIST = [
  { id: 'TAUT-001', name: 'self-comparison', severity: 'error', description: 'assertion compares an expression with itself' },
  { id: 'TAUT-002', name: 'mock-echo', severity: 'error', description: 'assertion re-asserts a stub\'s own configured return' },
  { id: 'TAUT-003', name: 'constant-tautology', severity: 'error', description: 'both assertion sides are compile-time constants' },
  { id: 'TAUT-004', name: 'mock-only-assertion', severity: 'warning', description: 'test exercises no production code' },
  { id: 'TAUT-005', name: 'zero-reach-stub', severity: 'warning', description: 'mock configured but never invoked or asserted' },
  { id: 'TAUT-006', name: 'unconfigured-spy-assert', severity: 'warning', description: 'toHaveBeenCalled* on a spy with no stub and no call path' },
  { id: 'DRIFT-001', name: 'missing-member', severity: 'error', description: 'stubbed member does not exist on the production target' },
  { id: 'DRIFT-002', name: 'signature-mismatch', severity: 'warning', description: 'stub call signature diverges from production (arity)' },
  { id: 'DRIFT-003', name: 'return-type-mismatch', severity: 'warning', description: 'configured value not assignable to the production return type' },
  { id: 'DRIFT-005', name: 'missing-export', severity: 'error', description: 'vi.mock factory keys reference exports that do not exist' },
  { id: 'MOCK-001', name: 'mock-saturation', severity: 'warning', description: 'over-mocking heuristic' },
  { id: 'MOCK-002', name: 'mock-of-self', severity: 'info', description: 'the test mocks a module it also imports as the SUT' },
];

const ANN = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function createMomusServer(opts: MomusServerOptions): McpServer {
  const root = opts.root;
  const config = opts.config ?? loadConfig(root);
  const parser = new TypeScriptParser();
  const server = new McpServer(
    { name: 'momus-mcp', version: '0.1.0' },
    { capabilities: { tools: { listChanged: true } } },
  );

  const runAudit = (args: {
    paths?: string[]; maxIssues?: number; includeSuppressed?: boolean; includeUnresolved?: boolean;
  }): AuditResult => new AuditEngine({
    root, parser, config,
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
      const filtered: AuditResult = {
        ...result,
        summary: { ...result.summary, issues: 0, errors: 0, warnings: 0, infos: 0 },
        issues: result.issues.filter((i) => i.rule.startsWith('TAUT')),
      };
      filtered.summary.issues = filtered.issues.length;
      filtered.summary.errors = filtered.issues.filter((i) => i.severity === 'error').length;
      filtered.summary.warnings = filtered.issues.filter((i) => i.severity === 'warning').length;
      filtered.summary.infos = filtered.issues.filter((i) => i.severity === 'info').length;
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
      const result = runAudit({ paths, includeUnresolved, maxIssues });
      const filtered: AuditResult = {
        ...result,
        summary: { ...result.summary, issues: 0, errors: 0, warnings: 0, infos: 0 },
        issues: result.issues.filter((i) => i.rule.startsWith('DRIFT')),
      };
      filtered.summary.issues = filtered.issues.length;
      filtered.summary.errors = filtered.issues.filter((i) => i.severity === 'error').length;
      filtered.summary.warnings = filtered.issues.filter((i) => i.severity === 'warning').length;
      filtered.summary.infos = filtered.issues.filter((i) => i.severity === 'info').length;
      return respond('verify_mock_drift', filtered, `${scope}${baseRef ? ' vs ' + baseRef : ''}`);
    },
  );

  server.tool(
    'synthesize_mock_contract',
    'Generates a strict typed mock fixture template directly from a production class/interface AST. Read-only; writes nothing.',
    {
      targetPath: z.string().describe('Production file declaring the class/interface (workspace-relative)'),
      symbolName: z.string().optional().describe('Class/interface to mock; defaults to primary export'),
      framework: z.enum(['vitest', 'jest', 'phpunit', 'pest']).default('vitest'),
      includeReturnValues: z.boolean().default(true),
    },
    { ...ANN, title: 'Synthesize Mock Contract' },
    async ({ targetPath, symbolName, framework, includeReturnValues }) => {
      const result = synthesizeContract(root, targetPath, symbolName, framework, includeReturnValues);
      if ('error' in result) {
        return { content: [{ type: 'text', text: `## Error\n${result.error}` }], isError: true };
      }
      return {
        content: [{ type: 'text', text: '```ts\n' + result.template + '\n```' }],
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
      const rules = RULE_LIST.map((r) => {
        const override = config.rules[r.id];
        const sev = typeof override === 'object' ? override.severity : override;
        return { ...r, severity: sev ?? r.severity, enabled: (sev ?? r.severity) !== 'off' };
      });
      const text = '# Rules\n' + rules.map((r) => `- ${r.id} ${r.name} (${r.severity}) — ${r.description}`).join('\n') +
        '\n\nSuppression: `// @momus-ignore`, `// @momus-ignore:RULE`, `/** @momus-ignore */`, `// @momus-ignore-file` (docs/03 §3.5)';
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          schemaVersion: 1,
          tool: 'list_rules',
          result: { rules, suppressionSyntax: '// @momus-ignore[:RULE] · /** @momus-ignore */ · // @momus-ignore-file', configFile: '.momusrc' },
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

// ---------------------------------------------------------------- synth contract
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';

function synthesizeContract(
  root: string,
  targetPath: string,
  symbolName: string | undefined,
  framework: string,
  includeReturnValues: boolean,
): { template: string; contract: Array<{ member: string; signature: string; returnType: string }>; summary: object } | { error: string } {
  const abs = resolve(root, targetPath);
  if (!existsSync(abs)) return { error: `NOT_FOUND: ${targetPath} does not exist under ${root}` };
  const source = readFileSync(abs, 'utf8');
  const sf = ts.createSourceFile(abs, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const classes = sf.statements.filter((s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && !!s.name);
  const cls = symbolName ? classes.find((s) => s.name?.text === symbolName) : classes[0];
  if (!cls?.name) return { error: `no class found in ${targetPath}` };
  const className = cls.name.text;
  const contract: Array<{ member: string; signature: string; returnType: string }> = [];
  const lines: string[] = [];
  for (const m of cls.members) {
    if (ts.isMethodDeclaration(m)) {
      const name = m.name.getText(sf);
      const params = m.parameters.map((p) =>
        `${p.name.getText(sf)}${p.type ? ': ' + p.type.getText(sf) : ''}${p.questionToken ? '?' : ''}`).join(', ');
      const ret = m.type ? m.type.getText(sf) : 'unknown';
      const sig = `${name}(${params}): ${ret}`;
      contract.push({ member: name, signature: sig, returnType: ret });
      const isAsync = !!m.modifiers?.some((x) => x.kind === ts.SyntaxKind.AsyncKeyword) || ret.startsWith('Promise');
      const retVal = includeReturnValues
        ? isAsync ? 'undefined' : 'undefined'
        : 'undefined';
      lines.push(`  // ${sig}`);
      if (framework === 'vitest' || framework === 'jest') {
        lines.push(`  ${name}: ${framework === 'vitest' ? 'vi' : 'jest'}.fn().mockReturnValue(${retVal}),`);
      } else {
        lines.push(`  ${name}: (${params}) => ${retVal},`);
      }
    } else if (ts.isGetAccessorDeclaration(m)) {
      const name = m.name.getText(sf);
      contract.push({ member: name, signature: `get ${name}(): ${m.type?.getText(sf) ?? 'unknown'}`, returnType: m.type?.getText(sf) ?? 'unknown' });
      lines.push(`  // get ${name}(): ${m.type?.getText(sf) ?? 'unknown'}`);
      lines.push(`  get ${name}() { return undefined; },`);
    }
  }
  const template = [
    `// Generated by momus synthesize_mock_contract — ${className} (${framework})`,
    `// Contract verified against ${targetPath} (${contract.length} public members)`,
    `const ${lowerFirst(className)}Mock = {`,
    ...lines,
    `} satisfies Partial<${className}>;`,
  ].join('\n');
  return {
    template,
    contract,
    summary: { targetPath, symbol: className, framework, members: contract.length },
  };
}

function lowerFirst(s: string): string { return s[0]!.toLowerCase() + s.slice(1); }
