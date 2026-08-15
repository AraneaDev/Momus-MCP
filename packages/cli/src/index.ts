#!/usr/bin/env node
/**
 * Momus CLI (spec docs/06 §6.4, roadmap Phase 1).
 * Exit codes: 0 clean · 1 findings · 2 config/usage error · 3 internal.
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AuditEngine, buildMarkdownReport, buildJsonEnvelope, loadConfig, ConfigError } from '@momus/core';
import { TypeScriptParser } from '@momus/parser-typescript';
import { serve } from '@momus/mcp-server';

const HELP = `momus — unsparing mock & test integrity auditor

Usage:
  momus audit [paths...] [--max-issues N] [--json] [--summary]
  momus drift [--include-unresolved] [--json]
  momus contract <targetPath> [--framework vitest|jest|phpunit|pest] [--symbol NAME]
  momus rules
  momus serve [--root DIR]
  momus init [--force]
  momus doctor

Exit codes: 0 clean · 1 findings · 2 usage/config error · 3 internal error
`;

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  const root = process.cwd();
  const json = argv.includes('--json');
  const summary = argv.includes('--summary');

  switch (cmd) {
    case 'audit': {
      const paths = argv.filter((a) => !a.startsWith('-') && !a.startsWith('--')).slice(1)
        .filter((p) => p !== '.' && p !== './'); // '.' = audit everything
      const maxIssues = Number(argValue(argv, '--max-issues') ?? '50');
      const config = loadConfig(root);
      const parser = new TypeScriptParser();
      const engine = new AuditEngine({ root, parser, config, paths: paths.length ? paths : undefined, maxIssues });
      const result = engine.run();
      const scope = paths.length ? paths.join(', ') : 'workspace';
      if (json) {
        process.stdout.write(JSON.stringify(buildJsonEnvelope(result, { tool: 'audit', workspaceRoot: root }), null, 2) + '\n');
      } else {
        process.stdout.write(buildMarkdownReport(result, {
          workspaceRoot: root,
          verbosity: summary ? 'summary' : config.tokenBudget.verbosity,
          scopeLabel: scope,
        }));
      }
      return result.summary.totalErrors > 0 ? 1 : 0;
    }

    case 'drift': {
      const config = loadConfig(root);
      const parser = new TypeScriptParser();
      const engine = new AuditEngine({
        root, parser, config,
        includeUnresolved: argv.includes('--include-unresolved'),
      });
      const result = engine.run();
      const driftIssues = result.issues.filter((i) => i.rule.startsWith('DRIFT'));
      const drift = { ...result, issues: driftIssues };
      if (json) {
        process.stdout.write(JSON.stringify(buildJsonEnvelope(drift, { tool: 'verify_mock_drift', workspaceRoot: root }), null, 2) + '\n');
      } else {
        process.stdout.write(buildMarkdownReport(drift, {
          workspaceRoot: root,
          verbosity: summary ? 'summary' : config.tokenBudget.verbosity,
          scopeLabel: 'drift scan',
        }));
      }
      return driftIssues.some((i) => i.severity === 'error') ? 1 : 0;
    }

    case 'contract': {
      const target = argv[1];
      if (!target) { process.stderr.write('usage: momus contract <targetPath> [--framework vitest]\n'); return 2; }
      const framework = argValue(argv, '--framework') ?? 'vitest';
      const symbol = argValue(argv, '--symbol');
      // reuse the server's synthesis logic via a lightweight re-implementation
      const { synthesizeForCli } = await import('./synthesize.ts');
      const out = synthesizeForCli(root, target, symbol, framework);
      if ('error' in out) { process.stderr.write(`error: ${out.error}\n`); return 2; }
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
      process.stdout.write('\nSuppression: // @momus-ignore | // @momus-ignore:RULE | /** @momus-ignore */ | // @momus-ignore-file\n');
      return 0;
    }

    case 'serve': {
      const rootDir = argValue(argv, '--root') ?? root;
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
  "languages": { "typescript": { "enabled": true }, "php": { "enabled": false } },
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
      process.stdout.write(`momus doctor\n  cwd:        ${root}\n  node:       ${process.version}\n`);
      const ts = await import('typescript').then((m) => m.version).catch(() => 'unavailable');
      process.stdout.write(`  typescript: ${ts}\n`);
      const cfg = existsSync(join(root, '.momusrc')) ? 'present' : 'absent (defaults)';
      process.stdout.write(`  .momusrc:   ${cfg}\n`);
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

const [,, ...args] = process.argv;
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
