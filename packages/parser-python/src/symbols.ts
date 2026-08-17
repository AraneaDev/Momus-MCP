/** tree-sitter Python AST -> SymbolIR (classes, functions, methods with annotation-derived signatures). */
import type { ParamIR, SignatureIR, SymbolIR } from '@momus/core';
import { span } from '@momus/core';
import { childField, end, start, textOf, walk, type SyntaxNode } from './tree.ts';
import { parseAnnotation } from './types.ts';

export function extractSymbols(root: SyntaxNode, file: string, inferred?: Map<string, string>): SymbolIR[] {
  const symbols: SymbolIR[] = [];
  // Module-level functions (incl. decorated).
  for (const child of root.namedChildren) {
    const fn = unwrapDecorated(child);
    if (fn) symbols.push(functionToSymbol(file, fn, inferred));
  }
  // Classes (top-level + nested), with methods as members.
  walk(root, (node) => {
    if (node.isNamed && node.type === 'class_definition') symbols.push(classToSymbol(file, node, inferred));
  });
  return symbols;
}

function unwrapDecorated(node: SyntaxNode): SyntaxNode | null {
  if (node.type === 'function_definition') return node;
  if (node.type === 'decorated_definition') {
    const def = childField(node, 'definition');
    return def?.type === 'function_definition' ? def : null;
  }
  return null;
}

function classToSymbol(file: string, node: SyntaxNode, inferred?: Map<string, string>): SymbolIR {
  const name = textOf(childField(node, 'name')) || 'anonymous';
  const id = `${file}#${name}`;
  const body = childField(node, 'body');
  const members = body ? directFunctions(body).map((m) => methodToSymbol(file, id, name, m, inferred)) : [];
  return { id, name, kind: 'class', span: nodeSpan(file, node), members, extendsIds: [], implementsIds: [] };
}

function functionToSymbol(file: string, node: SyntaxNode, inferred?: Map<string, string>): SymbolIR {
  const name = textOf(childField(node, 'name')) || 'anonymous';
  return {
    id: `${file}#${name}`,
    name,
    kind: 'function',
    span: nodeSpan(file, node),
    members: [],
    extendsIds: [],
    implementsIds: [],
    signature: functionSignature(node, inferred?.get(name)),
  };
}

function methodToSymbol(
  file: string,
  parentId: string,
  className: string,
  node: SyntaxNode,
  inferred?: Map<string, string>,
): SymbolIR {
  const name = textOf(childField(node, 'name')) || 'anonymous';
  return {
    id: `${parentId}.${name}`,
    name,
    kind: 'method',
    span: nodeSpan(file, node),
    members: [],
    extendsIds: [],
    implementsIds: [],
    signature: functionSignature(node, inferred?.get(`${className}.${name}`)),
  };
}

/** Function/method definitions directly inside a class body block (skips nested defs). */
function directFunctions(body: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (const child of body.namedChildren) {
    const fn = unwrapDecorated(child);
    if (fn) out.push(fn);
  }
  return out;
}

function functionSignature(node: SyntaxNode, inferredReturn?: string): SignatureIR {
  const paramsNode = childField(node, 'parameters');
  const retNode = childField(node, 'return_type');
  const sourceType = retNode ? parseAnnotation(textOf(retNode)) : undefined;
  return {
    parameters: paramsNode ? extractParams(paramsNode) : [],
    returnType: sourceType ?? (inferredReturn ? parseAnnotation(inferredReturn) : undefined),
    typeParams: [],
  };
}

function extractParams(paramsNode: SyntaxNode): ParamIR[] {
  const out: ParamIR[] = [];
  for (const child of paramsNode.namedChildren) out.push(paramToIR(child));
  return out;
}

function paramToIR(node: SyntaxNode): ParamIR {
  if (node.type === 'identifier') {
    return { name: textOf(node), optional: false, variadic: false, hasDefault: false };
  }
  if (node.type === 'typed_parameter' || node.type === 'typed_default_parameter' || node.type === 'default_parameter') {
    const typeNode = childField(node, 'type');
    const hasDefault = node.type === 'typed_default_parameter' || node.type === 'default_parameter';
    return {
      name: textOf(node.namedChild(0)),
      type: typeNode ? parseAnnotation(textOf(typeNode)) : undefined,
      optional: hasDefault,
      variadic: false,
      hasDefault,
    };
  }
  // `*args` / `**kwargs` splats.
  const raw = textOf(node.namedChild(0) ?? node);
  return { name: raw.replace(/^\*+/, '') || raw, optional: false, variadic: true, hasDefault: false };
}

function nodeSpan(file: string, node: SyntaxNode) {
  return span(file, start(node).line + 1, start(node).column + 1, end(node).line + 1, end(node).column + 1);
}
