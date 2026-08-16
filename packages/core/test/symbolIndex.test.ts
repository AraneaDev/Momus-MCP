import { describe, expect, it } from 'vitest';
import { SymbolIndex } from '../src/symbolIndex.ts';
import type { ModuleIR, SymbolIR } from '../src/ir.ts';
import { span } from '../src/ir.ts';

function symbol(overrides: Partial<SymbolIR> & { id: string; name: string }): SymbolIR {
  const file = overrides.id?.includes('b#') ? '/repo/src/b.ts' : '/repo/src/a.ts';
  return {
    id: overrides.id,
    name: overrides.name,
    kind: 'class',
    path: file,
    span: span(file, 1, 1, 1, 2),
    members: [],
    extendsIds: [],
    implementsIds: [],
    ...overrides,
  } as SymbolIR;
}

function module(path: string, symbols: SymbolIR[], exports: string[] = []): ModuleIR {
  return {
    path,
    language: 'typescript',
    kind: 'production',
    framework: undefined,
    imports: [],
    symbols,
    exports,
    mocks: [],
    assertions: [],
    comments: [],
    functions: [],
    diagnostics: [],
    hash: 'x',
  };
}

describe('SymbolIndex', () => {
  it('membersOf includes inherited members, deduped, across multiple levels', () => {
    const base = symbol({ id: 'a#Base', name: 'Base', members: [symbol({ id: 'a#Base#m', name: 'm' })] });
    const mid = symbol({
      id: 'a#Mid',
      name: 'Mid',
      extendsIds: ['a#Base'],
      members: [symbol({ id: 'a#Mid#n', name: 'n' })],
    });
    const leaf = symbol({
      id: 'a#Leaf',
      name: 'Leaf',
      extendsIds: ['a#Mid'],
      members: [symbol({ id: 'a#Leaf#m', name: 'm' }), symbol({ id: 'a#Leaf#n', name: 'n' })],
    });
    const index = new SymbolIndex([module('/repo/src/a.ts', [base, mid, leaf])]);
    const members = index.membersOf('a#Leaf');
    // inherited m/n plus the leaf's own m/n — duplicates by id are dropped, but
    // same-named members from different declarations both survive (different ids)
    expect(members.map((x) => x.id).sort()).toEqual(['a#Base#m', 'a#Leaf#m', 'a#Leaf#n', 'a#Mid#n']);
  });

  it('membersOf dedupes a member reachable through two inheritance paths (diamond)', () => {
    const root = symbol({ id: 'a#Root', name: 'Root', members: [symbol({ id: 'a#Root#m', name: 'm' })] });
    const left = symbol({ id: 'a#Left', name: 'Left', extendsIds: ['a#Root'] });
    const right = symbol({ id: 'a#Right', name: 'Right', extendsIds: ['a#Root'] });
    const diamond = symbol({ id: 'a#Diamond', name: 'Diamond', extendsIds: ['a#Left', 'a#Right'] });
    const index = new SymbolIndex([module('/repo/src/a.ts', [root, left, right, diamond])]);
    const members = index.membersOf('a#Diamond');
    expect(members.map((x) => x.id)).toEqual(['a#Root#m']); // once, not twice
  });

  it('membersOf stops quietly at an unresolvable extends id (missing symbol)', () => {
    const lone = symbol({ id: 'a#Lone', name: 'Lone', extendsIds: ['a#Missing'] });
    const index = new SymbolIndex([module('/repo/src/a.ts', [lone])]);
    expect(index.membersOf('a#Lone')).toHaveLength(0);
  });

  it('membersOf is empty for an unknown symbol id', () => {
    const index = new SymbolIndex([]);
    expect(index.membersOf('nope')).toHaveLength(0);
  });

  it('resolveByName prefers the same-module symbol, else the first indexed', () => {
    const a = symbol({ id: 'a#Widget', name: 'Widget' });
    const b = symbol({ id: 'b#Widget', name: 'Widget' });
    const index = new SymbolIndex([module('/repo/src/a.ts', [a]), module('/repo/src/b.ts', [b])]);
    expect(index.resolveByName('Widget', '/repo/src/b.ts')?.id).toBe('b#Widget');
    expect(index.resolveByName('Widget', '/repo/src/other.ts')?.id).toBe('a#Widget'); // first bucket
    expect(index.resolveByName('Ghost', '/repo/src/other.ts')).toBeUndefined();
  });

  it('getModule / getSymbol / exportsOf return indexed entries and empty defaults', () => {
    const cls = symbol({ id: 'a#Svc', name: 'Svc' });
    const index = new SymbolIndex([module('/repo/src/a.ts', [cls], ['Svc'])]);
    expect(index.getModule('/repo/src/a.ts')?.path).toBe('/repo/src/a.ts');
    expect(index.getModule('/repo/src/z.ts')).toBeUndefined();
    expect(index.getSymbol('a#Svc')?.name).toBe('Svc');
    expect(index.getSymbol('a#Nope')).toBeUndefined();
    expect(index.exportsOf('/repo/src/a.ts').map((x) => x.name)).toEqual(['Svc']);
    expect(index.exportsOf('/repo/src/z.ts')).toEqual([]);
  });
});
