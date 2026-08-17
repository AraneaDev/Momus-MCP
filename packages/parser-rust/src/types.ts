import type { TypeIR } from '@momus/core';
import type { RustType } from './ast.ts';

/** Map a Rust AST type to the language-neutral TypeIR. Conservative: exotic kinds fall
 *  back to a `named` TypeIR carrying the full source text so assignability degrades safely. */
export function rustTypeToIr(t: RustType): TypeIR {
  switch (t.kind) {
    case 'unit':
      return { kind: 'void' };
    case 'never':
      return { kind: 'never' };
    case 'tuple':
      return { kind: 'tuple', elements: (t.elements ?? []).map(rustTypeToIr) };
    case 'named': {
      const name = t.name ?? t.text;
      const args = t.args ?? [];
      if (args.length > 0) {
        return { kind: 'named', name, resolvedId: undefined, typeArgs: args.map(rustTypeToIr) };
      }
      return { kind: 'named', name, resolvedId: undefined, typeArgs: [] };
    }
    default:
      // reference / slice / array / impl-trait / infer: keep full text, conservative
      return { kind: 'named', name: t.text, resolvedId: undefined, typeArgs: [] };
  }
}
