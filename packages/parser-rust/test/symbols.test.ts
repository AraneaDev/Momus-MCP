import { describe, expect, it } from 'vitest';
import { extractSymbols } from '../src/symbols.ts';
import { parseRust } from '../src/wasm.ts';

describe('extractSymbols', () => {
  it('emits a trait as an interface with abstract method members', () => {
    const file = parseRust('pub trait Repo { fn find(&self, id: u32) -> u32; }\n');
    const symbols = extractSymbols(file, '/c/src/repo.rs');
    const trait = symbols.find((s) => s.name === 'Repo');
    expect(trait?.kind).toBe('interface');
    expect(trait?.members.map((m) => m.name)).toContain('find');
    const find = trait?.members.find((m) => m.name === 'find');
    expect(find?.signature?.returnType).toEqual({ kind: 'named', name: 'u32', resolvedId: undefined, typeArgs: [] });
  });

  it('emits a struct as a class with property members', () => {
    const file = parseRust('pub struct User { pub id: u32, pub name: String }\n');
    const symbols = extractSymbols(file, '/c/src/user.rs');
    const user = symbols.find((s) => s.name === 'User');
    expect(user?.kind).toBe('class');
    expect(user?.members.map((m) => m.name)).toEqual(['id', 'name']);
  });

  it('emits a free fn as a function symbol', () => {
    const file = parseRust('pub fn add(a: u32, b: u32) -> u32 { a + b }\n');
    const symbols = extractSymbols(file, '/c/src/lib.rs');
    const add = symbols.find((s) => s.name === 'add');
    expect(add?.kind).toBe('function');
    expect(add?.signature?.parameters).toHaveLength(2);
  });
});
