import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { tsReturnExample, promiseTypeArg } from '../src/types.ts';

/** Parse a standalone type annotation into a TypeNode. */
function parseType(expr: string): ts.TypeNode {
  const sf = ts.createSourceFile('x.ts', `declare const x: ${expr};`, ts.ScriptTarget.Latest, true);
  const decl = sf.statements[0] as ts.VariableStatement;
  const typeNode = (decl.declarationList.declarations[0] as ts.VariableDeclaration).type!;
  return typeNode;
}

describe('tsReturnExample (syntax-only type nodes)', () => {
  it('maps keyword types to literals', () => {
    expect(tsReturnExample(parseType('number'))).toBe('0');
    expect(tsReturnExample(parseType('bigint'))).toBe('0');
    expect(tsReturnExample(parseType('string'))).toBe("''");
    expect(tsReturnExample(parseType('boolean'))).toBe('false');
    expect(tsReturnExample(parseType('void'))).toBe('undefined');
    expect(tsReturnExample(parseType('undefined'))).toBe('undefined');
    expect(tsReturnExample(parseType('never'))).toBe('undefined');
    expect(tsReturnExample(parseType('null'))).toBe('null');
    expect(tsReturnExample(parseType('any'))).toBe('undefined');
    expect(tsReturnExample(parseType('unknown'))).toBe('undefined');
  });

  it('maps literal types to their literal text', () => {
    expect(tsReturnExample(parseType('true'))).toBe('true');
    expect(tsReturnExample(parseType('false'))).toBe('false');
    expect(tsReturnExample(parseType('null'))).toBe('null');
    expect(tsReturnExample(parseType('42'))).toBe('42');
    expect(tsReturnExample(parseType('"hi"'))).toBe('"hi"');
  });

  it('maps arrays, tuples, and inline type literals', () => {
    expect(tsReturnExample(parseType('string[]'))).toBe('[]');
    expect(tsReturnExample(parseType('[string, number]'))).toBe('[]');
    expect(tsReturnExample(parseType('{ a: number; b: string }'))).toBe("{ a: 0, b: '' }");
    expect(tsReturnExample(parseType('{}'))).toBe('{}');
    expect(tsReturnExample(parseType('{ run(): void }'))).toBe('{}'); // method-only → empty shape
  });

  it('picks the first non-nullish union member', () => {
    expect(tsReturnExample(parseType('number | null | undefined'))).toBe('0');
    expect(tsReturnExample(parseType('null | undefined'))).toBe('undefined');
  });

  it('maps built-in reference types structurally', () => {
    expect(tsReturnExample(parseType('Date'))).toBe('new Date()');
    expect(tsReturnExample(parseType('RegExp'))).toBe('/./');
    expect(tsReturnExample(parseType('Map<string, number>'))).toBe('new Map()');
    expect(tsReturnExample(parseType('Set<number>'))).toBe('new Set()');
    expect(tsReturnExample(parseType('Array<number>'))).toBe('[]');
    expect(tsReturnExample(parseType('ReadonlyArray<number>'))).toBe('[]');
  });

  it('maps Record/Partial/Required references to empty shapes', () => {
    expect(tsReturnExample(parseType('Record<string, number>'))).toBe('{}');
    expect(tsReturnExample(parseType('Partial<Widget>'))).toBe('{}');
    expect(tsReturnExample(parseType('Required<Widget>'))).toBe('{}');
  });

  it('falls back to undefined for unknown named types and missing types', () => {
    expect(tsReturnExample(parseType('Widget'))).toBe('undefined');
    expect(tsReturnExample(undefined)).toBe('undefined');
  });
});

describe('promiseTypeArg', () => {
  it('unwraps the inner type of a Promise reference', () => {
    expect(promiseTypeArg(parseType('Promise<number>'))?.getText()).toBe('number');
    expect(promiseTypeArg(parseType('Promise<User>'))?.getText()).toBe('User');
  });

  it('returns undefined for non-Promise or non-reference types', () => {
    expect(promiseTypeArg(parseType('number'))).toBeUndefined();
    expect(promiseTypeArg(parseType('string[]'))).toBeUndefined();
    expect(promiseTypeArg(undefined)).toBeUndefined();
  });
});
