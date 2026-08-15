import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import * as ts from 'typescript';
import { getProgram, resolveImport } from '../src/program.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const TEST_FILE = join(FIXTURES, 'tests', 'ledger.test.ts');

describe('getProgram', () => {
  it('returns the program source file for the given path', () => {
    const handle = getProgram(TEST_FILE);
    const sf = handle.program.getSourceFile(TEST_FILE);
    expect(sf).toBeDefined();
  });

  it('produces nodes with parent pointers (F5: typescript-eslint custom host)', () => {
    const handle = getProgram(TEST_FILE);
    const sf = handle.program.getSourceFile(TEST_FILE)!;
    let parentsSeen = 0;
    let orphans = 0;
    const walk = (n: { parent?: unknown }) => {
      if (n.parent) parentsSeen++; else orphans++;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const c of (n as any).getChildren?.() ?? []) walk(c);
    };
    // walk statement roots to avoid double counting via getChildren recursion
    for (const st of sf.statements) walk(st);
    expect(orphans).toBe(0);
    expect(parentsSeen).toBeGreaterThan(10);
  });

  it('type-checks fixture symbols (type-aware)', () => {
    const handle = getProgram(TEST_FILE);
    const checker = handle.program.getTypeChecker();
    const sf = handle.program.getSourceFile(join(FIXTURES, 'src', 'services', 'ledger.ts'))!;
    const cls = sf.statements.find((s) => ts.isClassDeclaration(s) && s.name?.text === 'LedgerService')!;
    const type = checker.getTypeAtLocation(cls);
    expect(checker.typeToString(type)).toBe('LedgerService');
  });
});

describe('resolveImport', () => {
  it('resolves relative specifiers', () => {
    const r = resolveImport('../src/services/db', TEST_FILE);
    expect(r).toBe(join(FIXTURES, 'src', 'services', 'db.ts'));
  });

  it('resolves tsconfig paths aliases', () => {
    const aliasFile = join(FIXTURES, 'tests', 'alias.test.ts');
    const r = resolveImport('@svc/ledger', aliasFile);
    expect(r).toBe(join(FIXTURES, 'src', 'services', 'ledger.ts'));
  });

  it('returns null for unresolvable specifiers', () => {
    expect(resolveImport('some-package-not-installed', TEST_FILE)).toBeNull();
  });
});
