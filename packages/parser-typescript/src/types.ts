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

export function signatureToIR(m: ts.MethodDeclaration | ts.MethodSignature | ts.FunctionDeclaration | ts.ConstructorDeclaration): {
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
