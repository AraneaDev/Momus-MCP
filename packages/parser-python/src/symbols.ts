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
  // Methods + class-level attributes + instance attributes. Class attributes
  // (`supports_async_task = True`) are the target of `patch.multiple(Cls, attr=…)`, and instance
  // attributes (`self.x = …` in a method body) are the target of `patch.object(Cls, "x", …)` — both
  // modeled as `property` members so DRIFT-001 can check the patched member exists (the parser
  // previously modeled methods only).
  const methods = body ? directFunctions(body) : [];
  const memberNames = new Set<string>();
  const members: SymbolIR[] = [];
  const push = (m: SymbolIR): void => {
    if (memberNames.has(m.name)) return;
    memberNames.add(m.name);
    members.push(m);
  };
  for (const m of methods) push(methodToSymbol(file, id, name, m, inferred));
  for (const attr of body ? classAttributes(body) : []) push(attributeToSymbol(file, id, attr));
  for (const m of methods) for (const attr of instanceAttributes(file, id, m)) push(attr);
  // Base classes (`class Foo(Base, Mixin)`) become extendsIds in the same-file id convention used
  // by the TS parser — a same-file base resolves in the index, an imported/external base does not.
  // The unresolved form is the signal DRIFT-001 uses to stay conservative: a "missing" member may
  // be inherited from the external base (django: `ErrorTestCase(SimpleTestCase)` inherits
  // `_pre_setup`/`_post_teardown` from `unittest.TestCase` via the unindexed `django.test` base).
  const extendsIds = baseClassNames(childField(node, 'superclasses')).map((base) => `${file}#${base}`);
  return { id, name, kind: 'class', span: nodeSpan(file, node), members, extendsIds, implementsIds: [] };
}

/** Base-class names of a `superclasses` argument_list (`Foo(Base, Mixin)` → ['Base','Mixin']). */
function baseClassNames(superclasses: SyntaxNode | null): string[] {
  if (!superclasses) return [];
  const out: string[] = [];
  for (const child of superclasses.namedChildren) {
    if (child.type === 'identifier') out.push(textOf(child));
    else if (child.type === 'attribute') {
      const attr = textOf(childField(child, 'attribute'));
      if (attr) out.push(attr);
    }
  }
  return out;
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

/**
 * Class-level attribute assignments (`supports_async_task = True`, `ready: bool = False`) as
 * their left-hand identifier nodes. Only simple `NAME = value` shapes are modeled — subscript /
 * destructuring targets are skipped. `self.attr` instance attributes are modeled separately by
 * `instanceAttributes`.
 */
function classAttributes(body: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (const child of body.namedChildren) {
    if (child.type !== 'expression_statement') continue;
    const assignment = child.namedChildren.find((c) => c.type === 'assignment');
    const left = assignment ? childField(assignment, 'left') : null;
    if (left?.type === 'identifier') out.push(left);
  }
  return out;
}

function attributeToSymbol(file: string, parentId: string, node: SyntaxNode): SymbolIR {
  const name = textOf(node);
  return {
    id: `${parentId}.${name}`,
    name,
    kind: 'property',
    span: nodeSpan(file, node),
    members: [],
    extendsIds: [],
    implementsIds: [],
  };
}

/**
 * Instance attributes (`self.x = …` / `cls.x = …` in a method body) as `property` members. The
 * first parameter is the instance/class reference (`self` by convention, `cls` for classmethods),
 * so `patch.object(Cls, "x", …)` on an instance attribute resolves instead of false-flagging
 * DRIFT-001 missing-member.
 */
function instanceAttributes(file: string, parentId: string, fnNode: SyntaxNode): SymbolIR[] {
  const params = childField(fnNode, 'parameters');
  const first = params?.namedChildren[0];
  const selfName = first ? textOf(first.namedChild(0) ?? first) : null;
  if (!selfName) return [];
  const body = childField(fnNode, 'body');
  if (!body) return [];
  const out: SymbolIR[] = [];
  const seen = new Set<string>();
  walk(body, (node) => {
    if (node.type !== 'assignment') return;
    const left = childField(node, 'left');
    if (left?.type !== 'attribute') return;
    if (textOf(childField(left, 'object')) !== selfName) return;
    const attr = textOf(childField(left, 'attribute'));
    if (!attr || seen.has(attr)) return;
    seen.add(attr);
    out.push({
      id: `${parentId}.${attr}`,
      name: attr,
      kind: 'property',
      span: nodeSpan(file, left),
      members: [],
      extendsIds: [],
      implementsIds: [],
    });
  });
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
