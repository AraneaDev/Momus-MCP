import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createWorkspaceParser,
  buildCheckAnnotations,
  buildAnnotateLines,
  phpReadiness,
  phpProjectSignals,
} from '../src/index.ts';
import { DEFAULT_CONFIG } from '@momus/core';

const BIN = resolve(import.meta.dirname, '../../../node_modules/.bin/momus');

describe('CLI workspace parser selection', () => {
  it('claims both TypeScript and PHP files without executing the CLI entrypoint', () => {
    const parser = createWorkspaceParser();
    expect(parser.canParse('/workspace/tests/example.test.ts', '')).toBe(true);
    expect(parser.canParse('/workspace/tests/ExampleTest.php', '<?php')).toBe(true);
  });

  it('dispatches PHP source to the PHP parser', () => {
    const parser = createWorkspaceParser();
    const module = parser.parseModule('/workspace/tests/ExampleTest.php', '<?php final class ExampleTest {}', {
      config: undefined,
      resolveImport: () => null,
    });
    expect(module.language).toBe('php');
  });
});

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'momus-precommit-'));
  runGit(dir, 'git init -q -b main');
  runGit(dir, 'git config user.email precommit@momus.dev');
  runGit(dir, 'git config user.name precommit');
  mkdirSync(join(dir, 'src', 'services'), { recursive: true });
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'services', 'ledger.ts'),
    [
      'export class LedgerService {',
      '  async totalFor(invoiceId: string): Promise<number> { return 0; }',
      '}',
      '',
    ].join('\n'),
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
  runGit(dir, 'git add -A');
  runGit(dir, 'git commit -qm initial');
  return dir;
}

function runGit(dir: string, cmd: string): void {
  execFileSync('git', ['-C', dir, ...cmd.split(' ').filter(Boolean).slice(1)], { encoding: 'utf8', stdio: 'pipe' });
}

describe('annotate JSONL', () => {
  it('emits deterministic one-object-per-line output for editor plugins', () => {
    const lines = buildAnnotateLines(
      [
        {
          id: 'i1',
          rule: 'DRIFT-001',
          severity: 'error' as const,
          span: { file: '/repo/tests/ledger.test.ts', startLine: 16, startCol: 5, endLine: 16, endCol: 40 },
          message: 'missing-member: totalForX does not exist on LedgerService',
          tokens: 42,
        },
        {
          id: 'i2',
          rule: 'TAUT-002',
          severity: 'error' as const,
          span: { file: '/repo/tests/ledger.test.ts', startLine: 11, startCol: 5, endLine: 11, endCol: 30 },
          message: 'mock-echo: 42',
          tokens: 10,
        },
      ] as never,
      '/repo',
    );
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(first).toMatchObject({
      file: 'tests/ledger.test.ts',
      line: 16,
      column: 5,
      rule: 'DRIFT-001',
      severity: 'error',
    });
    expect(lines[1]).toContain('TAUT-002');
  });
});

describe('annotate-pr annotations', () => {
  it('maps issues to GitHub check annotations with workspace-relative paths', () => {
    const issues = [
      {
        id: 'i1',
        rule: 'DRIFT-001',
        severity: 'error' as const,
        span: { file: '/repo/tests/ledger.test.ts', startLine: 16, startCol: 5, endLine: 16, endCol: 40 },
        message: 'missing-member: totalForX does not exist on LedgerService',
        tokens: 42,
      },
      {
        id: 'i2',
        rule: 'TAUT-006',
        severity: 'warning' as const,
        span: { file: '/repo/tests/ledger.test.ts', startLine: 18, startCol: 5, endLine: 18, endCol: 30 },
        message: 'unconfigured-spy-assert',
        tokens: 10,
      },
    ];
    const annotations = buildCheckAnnotations(issues as never, '/repo');
    expect(annotations).toHaveLength(2);
    expect(annotations[0]).toMatchObject({
      path: 'tests/ledger.test.ts',
      start_line: 16,
      end_line: 16,
      annotation_level: 'failure',
      title: 'DRIFT-001',
    });
    expect(annotations[1]!.annotation_level).toBe('warning');
    expect(annotations[0]!.message).toContain('missing-member');
  });
});

describe('CLI bin entrypoint', () => {
  it('precommit flags mocks left stale by a production change (DRIFT-006 + DRIFT-001)', { timeout: 30_000 }, () => {
    const repo = gitRepo();
    try {
      // rename a production member without touching the test
      writeFileSync(
        join(repo, 'src', 'services', 'ledger.ts'),
        [
          'export class LedgerService {',
          '  async totalForRenamed(invoiceId: string): Promise<number> { return 0; }',
          '}',
          '',
        ].join('\n'),
      );
      const result = spawnSync(process.execPath, [BIN, 'precommit'], { cwd: repo, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toMatch(/DRIFT-006/);
      expect(result.stdout).toMatch(/DRIFT-001/);
      // healthy twin: updating the test file alongside the production change clears both
      writeFileSync(
        join(repo, 'tests', 'ledger.test.ts'),
        [
          "import { describe, expect, it, vi } from 'vitest';",
          "import { LedgerService } from '../src/services/ledger';",
          "describe('LedgerService', () => {",
          "  it('spies on a member', () => {",
          '    const service = new LedgerService();',
          "    const spy = vi.spyOn(service, 'totalForRenamed');",
          '    expect(spy).toHaveBeenCalled();',
          '  });',
          '});',
          '',
        ].join('\n'),
      );
      const fixed = spawnSync(process.execPath, [BIN, 'precommit'], { cwd: repo, encoding: 'utf8' });
      expect(fixed.status, fixed.stderr).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('executes the audit through the npm bin symlink and reports planted findings', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'momus-bin-'));
    try {
      writeFileSync(
        join(fixture, 'planted.test.ts'),
        [
          "import { describe, expect, it, vi } from 'vitest';",
          "describe('planted', () => {",
          "  it('echoes the stubbed value against itself', () => {",
          '    const mocked = { getTotal: vi.fn() };',
          '    mocked.getTotal.mockReturnValue(42);',
          '    expect(mocked.getTotal()).toBe(42);',
          '  });',
          '});',
          '',
        ].join('\n'),
      );
      // Root is the cwd; '.' audits the whole fixture tree (same shape as the CI smoke).
      const result = spawnSync(process.execPath, [BIN, 'audit', '.'], { cwd: fixture, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toMatch(/TAUT-002/);
      expect(result.stdout).toMatch(/CLEAN:false/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe('audit --fix', () => {
  function planted(): string {
    const fixture = mkdtempSync(join(tmpdir(), 'momus-fix-'));
    writeFileSync(
      join(fixture, 'planted.test.ts'),
      [
        "import { describe, expect, it, vi } from 'vitest';",
        "describe('planted', () => {",
        "  it('echoes the stubbed value against itself', () => {",
        '    const mocked = { getTotal: vi.fn() };',
        '    mocked.getTotal.mockReturnValue(42);',
        '    expect(mocked.getTotal()).toBe(42);',
        '  });',
        '});',
        '',
      ].join('\n'),
    );
    return fixture;
  }

  it('reports zero auto-fixable issues when rules emit no real fix code', () => {
    const fixture = planted();
    try {
      const res = spawnSync(process.execPath, [BIN, 'audit', '--fix'], { cwd: fixture, encoding: 'utf8' });
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain('0 auto-fixable issues');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('refuses to run --fix in CI without --yes', () => {
    const fixture = planted();
    try {
      const res = spawnSync(process.execPath, [BIN, 'audit', '--fix'], {
        cwd: fixture,
        encoding: 'utf8',
        env: { ...process.env, CI: 'true' },
      });
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/refusing to run in CI without --yes/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('dry-runs and applies a rename fix for a stale spy', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'momus-fix-apply-'));
    try {
      mkdirSync(join(fixture, 'src'), { recursive: true });
      mkdirSync(join(fixture, 'tests'), { recursive: true });
      writeFileSync(
        join(fixture, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }),
      );
      writeFileSync(join(fixture, 'src', 'svc.ts'), 'export class Svc { totalFor(): number { return 0; } }\n');
      const testFile = join(fixture, 'tests', 'svc.test.ts');
      writeFileSync(
        testFile,
        [
          "import { expect, it, vi } from 'vitest';",
          "import { Svc } from '../src/svc';",
          "it('spies', () => {",
          '  const s = new Svc();',
          "  const spy = vi.spyOn(s, 'totalForX');",
          '  expect(spy).toHaveBeenCalled();',
          '});',
          '',
        ].join('\n'),
      );
      const dry = spawnSync(process.execPath, [BIN, 'audit', '--fix'], { cwd: fixture, encoding: 'utf8' });
      expect(dry.status, dry.stderr).toBe(1);
      expect(dry.stdout).toContain("'totalForX'");
      expect(dry.stdout).toContain("'totalFor'");
      expect(readFileSync(testFile, 'utf8')).toContain("'totalForX'"); // dry-run leaves the file untouched

      const apply = spawnSync(process.execPath, [BIN, 'audit', '--fix', '--yes'], { cwd: fixture, encoding: 'utf8' });
      expect(apply.status, apply.stderr).toBe(0);
      const fixed = readFileSync(testFile, 'utf8');
      expect(fixed).toContain("'totalFor'");
      expect(fixed).not.toContain('totalForX');

      const reaudit = spawnSync(process.execPath, [BIN, 'audit', '.'], { cwd: fixture, encoding: 'utf8' });
      expect(reaudit.status, reaudit.stderr).toBe(0);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe('doctor PHP readiness', () => {
  it('reports PHP off when the language gate is disabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'momus-doctor-off-'));
    try {
      writeFileSync(join(dir, 'composer.json'), '{}');
      writeFileSync(join(dir, 'Example.php'), '<?php class Example {}');
      const readiness = phpReadiness(dir, { ...DEFAULT_CONFIG, languages: { typescript: true, php: false } });
      expect(readiness).toMatch(/^off /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports PHP ready when enabled with a composer.json and .php files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'momus-doctor-ready-'));
    try {
      writeFileSync(join(dir, 'composer.json'), '{}');
      mkdirSync(join(dir, 'src'), { recursive: true });
      mkdirSync(join(dir, 'tests'), { recursive: true });
      writeFileSync(join(dir, 'src', 'InvoiceRepository.php'), '<?php class InvoiceRepository {}');
      writeFileSync(join(dir, 'tests', 'InvoiceTest.php'), '<?php class InvoiceTest {}');
      const signals = phpProjectSignals(dir);
      expect(signals.composerJson).toBe(true);
      expect(signals.phpFiles).toBe(2);
      const readiness = phpReadiness(dir, { ...DEFAULT_CONFIG, languages: { typescript: true, php: true } });
      expect(readiness).toMatch(/^ready — composer\.json present, 2 \.php files$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports PHP enabled-but-loose without a composer.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'momus-doctor-loose-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'Legacy.php'), '<?php class Legacy {}');
      const readiness = phpReadiness(dir, { ...DEFAULT_CONFIG, languages: { typescript: true, php: true } });
      expect(readiness).toMatch(/^enabled — 1 \.php file but no composer\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('momus hook installer', () => {
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'momus-hook-'));
    runGit(dir, 'git init -q -b main');
    runGit(dir, 'git config user.email hook@momus.dev');
    runGit(dir, 'git config user.name hook');
    writeFileSync(join(dir, 'file.ts'), 'export const x = 1;\n');
    runGit(dir, 'git add -A');
    runGit(dir, 'git commit -qm initial');
    return dir;
  }

  it('installs and uninstalls the pre-commit hook behind the --yes gate', () => {
    const dir = repo();
    try {
      const hookPath = join(dir, '.git', 'hooks', 'pre-commit');
      const refuse = spawnSync(process.execPath, [BIN, 'hook', '--install'], { cwd: dir, encoding: 'utf8' });
      expect(refuse.status).toBe(2);
      expect(refuse.stderr).toMatch(/requires --yes/);
      expect(existsSync(hookPath)).toBe(false);

      const install = spawnSync(process.execPath, [BIN, 'hook', '--install', '--yes'], { cwd: dir, encoding: 'utf8' });
      expect(install.status, install.stderr).toBe(0);
      const content = readFileSync(hookPath, 'utf8');
      expect(content).toContain('Generated by momus hook --install');
      expect(content).toContain(' hook');

      const refuseUn = spawnSync(process.execPath, [BIN, 'hook', '--uninstall'], { cwd: dir, encoding: 'utf8' });
      expect(refuseUn.status).toBe(2);
      expect(existsSync(hookPath)).toBe(true);

      const uninstall = spawnSync(process.execPath, [BIN, 'hook', '--uninstall', '--yes'], {
        cwd: dir,
        encoding: 'utf8',
      });
      expect(uninstall.status, uninstall.stderr).toBe(0);
      expect(existsSync(hookPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to uninstall a hook it did not install', () => {
    const dir = repo();
    try {
      const hookPath = join(dir, '.git', 'hooks', 'pre-commit');
      writeFileSync(hookPath, '#!/bin/sh\necho user hook\n');
      const res = spawnSync(process.execPath, [BIN, 'hook', '--uninstall', '--yes'], { cwd: dir, encoding: 'utf8' });
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/was not installed by momus/);
      expect(readFileSync(hookPath, 'utf8')).toContain('user hook');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks a staged production change that stales a mock', { timeout: 30_000 }, () => {
    const repo = gitRepo();
    try {
      writeFileSync(
        join(repo, 'src', 'services', 'ledger.ts'),
        [
          'export class LedgerService {',
          '  async totalForRenamed(invoiceId: string): Promise<number> { return 0; }',
          '}',
          '',
        ].join('\n'),
      );
      runGit(repo, 'git add -A');
      const blocked = spawnSync(process.execPath, [BIN, 'hook'], { cwd: repo, encoding: 'utf8' });
      expect(blocked.status, blocked.stderr).toBe(1);
      expect(blocked.stdout).toMatch(/DRIFT-006/);

      writeFileSync(
        join(repo, 'tests', 'ledger.test.ts'),
        [
          "import { describe, expect, it, vi } from 'vitest';",
          "import { LedgerService } from '../src/services/ledger';",
          "describe('LedgerService', () => {",
          "  it('spies on a member', () => {",
          '    const service = new LedgerService();',
          "    const spy = vi.spyOn(service, 'totalForRenamed');",
          '    expect(spy).toHaveBeenCalled();',
          '  });',
          '});',
          '',
        ].join('\n'),
      );
      runGit(repo, 'git add -A');
      const fixed = spawnSync(process.execPath, [BIN, 'hook'], { cwd: repo, encoding: 'utf8' });
      expect(fixed.status, fixed.stderr).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
