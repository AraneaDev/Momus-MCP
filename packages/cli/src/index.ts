#!/usr/bin/env node
/**
 * Momus CLI (spec docs/06 §6.4, roadmap Phase 1).
 * Exit codes: 0 clean · 1 findings · 2 config/usage error · 3 internal.
 */
import { writeFileSync, existsSync, realpathSync, readdirSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import {
  AuditEngine,
  buildMarkdownReport,
  buildJsonEnvelope,
  CompositeParser,
  gitChangedPaths,
  gitStagedPaths,
  loadConfig,
  ConfigError,
  DEFAULT_CONFIG,
  type Issue,
  type AuditResult,
  type MomusConfig,
} from '@momus/core';
import { TypeScriptParser } from '@momus/parser-typescript';
import { PhpParser } from '@momus/parser-php';
import { serve, serveHttp, watchWorkspace, openParseCache } from '@momus/mcp-server';
import { collectFixable, editsByFile, buildFixDiff, applyFixToFiles } from './fix.ts';

const HELP = `momus — unsparing mock & test integrity auditor

Usage:
  momus audit [paths...] [--max-issues N] [--json] [--summary] [--git-diff --base REF] [--fix [--yes]]
  momus drift [--include-unresolved] [--json] [--git-diff --base REF]
  momus precommit [--base REF]   (default base: HEAD — staged + working-tree changes)
  momus annotate-pr [--base REF] (GitHub Actions: post check annotations from the diff audit)
  momus annotate [paths...] [--git-diff --base REF]  (machine-readable JSONL for editor plugins)
  momus hook [--install|--uninstall] [--yes]  (install/run the staged-files pre-commit drift gate)
  momus contract <targetPath> [--framework vitest|jest|phpunit|pest] [--symbol NAME]
  momus rules
  momus serve [--root DIR] [--transport stdio|http] [--port N] [--watch]
  momus init [--force]
  momus doctor

Exit codes: 0 clean · 1 findings · 2 usage/config error · 3 internal error
`;

export function diffOptions(argv: string[]): { baseRef: string; changedPaths: string[] } | undefined {
  if (!argv.includes('--git-diff')) return undefined;
  const baseRef = argValue(argv, '--base');
  if (!baseRef) throw new Error('--git-diff requires --base <ref>');
  return { baseRef, changedPaths: gitChangedPaths(process.cwd(), baseRef) };
}

/** One JSON object per issue (JSONL) for editor plugins — workspace-relative paths, deterministic key order. */
export function buildAnnotateLines(issues: Issue[], root: string): string[] {
  return issues.map((issue) =>
    JSON.stringify({
      file: relative(root, issue.span.file).replace(/\\/g, '/'),
      line: issue.span.startLine,
      column: issue.span.startCol,
      endLine: issue.span.endLine,
      endColumn: issue.span.endCol,
      rule: issue.rule,
      severity: issue.severity,
      message: issue.message,
    }),
  );
}

/** Map issues to GitHub Checks API annotations (max 50 per request; message ≤ 64 KB). */
export function buildCheckAnnotations(
  issues: Issue[],
  root: string,
): Array<{
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: 'warning' | 'failure';
  message: string;
  title: string;
}> {
  return issues.map((issue) => ({
    path: relative(root, issue.span.file).replace(/\\/g, '/'),
    start_line: issue.span.startLine,
    end_line: Math.max(issue.span.startLine, issue.span.endLine),
    annotation_level: issue.severity === 'error' ? ('failure' as const) : ('warning' as const),
    title: issue.rule,
    message: `${issue.rule}: ${issue.message}`.slice(0, 64 * 1024 - 1),
  }));
}

export function createWorkspaceParser(): CompositeParser {
  return new CompositeParser([new TypeScriptParser(), new PhpParser()]);
}

/** PHP project signals used by `momus doctor` (bounded, read-only). */
export function phpProjectSignals(root: string): { composerJson: boolean; phpFiles: number } {
  return { composerJson: findComposerJson(root), phpFiles: countPhpFiles(root, 200) };
}

/** One-line PHP-language readiness summary for `momus doctor`. */
export function phpReadiness(root: string, config: MomusConfig): string {
  if (!config.languages.php) {
    return 'off — set "languages": { "php": true } in .momusrc to audit PHPUnit/Pest suites';
  }
  const { composerJson, phpFiles } = phpProjectSignals(root);
  if (composerJson) return `ready — composer.json present, ${phpFiles} .php file${phpFiles === 1 ? '' : 's'}`;
  if (phpFiles > 0)
    return `enabled — ${phpFiles} .php file${phpFiles === 1 ? '' : 's'} but no composer.json (class resolution will be loose)`;
  return 'enabled — no composer.json or .php files found';
}

function findComposerJson(root: string): boolean {
  let dir = root;
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(dir, 'composer.json'))) return true;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

function countPhpFiles(root: string, cap: number): number {
  let count = 0;
  const stack = [root];
  const seen = new Set<string>();
  while (stack.length && count < cap) {
    const dir = stack.pop()!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (count >= cap) break;
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'vendor' || entry.name === 'dist')
        continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.php')) count++;
    }
  }
  return count;
}

const HOOK_MARKER = '# Generated by momus hook --install';

/** `audit --fix`: dry-run diff by default; `--yes` applies; refused in CI without `--yes`. */
function runFix(result: AuditResult, root: string, apply: boolean): number {
  if (process.env.CI && !apply) {
    process.stderr.write('audit --fix: refusing to run in CI without --yes\n');
    return 2;
  }
  const fixable = collectFixable(result.issues);
  if (fixable.length === 0) {
    process.stdout.write('0 auto-fixable issues\n');
    return 0;
  }
  const edits = editsByFile(fixable);
  if (!apply) {
    process.stdout.write(buildFixDiff(root, edits));
    return 1; // fixes available
  }
  const changed = applyFixToFiles(root, edits);
  process.stdout.write(
    `applied ${fixable.length} fix${fixable.length === 1 ? '' : 'es'} across ${changed} file${changed === 1 ? '' : 's'}\n`,
  );
  return 0;
}

function resolveGitDir(root: string): string | undefined {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

/** The one sanctioned write per §1.5: install `.git/hooks/pre-commit` (gated by `--yes`). */
function installHook(root: string, yes: boolean): number {
  const gitDir = resolveGitDir(root);
  if (!gitDir) {
    process.stderr.write('hook --install: not a git repository\n');
    return 2;
  }
  const hooksDir = join(gitDir, 'hooks');
  const target = join(hooksDir, 'pre-commit');
  if (!existsSync(hooksDir)) {
    process.stderr.write(`hook --install: ${hooksDir} does not exist\n`);
    return 2;
  }
  if (!yes) {
    process.stderr.write('hook --install: requires --yes to write .git/hooks/pre-commit\n');
    return 2;
  }
  const entry = realpathSync(fileURLToPath(import.meta.url));
  const script = ['#!/bin/sh', HOOK_MARKER, `exec "${process.execPath}" "${entry}" hook`, ''].join('\n');
  writeFileSync(target, script);
  chmodSync(target, 0o755);
  process.stdout.write(`installed ${target}\n`);
  return 0;
}

/** Remove a momus-installed hook only (never a user's own script). */
function uninstallHook(root: string, yes: boolean): number {
  const gitDir = resolveGitDir(root);
  if (!gitDir) {
    process.stderr.write('hook --uninstall: not a git repository\n');
    return 2;
  }
  const target = join(gitDir, 'hooks', 'pre-commit');
  if (!existsSync(target)) {
    process.stdout.write('hook --uninstall: no pre-commit hook to remove\n');
    return 0;
  }
  if (!readFileSync(target, 'utf8').includes(HOOK_MARKER)) {
    process.stderr.write(`hook --uninstall: ${target} was not installed by momus; refusing to remove\n`);
    return 2;
  }
  if (!yes) {
    process.stderr.write('hook --uninstall: requires --yes to remove .git/hooks/pre-commit\n');
    return 2;
  }
  rmSync(target);
  process.stdout.write(`removed ${target}\n`);
  return 0;
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Flags that consume the following argument as their value (not a positional path). */
const FLAGS_WITH_VALUE = new Set([
  '--max-issues',
  '--base',
  '--framework',
  '--symbol',
  '--root',
  '--transport',
  '--port',
]);

/** Positional (non-flag) arguments, skipping values belonging to value-taking flags. */
function positionalArgs(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('-')) {
      if (FLAGS_WITH_VALUE.has(a)) i++; // consume the flag's value
      continue;
    }
    out.push(a);
  }
  return out;
}

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  const root = process.cwd();
  const json = argv.includes('--json');
  const summary = argv.includes('--summary');

  switch (cmd) {
    case 'audit': {
      const paths = positionalArgs(argv)
        .slice(1)
        .filter((p) => p !== '.' && p !== './'); // '.' = audit everything
      const maxIssues = Number(argValue(argv, '--max-issues') ?? '50');
      const config = loadConfig(root);
      const parser = createWorkspaceParser();
      const diff = diffOptions(argv);
      const cache = openParseCache(root, config.cache);
      const engine = new AuditEngine({
        root,
        parser,
        config,
        cache,
        paths: paths.length ? paths : undefined,
        maxIssues,
        diff,
      });
      const result = engine.run();
      cache?.close();
      if (argv.includes('--fix')) {
        return runFix(result, root, argv.includes('--yes'));
      }
      const scope = diff ? `git-diff vs ${diff.baseRef}` : paths.length ? paths.join(', ') : 'workspace';
      if (json) {
        process.stdout.write(
          JSON.stringify(buildJsonEnvelope(result, { tool: 'audit', workspaceRoot: root }), null, 2) + '\n',
        );
      } else {
        process.stdout.write(
          buildMarkdownReport(result, {
            workspaceRoot: root,
            verbosity: summary ? 'summary' : config.tokenBudget.verbosity,
            scopeLabel: scope,
          }),
        );
      }
      return result.summary.totalErrors > 0 ? 1 : 0;
    }

    case 'drift': {
      const config = loadConfig(root);
      const parser = createWorkspaceParser();
      const diff = diffOptions(argv);
      const engine = new AuditEngine({
        root,
        parser,
        config,
        includeUnresolved: argv.includes('--include-unresolved'),
        diff,
      });
      const result = engine.run();
      const driftIssues = result.issues.filter((i) => i.rule.startsWith('DRIFT'));
      const drift = { ...result, issues: driftIssues };
      if (json) {
        process.stdout.write(
          JSON.stringify(buildJsonEnvelope(drift, { tool: 'verify_mock_drift', workspaceRoot: root }), null, 2) + '\n',
        );
      } else {
        process.stdout.write(
          buildMarkdownReport(drift, {
            workspaceRoot: root,
            verbosity: summary ? 'summary' : config.tokenBudget.verbosity,
            scopeLabel: diff ? `drift vs ${diff.baseRef}` : 'drift scan',
          }),
        );
      }
      return driftIssues.some((i) => i.severity === 'error') ? 1 : 0;
    }

    case 'annotate': {
      const paths = positionalArgs(argv)
        .slice(1)
        .filter((p) => p !== '.' && p !== './');
      const maxIssues = Number(argValue(argv, '--max-issues') ?? '50');
      const config = loadConfig(root);
      const parser = createWorkspaceParser();
      const diff = diffOptions(argv);
      const engine = new AuditEngine({
        root,
        parser,
        config,
        paths: paths.length ? paths : undefined,
        maxIssues,
        diff,
      });
      const result = engine.run();
      for (const line of buildAnnotateLines(result.issues, root)) {
        process.stdout.write(line + '\n');
      }
      return result.summary.totalErrors > 0 ? 1 : 0;
    }

    case 'annotate-pr': {
      const token = process.env.GITHUB_TOKEN;
      const repo = process.env.GITHUB_REPOSITORY;
      const sha = process.env.GITHUB_SHA;
      if (!token || !repo || !sha) {
        process.stderr.write(
          'annotate-pr: GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_SHA are required (run inside GitHub Actions)\n',
        );
        return 2;
      }
      const baseRef = argValue(argv, '--base') ?? 'main';
      const config = loadConfig(root);
      const parser = createWorkspaceParser();
      let result: AuditResult;
      try {
        result = new AuditEngine({
          root,
          parser,
          config,
          diff: { baseRef, changedPaths: gitChangedPaths(root, baseRef) },
        }).run();
      } catch (e) {
        process.stderr.write(`annotate-pr: git error: ${(e as Error).message.split('\n')[0]}\n`);
        return 2;
      }
      const errors = result.summary.totalErrors;
      const warnings = result.summary.totalWarnings;
      const failOn = process.env.MOMUS_FAIL_ON ?? 'error';
      const failure = failOn === 'none' ? false : errors > 0 || (failOn === 'warning' && warnings > 0);
      const body = {
        name: 'momus',
        head_sha: sha,
        status: 'completed' as const,
        conclusion: failure ? ('failure' as const) : ('success' as const),
        output: {
          title: `Momus: ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`,
          summary: `${result.summary.filesAudited} files audited vs ${baseRef}; ${result.summary.totalIssues} total findings.`,
          annotations: buildCheckAnnotations(result.issues, root).slice(0, 50),
        },
      };
      const res = await fetch(`https://api.github.com/repos/${repo}/check-runs`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        process.stderr.write(`annotate-pr: GitHub API ${res.status}: ${(await res.text()).slice(0, 200)}\n`);
        return 3;
      }
      return failure ? 1 : 0;
    }

    case 'precommit': {
      const config = loadConfig(root);
      const parser = createWorkspaceParser();
      const baseRef = argValue(argv, '--base') ?? 'HEAD';
      let changedPaths: string[];
      try {
        changedPaths = gitChangedPaths(root, baseRef);
      } catch (e) {
        process.stderr.write(`precommit: git error: ${(e as Error).message.split('\n')[0]}\n`);
        return 2;
      }
      const engine = new AuditEngine({
        root,
        parser,
        config,
        includeUnresolved: argv.includes('--include-unresolved'),
        diff: { baseRef, changedPaths },
      });
      const result = engine.run();
      const driftIssues = result.issues.filter((i) => i.rule.startsWith('DRIFT'));
      if (json) {
        process.stdout.write(
          JSON.stringify(
            buildJsonEnvelope({ ...result, issues: driftIssues }, { tool: 'verify_mock_drift', workspaceRoot: root }),
            null,
            2,
          ) + '\n',
        );
      } else {
        process.stdout.write(
          buildMarkdownReport(
            { ...result, issues: driftIssues },
            {
              workspaceRoot: root,
              verbosity: summary ? 'summary' : config.tokenBudget.verbosity,
              scopeLabel: `precommit vs ${baseRef}`,
            },
          ),
        );
      }
      return driftIssues.some((i) => i.severity === 'error') ? 1 : 0;
    }

    case 'hook': {
      const sub = argv[1];
      if (sub === '--install' || sub === 'install') return installHook(root, argv.includes('--yes'));
      if (sub === '--uninstall' || sub === 'uninstall') return uninstallHook(root, argv.includes('--yes'));
      // No subcommand: run the staged-files drift gate (what the installed hook executes).
      const config = loadConfig(root);
      const parser = createWorkspaceParser();
      let staged: string[];
      try {
        staged = gitStagedPaths(root, 'HEAD');
      } catch (e) {
        process.stderr.write(`hook: git error: ${(e as Error).message.split('\n')[0]}\n`);
        return 2;
      }
      if (staged.length === 0) return 0;
      const engine = new AuditEngine({
        root,
        parser,
        config,
        includeUnresolved: argv.includes('--include-unresolved'),
        diff: { baseRef: 'HEAD', changedPaths: staged },
      });
      const result = engine.run();
      const driftIssues = result.issues.filter((i) => i.rule.startsWith('DRIFT'));
      if (json) {
        process.stdout.write(
          JSON.stringify(
            buildJsonEnvelope({ ...result, issues: driftIssues }, { tool: 'verify_mock_drift', workspaceRoot: root }),
            null,
            2,
          ) + '\n',
        );
      } else {
        process.stdout.write(
          buildMarkdownReport(
            { ...result, issues: driftIssues },
            {
              workspaceRoot: root,
              verbosity: summary ? 'summary' : config.tokenBudget.verbosity,
              scopeLabel: 'hook (staged files)',
            },
          ),
        );
      }
      return driftIssues.some((i) => i.severity === 'error') ? 1 : 0;
    }

    case 'contract': {
      const target = argv[1];
      if (!target) {
        process.stderr.write('usage: momus contract <targetPath> [--framework vitest]\n');
        return 2;
      }
      const framework = argValue(argv, '--framework') ?? 'vitest';
      const symbol = argValue(argv, '--symbol');
      // reuse the server's synthesis logic via a lightweight re-implementation
      const { synthesizeForCli } = await import('./synthesize.ts');
      const out = synthesizeForCli(root, target, symbol, framework);
      if ('error' in out) {
        process.stderr.write(`error: ${out.error}\n`);
        return 2;
      }
      process.stdout.write(out.template + '\n');
      return 0;
    }

    case 'rules': {
      const config = loadConfig(root);
      const { RULES_CATALOG } = await import('./catalog.ts');
      for (const r of RULES_CATALOG) {
        const override = config.rules[r.id];
        const sev = typeof override === 'object' ? override.severity : override;
        process.stdout.write(`${r.id} ${r.name} (${sev ?? r.severity}) — ${r.description}\n`);
      }
      process.stdout.write(
        '\nSuppression: // @momus-ignore | // @momus-ignore:RULE | /** @momus-ignore */ | // @momus-ignore-file\n',
      );
      return 0;
    }

    case 'serve': {
      const rootDir = argValue(argv, '--root') ?? root;
      if (argv.includes('--watch')) {
        watchWorkspace(rootDir); // invalidate the ts.Program cache on source changes
        process.stderr.write(`momus serve: watching ${rootDir} for changes\n`);
      }
      if (argValue(argv, '--transport') === 'http') {
        const port = Number(argValue(argv, '--port') ?? '3000');
        await serveHttp({ root: rootDir, port });
        await new Promise<void>(() => {}); // keep serving until terminated
        return 0;
      }
      await serve({ root: rootDir });
      return 0;
    }

    case 'init': {
      const force = argv.includes('--force');
      const target = join(root, '.momusrc');
      if (existsSync(target) && !force) {
        process.stderr.write('.momusrc already exists (use --force to overwrite)\n');
        return 2;
      }
      const template = `{
  "$schema": "./schemas/momusrc.schema.json",
  "languages": { "typescript": true, "php": false },
  "testFilePatterns": ["**/*.{test,spec}.{ts,tsx,js,jsx,mjs}", "**/__tests__/**"],
  "rules": {},
  "mockSaturationThreshold": 0.7,
  "tokenBudget": { "maxIssuesPerReport": 50, "maxIssueLineTokens": 100, "verbosity": "issues" }
}
`;
      writeFileSync(target, template);
      process.stdout.write(`wrote ${target}\n`);
      return 0;
    }

    case 'doctor': {
      let config: MomusConfig = { ...DEFAULT_CONFIG };
      try {
        config = loadConfig(root);
      } catch (e) {
        process.stdout.write(`  config error: ${e instanceof ConfigError ? e.message : 'unknown'}\n`);
      }
      process.stdout.write(`momus doctor\n  cwd:        ${root}\n  node:       ${process.version}\n`);
      const ts = await import('typescript').then((m) => m.version).catch(() => 'unavailable');
      process.stdout.write(`  typescript: ${ts}\n`);
      process.stdout.write(`  php-parser: available\n`);
      const cfg = existsSync(join(root, '.momusrc')) ? 'present' : 'absent (defaults)';
      process.stdout.write(`  .momusrc:   ${cfg}\n`);
      process.stdout.write(
        `  languages:  typescript=${config.languages.typescript ? 'enabled' : 'disabled'} php=${config.languages.php ? 'enabled' : 'disabled'}\n`,
      );
      process.stdout.write(`  php readiness: ${phpReadiness(root, config)}\n`);
      const testFiles = ['src', 'tests', 'test'].filter((d) => existsSync(join(root, d)));
      process.stdout.write(`  source dirs: ${testFiles.join(', ') || 'none found'}\n`);
      return 0;
    }

    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return 0;

    default:
      process.stderr.write(`unknown command '${cmd}'\n\n${HELP}`);
      return 2;
  }
}

function isEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const [, , ...args] = process.argv;
  main(args).then(
    (code) => process.exit(code),
    (e) => {
      if (e instanceof ConfigError) {
        process.stderr.write(`config error: ${e.message}\n`);
        process.exit(2);
      }
      process.stderr.write(`fatal: ${(e as Error).message}\n`);
      process.exit(3);
    },
  );
}
