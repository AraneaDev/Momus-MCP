import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { extractSymbols } from '../src/symbols.ts';
import { typeNodeToIR, signatureToIR } from '../src/types.ts';

function parse(src: string): ts.SourceFile {
  return ts.createSourceFile('x.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Parse `const a: <type>;` and return the type annotation node. */
function typeOf(src: string): ts.TypeNode {
  const sf = parse(src);
  const decl = (sf.statements[0] as ts.VariableStatement).declarationList.declarations[0]!;
  return decl.type!;
}

function firstMethod(src: string): ts.MethodDeclaration {
  const sf = parse(src);
  const cls = sf.statements.find(ts.isClassDeclaration)!;
  return cls.members.find(ts.isMethodDeclaration)!;
}

describe('typeNodeToIR', () => {
  it('returns undefined for a missing node', () => {
    expect(typeNodeToIR(undefined)).toBeUndefined();
  });

  it('maps union and intersection types', () => {
    expect(typeNodeToIR(typeOf('const a: string | number;'))).toEqual({
      kind: 'union',
      members: [
        { kind: 'named', name: 'string', typeArgs: [] },
        { kind: 'named', name: 'number', typeArgs: [] },
      ],
    });
    expect(typeNodeToIR(typeOf('const a: A & B;'))).toEqual({
      kind: 'intersection',
      members: [
        { kind: 'named', name: 'A', typeArgs: [] },
        { kind: 'named', name: 'B', typeArgs: [] },
      ],
    });
  });

  it('maps array and tuple types', () => {
    expect(typeNodeToIR(typeOf('const a: string[];'))).toEqual({
      kind: 'array',
      element: { kind: 'named', name: 'string', typeArgs: [] },
    });
    expect(typeNodeToIR(typeOf('const a: [string, number];'))).toEqual({
      kind: 'tuple',
      elements: [
        { kind: 'named', name: 'string', typeArgs: [] },
        { kind: 'named', name: 'number', typeArgs: [] },
      ],
    });
  });

  it('maps literal types (string/number/boolean/null)', () => {
    expect(typeNodeToIR(typeOf("const a: 'lit';"))).toEqual({ kind: 'literal', value: 'lit' });
    expect(typeNodeToIR(typeOf('const a: 42;'))).toEqual({ kind: 'literal', value: 42 });
    expect(typeNodeToIR(typeOf('const a: true;'))).toEqual({ kind: 'literal', value: true });
    expect(typeNodeToIR(typeOf('const a: false;'))).toEqual({ kind: 'literal', value: false });
    // `null` parses as a LiteralType wrapping NullKeyword → literal null
    expect(typeNodeToIR(typeOf('const a: null;'))).toEqual({ kind: 'literal', value: null });
  });

  it('maps function types with params and return type', () => {
    expect(typeNodeToIR(typeOf('const a: (x: number) => string;'))).toEqual({
      kind: 'function',
      params: [
        {
          name: 'x',
          type: { kind: 'named', name: 'number', typeArgs: [] },
          optional: false,
          variadic: false,
          hasDefault: false,
        },
      ],
      returnType: { kind: 'named', name: 'string', typeArgs: [] },
    });
  });

  it('maps type references with type arguments', () => {
    expect(typeNodeToIR(typeOf('const a: Array<string>;'))).toEqual({
      kind: 'named',
      name: 'Array',
      typeArgs: [{ kind: 'named', name: 'string', typeArgs: [] }],
    });
  });

  it('maps keyword types', () => {
    expect(typeNodeToIR(typeOf('const a: void;'))).toEqual({ kind: 'void' });
    expect(typeNodeToIR(typeOf('const a: never;'))).toEqual({ kind: 'never' });
    expect(typeNodeToIR(typeOf('const a: undefined;'))).toEqual({ kind: 'undefined' });
    expect(typeNodeToIR(typeOf('const a: any;'))).toEqual({ kind: 'unknown' });
    expect(typeNodeToIR(typeOf('const a: unknown;'))).toEqual({ kind: 'unknown' });
    // unlisted keywords fall back to a named reference
    expect(typeNodeToIR(typeOf('const a: string;'))).toEqual({ kind: 'named', name: 'string', typeArgs: [] });
  });
});

describe('signatureToIR', () => {
  it('captures optional/variadic/default parameters, return type, and type params', () => {
    const sig = signatureToIR(
      firstMethod('class C { m<T>(a: string, b?: number, ...rest: boolean[], d = 1): T[] { return [] as never; } }'),
    );
    expect(sig.typeParams).toEqual(['T']);
    expect(sig.returnType).toEqual({ kind: 'array', element: { kind: 'named', name: 'T', typeArgs: [] } });
    expect(sig.parameters.map((p) => p.name)).toEqual(['a', 'b', 'rest', 'd']);
    expect(sig.parameters[1]!.optional).toBe(true);
    expect(sig.parameters[2]!.variadic).toBe(true);
    expect(sig.parameters[3]!.hasDefault).toBe(true);
  });

  it('handles an untyped method (no return type, no params)', () => {
    const sig = signatureToIR(firstMethod('class C { m() {} }'));
    expect(sig.returnType).toBeUndefined();
    expect(sig.parameters).toEqual([]);
    expect(sig.typeParams).toEqual([]);
  });
});

describe('extractSymbols', () => {
  it('extracts class members with visibility/static/abstract flags', () => {
    const { symbols, exports } = extractSymbols(
      parse(
        [
          'export class C {',
          '  public a(): void {}',
          '  private b(): void {}',
          '  protected c(): void {}',
          '  d(): void {}',
          '  static s(): void {}',
          '  abstract e(): void;',
          '  get g(): number { return 1; }',
          '  prop = 1;',
          '  static sprop = 2;',
          '}',
        ].join('\n'),
      ),
    );
    expect(exports).toEqual(['C']);
    expect(symbols).toHaveLength(1);
    const cls = symbols[0]!;
    expect(cls.kind).toBe('class');
    expect(cls.name).toBe('C');
    const byName = Object.fromEntries(cls.members.map((m) => [m.name, m]));
    expect(byName['a']).toMatchObject({ kind: 'method', visibility: 'public', isStatic: false, isAbstract: false });
    expect(byName['b']).toMatchObject({ visibility: 'private' });
    expect(byName['c']).toMatchObject({ visibility: 'protected' });
    expect(byName['d']).toMatchObject({ visibility: undefined });
    expect(byName['s']).toMatchObject({ isStatic: true });
    expect(byName['e']).toMatchObject({ isAbstract: true });
    expect(byName['g']).toMatchObject({ kind: 'property' });
    expect(byName['prop']).toMatchObject({ kind: 'property', isStatic: undefined });
    expect(byName['sprop']).toMatchObject({ kind: 'property', isStatic: true });
    expect(byName['a']!.signature).toBeDefined();
  });

  it('records heritage clauses as extendsIds/implementsIds', () => {
    const { symbols } = extractSymbols(parse('class C extends Base implements I1, I2 {}'));
    const cls = symbols[0]!;
    expect(cls.extendsIds).toEqual(['x.ts#Base']);
    expect(cls.implementsIds).toEqual(['x.ts#I1', 'x.ts#I2']);
  });

  it('extracts interfaces with method/property signatures and extends', () => {
    const { symbols } = extractSymbols(parse('export interface I extends J { m(): void; p: number; }'));
    const iface = symbols[0]!;
    expect(iface.kind).toBe('interface');
    expect(iface.extendsIds).toEqual(['x.ts#J']);
    expect(iface.implementsIds).toEqual([]);
    expect(iface.members.map((m) => [m.name, m.kind])).toEqual([
      ['m', 'method'],
      ['p', 'property'],
    ]);
  });

  it('extracts exported function declarations', () => {
    const { symbols, exports } = extractSymbols(parse('export function f(x: string): void {}'));
    expect(exports).toEqual(['f']);
    expect(symbols[0]).toMatchObject({ name: 'f', kind: 'function' });
    expect(symbols[0]!.signature?.parameters).toHaveLength(1);
  });

  it('collects exports from variables, type aliases, and enums only when exported', () => {
    const { symbols, exports } = extractSymbols(
      parse(
        [
          'export const a = 1, b = 2;',
          'const hidden = 3;',
          'export type T = string;',
          'type H = number;',
          'export enum E { A }',
          'enum NE { B }',
          'class NC {}',
          'export class EC {}',
        ].join('\n'),
      ),
    );
    expect(exports.sort()).toEqual(['EC', 'E', 'T', 'a', 'b'].sort());
    // non-exported class still becomes a symbol; non-exported vars/types/enums do not
    expect(symbols.map((s) => s.name).sort()).toEqual(['EC', 'NC']);
  });

  it('collects barrel re-exports (named, aliased, and namespace)', () => {
    const { exports } = extractSymbols(
      parse(
        [
          "export { loadConfig, validateConfig } from './config.js';",
          "export { a as b } from './other.js';",
          'export { localName };',
          "export * as ns from './ns.js';",
        ].join('\n'),
      ),
    );
    // exported names (not local names) are recorded; `export * from` is not enumerated
    expect(exports.sort()).toEqual(['b', 'loadConfig', 'localName', 'ns', 'validateConfig'].sort());
  });
});
