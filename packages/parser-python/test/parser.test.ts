import { describe, expect, it } from 'vitest';
import { PythonParser } from '../src/index.ts';

const parser = new PythonParser();

const SRC = `from unittest.mock import patch
from .repo import Repo

class Repo:
    def save(self, item: "Item") -> int:
        return 1

    def load(self, key: str) -> "Item | None":
        return None

def helper(x: list[int]) -> dict[str, int]:
    return {}
`;

describe('PythonParser symbols', () => {
  it('extracts class/method/function symbols with annotation-derived signatures', () => {
    const mod = parser.parseModule('/x/repo.py', SRC, { config: undefined, resolveImport: () => null });
    expect(mod.language).toBe('python');
    expect(mod.kind).toBe('production');

    const repo = mod.symbols.find((s) => s.name === 'Repo')!;
    expect(repo.kind).toBe('class');

    const save = repo.members.find((m) => m.name === 'save')!;
    expect(save.signature!.returnType).toEqual({ kind: 'named', name: 'int', typeArgs: [] });
    expect(save.signature!.parameters[1]).toMatchObject({
      name: 'item',
      type: { kind: 'named', name: 'Item', typeArgs: [] },
    });

    const load = repo.members.find((m) => m.name === 'load')!;
    expect(load.signature!.returnType).toEqual({
      kind: 'union',
      members: [{ kind: 'named', name: 'Item', typeArgs: [] }, { kind: 'null' }],
    });

    const helper = mod.symbols.find((s) => s.name === 'helper')!;
    expect(helper.kind).toBe('function');
    expect(helper.signature!.returnType).toEqual({
      kind: 'named',
      name: 'dict',
      typeArgs: [
        { kind: 'named', name: 'str', typeArgs: [] },
        { kind: 'named', name: 'int', typeArgs: [] },
      ],
    });
  });

  it('extracts imports with local names', () => {
    const mod = parser.parseModule('/x/repo.py', SRC, { config: undefined, resolveImport: () => null });
    const fromMock = mod.imports.find((i) => i.names.includes('patch'))!;
    expect(fromMock.specifier).toBe('unittest.mock');
    const fromRepo = mod.imports.find((i) => i.names.includes('Repo'))!;
    expect(fromRepo.specifier).toBe('repo');
  });

  it('populates extendsIds from the superclasses clause (identifier + attribute forms)', () => {
    const src = `class Child(Base, mixin.Other):
    pass
`;
    const mod = parser.parseModule('/x/repo.py', src, { config: undefined, resolveImport: () => null });
    const child = mod.symbols.find((s) => s.name === 'Child')!;
    expect(child.extendsIds).toEqual(['/x/repo.py#Base', '/x/repo.py#Other']);
  });

  it('models class-level attributes as `property` members (for patch.multiple DRIFT-001)', () => {
    const src = `class Service:
    supports_async_task = True
    ready: bool = False

    def fetch(self) -> str:
        return ""
`;
    const mod = parser.parseModule('/x/repo.py', src, { config: undefined, resolveImport: () => null });
    const service = mod.symbols.find((s) => s.name === 'Service')!;
    const attrs = service.members.filter((m) => m.kind === 'property').map((m) => m.name);
    expect(attrs).toEqual(['supports_async_task', 'ready']);
    expect(service.members.find((m) => m.name === 'fetch')!.kind).toBe('method');
  });

  it('models instance attributes (self.x = …) as `property` members (for patch.object DRIFT-001)', () => {
    const src = `class Repo:
    def __init__(self, base_url):
        self.base_url = base_url
        self.cache = {}

    def fetch(self, key):
        return self.cache.get(key)
`;
    const mod = parser.parseModule('/x/repo.py', src, { config: undefined, resolveImport: () => null });
    const repo = mod.symbols.find((s) => s.name === 'Repo')!;
    const attrs = repo.members.filter((m) => m.kind === 'property').map((m) => m.name);
    expect(attrs).toEqual(['base_url', 'cache']);
    expect(repo.members.find((m) => m.name === 'fetch')!.kind).toBe('method');
  });
});
