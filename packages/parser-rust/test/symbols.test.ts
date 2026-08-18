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

  it('walks impl blocks with generic self types so methods resolve under the plain type id', () => {
    const file = parseRust(`
pub struct Box<T>(T);
impl<T> Trait for Box<T> {
    fn get(&self) -> u32 { 1 }
}
`);
    const symbols = extractSymbols(file, '/c/src/box.rs');
    // `Box < T >` (token-stream spacing) must key under #Box, not #Box__T_ — otherwise
    // drift checks resolved member `Box.get` can never be found.
    expect(symbols.some((s) => s.id === '/c/src/box.rs#Box.get' && s.kind === 'method')).toBe(true);
    expect(symbols.some((s) => s.id === '/c/src/box.rs#Box__T_.get')).toBe(false);
  });

  it('emits a type alias and descends into nested modules', () => {
    const file = parseRust(`
mod outer {
    pub type Alias = u32;
    mod inner {
        pub fn deep() {}
    }
}
`);
    const symbols = extractSymbols(file, '/c/src/lib.rs');
    const alias = symbols.find((s) => s.name === 'Alias');
    expect(alias?.kind).toBe('type-alias');
    expect(symbols.some((s) => s.name === 'deep' && s.kind === 'function')).toBe(true);
  });

  it('resolves trait supertraits into extendsIds so inherited members are not "missing"', () => {
    const file = parseRust(`
trait Base { fn add(&self, x: i32) -> usize; }
trait Derived : Base { fn sub(&self, x: i32) -> usize; }
`);
    const symbols = extractSymbols(file, '/c/src/lib.rs');
    const derived = symbols.find((s) => s.name === 'Derived');
    expect(derived?.extendsIds).toEqual(['/c/src/lib.rs#Base']);
  });
});
