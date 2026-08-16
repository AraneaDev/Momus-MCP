/** Convert TS type syntax to the language-neutral TypeIR. */
import type { TypeIR, ParamIR } from '@momus/core';
import * as ts from 'typescript';

export function typeNodeToIR(node: ts.TypeNode | undefined): TypeIR | undefined {
  if (!node) return undefined;
  if (ts.isUnionTypeNode(node)) {
    return { kind: 'union', members: node.types.map((t) => typeNodeToIR(t) ?? { kind: 'unknown' }) };
  }
  if (ts.isIntersectionTypeNode(node)) {
    return { kind: 'intersection', members: node.types.map((t) => typeNodeToIR(t) ?? { kind: 'unknown' }) };
  }
  if (ts.isArrayTypeNode(node)) {
    return { kind: 'array', element: typeNodeToIR(node.elementType) };
  }
  if (ts.isTupleTypeNode(node)) {
    return { kind: 'tuple', elements: node.elements.map((t) => typeNodeToIR(t) ?? { kind: 'unknown' }) };
  }
  if (ts.isLiteralTypeNode(node)) {
    if (ts.isStringLiteral(node.literal)) return { kind: 'literal', value: node.literal.text };
    if (ts.isNumericLiteral(node.literal)) return { kind: 'literal', value: Number(node.literal.text) };
    if (node.literal.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'literal', value: true };
    if (node.literal.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'literal', value: false };
    return { kind: 'literal', value: null };
  }
  if (ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node)) {
    return { kind: 'function', params: node.parameters.map(paramToIR), returnType: typeNodeToIR(node.type) };
  }
  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText();
    return {
      kind: 'named',
      name,
      typeArgs: node.typeArguments?.map((t) => typeNodeToIR(t) ?? { kind: 'unknown' }) ?? [],
    };
  }
  const kw = node.kind;
  if (kw === ts.SyntaxKind.VoidKeyword) return { kind: 'void' };
  if (kw === ts.SyntaxKind.NeverKeyword) return { kind: 'never' };
  if (kw === ts.SyntaxKind.NullKeyword) return { kind: 'null' };
  if (kw === ts.SyntaxKind.UndefinedKeyword) return { kind: 'undefined' };
  if (kw === ts.SyntaxKind.AnyKeyword || kw === ts.SyntaxKind.UnknownKeyword) return { kind: 'unknown' };
  return { kind: 'named', name: node.getText(), typeArgs: [] };
}

function paramToIR(p: ts.ParameterDeclaration): ParamIR {
  return {
    name: p.name.getText(),
    type: typeNodeToIR(p.type),
    optional: !!p.questionToken,
    variadic: p.dotDotDotToken !== undefined,
    hasDefault: p.initializer !== undefined,
  };
}

export function signatureToIR(
  m: ts.MethodDeclaration | ts.MethodSignature | ts.FunctionDeclaration | ts.ConstructorDeclaration,
): {
  parameters: ParamIR[];
  returnType?: TypeIR;
  typeParams: string[];
} {
  return {
    parameters: m.parameters.map(paramToIR),
    returnType: typeNodeToIR(m.type),
    typeParams: (m.typeParameters ?? []).map((t) => t.name.text),
  };
}

/** The inner type argument when `type` is `Promise<T>`, else undefined. */
export function promiseTypeArg(type: ts.TypeNode | undefined): ts.TypeNode | undefined {
  if (!type || !ts.isTypeReferenceNode(type)) return undefined;
  if (!ts.isIdentifier(type.typeName) || type.typeName.text !== 'Promise') return undefined;
  return type.typeArguments?.[0];
}

/**
 * A minimal, type-appropriate placeholder return expression for a synthesized TS stub.
 * Primitives get real literals, collections get empty instances, and class/interface/
 * unknown types fall back to `undefined` (a safe literal cannot be constructed).
 */
export function tsReturnExample(type: ts.TypeNode | undefined): string {
  if (!type) return 'undefined';
  const K = ts.SyntaxKind;
  const kw = type.kind;
  if (kw === K.VoidKeyword || kw === K.UndefinedKeyword || kw === K.NeverKeyword) return 'undefined';
  if (kw === K.NullKeyword) return 'null';
  if (kw === K.NumberKeyword || kw === K.BigIntKeyword) return '0';
  if (kw === K.StringKeyword) return "''";
  if (kw === K.BooleanKeyword) return 'false';
  if (kw === K.AnyKeyword || kw === K.UnknownKeyword) return 'undefined';
  if (ts.isLiteralTypeNode(type)) {
    const lit = type.literal;
    if (ts.isStringLiteral(lit)) return JSON.stringify(lit.text);
    if (ts.isNumericLiteral(lit)) return lit.text;
    if (lit.kind === K.TrueKeyword) return 'true';
    if (lit.kind === K.FalseKeyword) return 'false';
    if (lit.kind === K.NullKeyword) return 'null';
    return 'undefined';
  }
  if (ts.isArrayTypeNode(type) || ts.isTupleTypeNode(type)) return '[]';
  if (ts.isUnionTypeNode(type)) {
    const nonNullish = type.types.find((t) => t.kind !== K.NullKeyword && t.kind !== K.UndefinedKeyword);
    return nonNullish ? tsReturnExample(nonNullish) : 'undefined';
  }
  if (ts.isTypeReferenceNode(type)) {
    const name = type.typeName.getText();
    if (name === 'Array' || name === 'ReadonlyArray') return '[]';
    if (name === 'Promise') return 'Promise.resolve(undefined)';
    if (name === 'Date') return 'new Date()';
    if (name === 'RegExp') return '/./';
    if (name === 'Map' || name === 'Set' || name === 'WeakMap' || name === 'WeakSet') return `new ${name}()`;
  }
  return 'undefined';
}
