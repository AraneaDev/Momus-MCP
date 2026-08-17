import { describe, expect, it } from 'vitest';
import { RustCrateIndex, moduleOf } from '../src/crateIndex.ts';

const lib = 'pub trait Repo { fn find(&self, id: u32) -> u32; }\n';

describe('RustCrateIndex', () => {
  it('resolves a crate::module::Type path to a production symbol id', () => {
    const idx = new RustCrateIndex([{ path: '/c/src/repo.rs', source: lib }]);
    expect(idx.resolveSymbolId('crate::repo::Repo')).toBe('/c/src/repo.rs#Repo');
  });

  it('falls back to name-based resolution for super:: paths', () => {
    const idx = new RustCrateIndex([{ path: '/c/src/repo.rs', source: lib }]);
    expect(idx.resolveSymbolId('super::Repo')).toBe('/c/src/repo.rs#Repo');
  });

  it('returns null for an unknown symbol', () => {
    const idx = new RustCrateIndex([{ path: '/c/src/repo.rs', source: lib }]);
    expect(idx.resolveSymbolId('crate::nope::Missing')).toBeNull();
  });
});

describe('moduleOf', () => {
  it('maps lib.rs to the crate root', () => {
    expect(moduleOf('/c/src/lib.rs')).toBe('crate');
  });
  it('maps a named module file to its basename', () => {
    expect(moduleOf('/c/src/repo.rs')).toBe('repo');
  });
});
