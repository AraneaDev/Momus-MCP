import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { driftRules } from '../src/rules/drift.ts';
import { runRules, type DiffScope, type RuleContext } from '../src/rules/engine.ts';
import { SymbolIndex } from '../src/symbolIndex.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { gitChangedPaths, gitStagedPaths } from '../src/git.ts';
import type { ModuleIR, MockIR, SourceSpan } from '../src/ir.ts';

const FILE = '/ws/tests/ledger.test.ts';
const PROD = '/ws/src/ledger.ts';
const sp = (file: string, sl: number, sc = 1, el = sl, ec = 2): SourceSpan => ({
  file,
  startLine: sl,
  startCol: sc,
  endLine: el,
  endCol: ec,
});

function testModule(over: Partial<ModuleIR> = {}): ModuleIR {
  return {
    path: FILE,
    language: 'typescript',
    kind: 'test',
    framework: 'vitest',
    imports: [{ specifier: '../src/ledger', names: ['LedgerService'] }],
    symbols: [],
    exports: [],
    mocks: [],
    assertions: [],
    functions: [],
    comments: [],
    diagnostics: [],
    hash: 'x',
    ...over,
  };
}

function prodModule(): ModuleIR {
  return {
    path: PROD,
    language: 'typescript',
    kind: 'production',
    imports: [],
    symbols: [
      {
        id: `${PROD}#LedgerService`,
        name: 'LedgerService',
        kind: 'class',
        span: sp(PROD, 1),
        members: [
          {
            id: `${PROD}#LedgerService.totalFor`,
            name: 'totalFor',
            kind: 'method',
            span: sp(PROD, 3),
            members: [],
            extendsIds: [],
            implementsIds: [],
          },
          {
            id: `${PROD}#LedgerService.audit`,
            name: 'audit',
            kind: 'method',
            span: sp(PROD, 5),
            members: [],
            extendsIds: [],
            implementsIds: [],
          },
        ],
        extendsIds: [],
        implementsIds: [],
      },
    ],
    exports: ['LedgerService'],
    mocks: [],
    assertions: [],
    functions: [],
    comments: [],
    diagnostics: [],
    hash: 'y',
  };
}

const mock = (over: Partial<MockIR> = {}): MockIR => ({
  id: 'm1',
  span: sp(FILE, 5),
  framework: 'vitest',
  pattern: 'vi.fn',
  stubbedMembers: [],
  configuredValues: [],
  invocationSites: [],
  isAutomock: false,
  ...over,
});

function ctx(module: ModuleIR, index: SymbolIndex, diff?: DiffScope): RuleContext {
  return { module, index, config: DEFAULT_CONFIG, ...(diff ? { diff } : {}) };
}

const drift = (id: string) => driftRules.filter((r) => r.id === id);

const diffOf = (changedPaths: string[], changedSymbolIds: string[]): DiffScope => ({
  baseRef: 'main',
  changedPaths,
  changedSymbolIds: new Set(changedSymbolIds),
});

describe('DRIFT-006 stale-mock (git-diff mode)', () => {
  const index = new SymbolIndex([prodModule()]);
  const staleMock = () =>
    testModule({
      mocks: [
        mock({
          target: { kind: 'class', symbolId: `${PROD}#LedgerService`, span: sp(FILE, 5) },
          stubbedMembers: [{ name: 'totalFor', span: sp(FILE, 5), api: 'objectLiteralKey', returnValues: [] }],
        }),
      ],
    });

  it('flags mocks whose target changed when the mock file was not updated', () => {
    const issues = runRules(drift('DRIFT-006'), ctx(staleMock(), index, diffOf([PROD], [`${PROD}#LedgerService`])));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.rule).toBe('DRIFT-006');
    expect(issues[0]!.message).toContain('LedgerService');
    expect(issues[0]!.message).toContain('main');
    expect(issues[0]!.message).toContain('totalFor'); // member names survive the budget
    expect(issues[0]!.message.length).toBeLessThanOrEqual(80);
  });

  it('stays quiet when the mock file itself changed', () => {
    const issues = runRules(
      drift('DRIFT-006'),
      ctx(staleMock(), index, diffOf([PROD, FILE], [`${PROD}#LedgerService`])),
    );
    expect(issues).toHaveLength(0);
  });

  it('stays quiet when the target did not change', () => {
    const issues = runRules(drift('DRIFT-006'), ctx(staleMock(), index, diffOf([], [])));
    expect(issues).toHaveLength(0);
  });

  it('stays quiet in workspace mode (no diff)', () => {
    const issues = runRules(drift('DRIFT-006'), ctx(staleMock(), index));
    expect(issues).toHaveLength(0);
  });
});

describe('diff-scoped drift filtering (git-diff mode)', () => {
  const index = new SymbolIndex([prodModule()]);
  const missingMemberMock = () =>
    testModule({
      mocks: [
        mock({
          id: 'm1',
          pattern: 'vi.spyOn',
          target: {
            kind: 'instance-member',
            symbolId: `${PROD}#LedgerService`,
            memberName: 'totalForX',
            span: sp(FILE, 5),
          },
          stubbedMembers: [{ name: 'totalForX', span: sp(FILE, 5), api: 'spyOn', returnValues: [] }],
        }),
      ],
    });

  it('DRIFT-001 fires only for mocks whose target changed', () => {
    const changed = ctx(missingMemberMock(), index, diffOf([PROD], [`${PROD}#LedgerService`]));
    expect(runRules(drift('DRIFT-001'), changed)).toHaveLength(1);
    const untouched = ctx(missingMemberMock(), index, diffOf(['/ws/src/other.ts'], ['/ws/src/other.ts#Other']));
    expect(runRules(drift('DRIFT-001'), untouched)).toHaveLength(0);
  });
});

describe('gitChangedPaths', () => {
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'momus-git-'));
    run(dir, 'git init -q -b main');
    run(dir, 'git config user.email test@momus.dev');
    run(dir, 'git config user.name test');
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'tests'));
    writeFileSync(join(dir, 'src', 'ledger.ts'), 'export class LedgerService {}\n');
    writeFileSync(join(dir, 'tests', 'ledger.test.ts'), '// test\n');
    run(dir, 'git add -A');
    run(dir, 'git commit -qm initial');
    return dir;
  }
  function run(dir: string, cmd: string): void {
    execFileSync('git', ['-C', dir, ...cmd.split(' ').filter(Boolean).slice(1)], { encoding: 'utf8', stdio: 'pipe' });
  }

  it('returns workspace-relative paths changed vs the base ref (working tree + staged)', () => {
    const dir = repo();
    try {
      writeFileSync(join(dir, 'src', 'ledger.ts'), 'export class LedgerService { changed() {} }\n');
      writeFileSync(join(dir, 'src', 'new.ts'), 'export const n = 1;\n');
      const paths = gitChangedPaths(dir, 'HEAD');
      expect(paths).toContain('src/ledger.ts');
      expect(paths).toContain('src/new.ts');
      // renamed files contribute both old and new paths (rename detection vs HEAD)
      execFileSync('git', ['-C', dir, 'add', '-A'], { encoding: 'utf8' });
      execFileSync('git', ['-C', dir, 'commit', '-qm', 'add new'], { encoding: 'utf8' });
      execFileSync('git', ['-C', dir, 'mv', 'src/new.ts', 'src/renamed.ts'], { encoding: 'utf8' });
      const renamed = gitChangedPaths(dir, 'HEAD');
      expect(renamed).toContain('src/new.ts');
      expect(renamed).toContain('src/renamed.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when the directory is not a git repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'momus-no-git-'));
    try {
      expect(() => gitChangedPaths(dir, 'HEAD')).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gitStagedPaths reports only index changes (not unstaged or untracked)', () => {
    const dir = repo();
    try {
      writeFileSync(join(dir, 'src', 'staged.ts'), 'export const s = 1;\n');
      execFileSync('git', ['-C', dir, 'add', 'src/staged.ts'], { encoding: 'utf8' });
      writeFileSync(join(dir, 'src', 'untracked.ts'), 'export const u = 1;\n');
      writeFileSync(join(dir, 'src', 'ledger.ts'), 'export class LedgerService { modified() {} }\n');
      expect(gitStagedPaths(dir, 'HEAD')).toEqual(['src/staged.ts']);
      const all = gitChangedPaths(dir, 'HEAD');
      expect(all).toContain('src/staged.ts');
      expect(all).toContain('src/ledger.ts');
      expect(all).toContain('src/untracked.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns paths relative to a subdirectory root (regression: was toplevel-relative)', () => {
    const dir = repo();
    try {
      mkdirSync(join(dir, 'src', 'nested'));
      writeFileSync(join(dir, 'src', 'ledger.ts'), 'export class LedgerService { changed() {} }\n');
      writeFileSync(join(dir, 'src', 'nested', 'x.ts'), 'export const x = 1;\n');
      expect(gitChangedPaths(join(dir, 'src'), 'HEAD').sort()).toEqual(['ledger.ts', 'nested/x.ts']);
      expect(gitChangedPaths(dir, 'HEAD').sort()).toEqual(['src/ledger.ts', 'src/nested/x.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips non-ASCII (quoted) paths conservatively', () => {
    const dir = repo();
    try {
      writeFileSync(join(dir, 'src', 'café.ts'), 'export const c = 1;\n');
      writeFileSync(join(dir, 'src', 'plain.ts'), 'export const p = 1;\n');
      const paths = gitChangedPaths(dir, 'HEAD');
      expect(paths).toContain('src/plain.ts');
      // the non-ASCII file is quoted by git and skipped rather than mis-mapped
      expect(paths.some((p) => p.includes('caf'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
