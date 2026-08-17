import { describe, expect, it } from 'vitest';
import { rustTypeToIr } from '../src/types.ts';
import { parseRust } from '../src/wasm.ts';
import type { RustType } from '../src/ast.ts';

const ret = (src: string): RustType => {
  const file = parseRust(`fn f() -> ${src} {}\n`);
  const f = file.items.find((i) => i.kind === 'fn');
  if (!f || f.kind !== 'fn' || !f.sig.returnType) throw new Error('no return type parsed');
  return f.sig.returnType;
};

describe('rustTypeToIr', () => {
  it('maps a named generic type with type args', () => {
    expect(rustTypeToIr(ret('Result<u32, String>'))).toEqual({
      kind: 'named',
      name: 'Result',
      resolvedId: undefined,
      typeArgs: [
        { kind: 'named', name: 'u32', resolvedId: undefined, typeArgs: [] },
        { kind: 'named', name: 'String', resolvedId: undefined, typeArgs: [] },
      ],
    });
  });

  it('maps references conservatively to the full source text', () => {
    // quote's token-stream reconstruction spaces the `&` and `mut` tokens.
    expect(rustTypeToIr(ret('&mut [u8]'))).toEqual({
      kind: 'named',
      name: '& mut [u8]',
      resolvedId: undefined,
      typeArgs: [],
    });
  });

  it('maps tuples to a tuple TypeIR', () => {
    expect(rustTypeToIr(ret('(u32, bool)'))).toEqual({
      kind: 'tuple',
      elements: [
        { kind: 'named', name: 'u32', resolvedId: undefined, typeArgs: [] },
        { kind: 'named', name: 'bool', resolvedId: undefined, typeArgs: [] },
      ],
    });
  });

  it('maps unit () to void', () => {
    expect(rustTypeToIr(ret('()'))).toEqual({ kind: 'void' });
  });
});
