/**
 * tree-sitter-python helpers. Node shapes below were validated by the experiments/python-spike
 * probe against tree-sitter 0.25.1 + tree-sitter-python 0.25.0 — do not trust memory over these.
 *
 * - A function is `function_definition` with fields `name` (identifier), `parameters`,
 *   `return_type` (a `type` node), `body` (block). Methods are `function_definition` inside a
 *   `class_definition` `body`.
 * - A class is `class_definition` with fields `name` (identifier), `superclasses` (argument_list,
 *   optional), `body` (block).
 * - `@decorator` wraps the def in a `decorated_definition`; the function is its `definition` field.
 * - Imports: `import_statement` (dotted `identifier`/`dotted_name` children) and
 *   `import_from_statement` (`module_name` field, which is `relative_import` for `from .x`).
 * - A call is `call` with `function` (identifier/attribute) and `arguments` (argument_list);
 *   keyword args are `keyword_argument` with `name` + `value` fields.
 * - Attribute access is `attribute` with `object` + `attribute` fields (`mocker.patch.object` =
 *   attribute(object=attribute(object=identifier `mocker`, attribute `patch`), attribute `object`)).
 * - Assignment is `assignment` with `left` + `right` fields (usually inside `expression_statement`).
 * - An assert is `assert_statement`; `assert x == y` wraps a `comparison_operator` whose operator
 *   sits in the `operators` field, with the operands on either side of it.
 * - Annotations: `typed_parameter`/`typed_default_parameter` carry a `type` field; the function's
 *   `return_type` is also a `type` node. The `type` node's `.text` is the annotation source
 *   (`int`, `list[int]`, `int | None`, `Callable[[int], str]`, or a quoted forward ref `"Item"`).
 *   Read annotations from that source text (see types.ts), not structurally — the generic/union
 *   node wrappers (`generic_type`, `binary_operator`) are noise for our purposes.
 *
 * IMPORTANT: `parser.setLanguage()` must receive the WHOLE `tree-sitter-python` module, not its
 * `.language` member. The module carries a `nodeTypeInfo` array that tree-sitter's JS wrapper uses
 * to build per-node subclasses; passing `.language` alone skips that and crashes at unmarshal time
 * with `Cannot read properties of undefined (reading '<id>')`.
 */
import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';

export type SyntaxNode = Parser.SyntaxNode;

export interface PyLoc {
  line: number; // 0-based
  column: number; // 0-based
}

export function parsePython(source: string): { root: SyntaxNode; hasError: boolean } {
  const parser = new Parser();
  parser.setLanguage(Python as unknown as Parser.Language);
  const tree = parser.parse(source);
  return { root: tree.rootNode, hasError: tree.rootNode.hasError };
}

/** Depth-first walk over every node (named and unnamed). Filter with `node.isNamed` if needed. */
export function walk(root: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  const stack: SyntaxNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    visit(node);
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child) stack.push(child);
    }
  }
}

export function childField(node: SyntaxNode, field: string): SyntaxNode | null {
  return node.childForFieldName(field);
}

export function textOf(node: SyntaxNode | null | undefined): string {
  return node ? node.text : '';
}

export function start(node: SyntaxNode): PyLoc {
  return { line: node.startPosition.row, column: node.startPosition.column };
}

export function end(node: SyntaxNode): PyLoc {
  return { line: node.endPosition.row, column: node.endPosition.column };
}
