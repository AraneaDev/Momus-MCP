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
});
