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
} /**
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
  if (ts.isTypeLiteralNode(type)) {
    const props = type.members
      .filter(
        (m): m is ts.PropertySignature =>
          ts.isPropertySignature(m) && !!m.name && ts.isIdentifier(m.name) && m.type !== undefined,
      )
      .map((m) => `${m.name.getText()}: ${tsReturnExample(m.type)}`);
    return props.length > 0 ? `{ ${props.join(', ')} }` : '{}';
  }
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

/**
 * Type-reference names that `tsReturnExample` already handles structurally. These must not be
 * resolved through the checker (a `Promise`/utility type has no useful data properties of its
 * own, and resolving `Array` would produce a misleading literal).
 */
const BUILTIN_TYPE_NAMES = new Set([
  'Array',
  'ReadonlyArray',
  'Promise',
  'Date',
  'RegExp',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Record',
  'Partial',
  'Required',
  'Readonly',
  'Pick',
  'Omit',
  'Exclude',
  'Extract',
  'NonNullable',
  'ReturnType',
  'InstanceType',
  'Awaited',
]);

/**
 * Resolve a named interface/class type reference through the checker and build an object
 * literal from its data properties (methods/accessors are skipped). Returns `undefined` when the
 * type can't be resolved or has no data properties, so callers fall back to `tsReturnExample`.
 */
function namedObjectLiteral(checker: ts.TypeChecker, typeNode: ts.TypeNode, depth: number): string | undefined {
  if (depth > 4 || !ts.isTypeReferenceNode(typeNode)) return undefined;
  const name = typeNode.typeName.getText();
  if (BUILTIN_TYPE_NAMES.has(name)) return undefined;
  let type: ts.Type;
  try {
    type = checker.getTypeAtLocation(typeNode);
  } catch {
    return undefined;
  }
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.Void)) {
    return undefined;
  }
  const entries: string[] = [];
  for (const prop of checker.getPropertiesOfType(type)) {
    const decl = prop.valueDeclaration ?? prop.declarations?.[0];
    if (!decl || !(ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl))) continue;
    entries.push(`${prop.getName()}: ${tsReturnExampleChecked(checker, decl.type, depth + 1)}`);
  }
  return entries.length > 0 ? `{ ${entries.join(', ')} }` : undefined;
}

/**
 * Like `tsReturnExample`, but resolves named interface/class type references through the type
 * checker, so `User` / `Promise<User>` returns emit a data-shape literal instead of `undefined`.
 * Falls back to the syntax-only `tsReturnExample` for primitives, builtins, and unresolvable
 * types. Safe to call with syntax-only nodes (falls back on failure).
 */
export function tsReturnExampleChecked(checker: ts.TypeChecker, typeNode: ts.TypeNode | undefined, depth = 0): string {
  if (!typeNode) return 'undefined';
  if (depth > 5) return 'undefined';
  if (ts.isUnionTypeNode(typeNode)) {
    const nonNullish = typeNode.types.find(
      (t) => t.kind !== ts.SyntaxKind.NullKeyword && t.kind !== ts.SyntaxKind.UndefinedKeyword,
    );
    return nonNullish ? tsReturnExampleChecked(checker, nonNullish, depth + 1) : 'undefined';
  }
  if (ts.isTypeReferenceNode(typeNode)) {
    const name = typeNode.typeName.getText();
    if (name === 'Promise' && typeNode.typeArguments?.[0]) {
      const obj = namedObjectLiteral(checker, typeNode.typeArguments[0], depth + 1);
      if (obj !== undefined) return obj;
    } else {
      const obj = namedObjectLiteral(checker, typeNode, depth + 1);
      if (obj !== undefined) return obj;
    }
  }
  return tsReturnExample(typeNode);
}
