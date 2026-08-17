import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PythonParser } from '../src/index.ts';

const FIX = join(import.meta.dirname, 'fixtures', 'pyright');
const SERVICE = join(FIX, 'service.py');
const parser = new PythonParser();

function parse(path: string) {
  return parser.parseModule(path, readFileSync(path, 'utf8'), {
    config: undefined,
    resolveImport: () => null,
  });
}

describe('pyright return-type inference', () => {
  it('resolves an unannotated named return type (sum -> int)', () => {
    const mod = parse(SERVICE);
    const total = mod.symbols.find((s) => s.name === 'total')!;
    expect(total.signature?.returnType).toMatchObject({ kind: 'named', name: 'int' });
  });

  it('resolves an unannotated literal return type on a method', () => {
    const mod = parse(SERVICE);
    const repo = mod.symbols.find((s) => s.name === 'Repo')!;
    const getCount = repo.members.find((m) => m.name === 'get_count')!;
    expect(getCount.signature?.returnType).toMatchObject({ kind: 'literal', value: 42 });
  });

  it('keeps an explicit source annotation authoritative over inference', () => {
    const mod = parse(SERVICE);
    const repo = mod.symbols.find((s) => s.name === 'Repo')!;
    const labelled = repo.members.find((m) => m.name === 'labelled')!;
    expect(labelled.signature?.returnType).toMatchObject({ kind: 'named', name: 'str' });
  });
});
