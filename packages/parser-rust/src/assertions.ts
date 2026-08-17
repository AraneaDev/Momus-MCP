import type { AssertionIR, ExprIR, SourceSpan, TestFnIR } from '@momus/core';
import type { RustExpr, RustFile, RustItem } from './ast.ts';

const ASSERT_MACROS = ['assert', 'assert_eq', 'assert_ne', 'assert_matches'];

export function extractAssertions(file: RustFile, path: string): AssertionIR[] {
  const out: AssertionIR[] = [];
  const walkItems = (items: RustItem[]): void => {
    for (const item of items) {
      if (item.kind === 'fn' && item.attrs.some((a) => a.path === 'test')) {
        const fnId = `${path}#fn:${item.span.line}`;
        for (const expr of item.body) collect(expr, path, fnId, out);
      } else if (item.kind === 'mod') {
        walkItems(item.items);
      }
    }
  };
  walkItems(file.items);
  return out;
}

function collect(expr: RustExpr, path: string, fnId: string, out: AssertionIR[]): void {
  if (expr.kind === 'macro' && ASSERT_MACROS.includes(expr.macroPath ?? '')) {
    const operands =
      expr.macroPath === 'assert' ? (expr.args ?? []).flatMap(binaryOperands) : (expr.args ?? []).map(operand);
    out.push({
      id: `${fnId}:${expr.span.line}:${expr.span.column}`,
      span: spanOf(path, expr.span),
      api: expr.macroPath ?? 'assert',
      operands,
      fnId,
    });
  }
  if (expr.receiver) collect(expr.receiver, path, fnId, out);
  for (const a of expr.args ?? []) collect(a, path, fnId, out);
  if (expr.left) collect(expr.left, path, fnId, out);
  if (expr.right) collect(expr.right, path, fnId, out);
}

/** `assert!(a == b)` -> operands of the comparison; otherwise the expression itself. */
function binaryOperands(e: RustExpr): ExprIR[] {
  if (e.kind === 'binary' && (e.op === '==' || e.op === '!=')) return [operand(e.left!), operand(e.right!)];
  return [operand(e)];
}

function operand(e: RustExpr): ExprIR {
  const kind: ExprIR['kind'] =
    e.kind === 'literal'
      ? 'literal'
      : e.kind === 'call' || e.kind === 'method-call'
        ? 'call'
        : e.kind === 'path'
          ? 'identifier'
          : 'unknown';
  return {
    kind,
    text: e.text,
    mockRefs: [],
    provenance: e.literal ? 'literal' : 'unknown',
    constant: e.kind === 'literal',
  };
}

export function extractTestFunctions(file: RustFile, path: string): TestFnIR[] {
  const out: TestFnIR[] = [];
  const walkItems = (items: RustItem[]): void => {
    for (const item of items) {
      if (item.kind === 'fn' && item.attrs.some((a) => a.path === 'test')) {
        out.push({
          id: `${path}#fn:${item.span.line}`,
          span: spanOf(path, item.span),
          hasProductionCalls: false,
          productionCallCount: 0,
          assertionCount: countAssertions(item.body),
        });
      } else if (item.kind === 'mod') {
        walkItems(item.items);
      }
    }
  };
  walkItems(file.items);
  return out;
}

function countAssertions(body: RustExpr[]): number {
  let n = 0;
  const walk = (e: RustExpr): void => {
    if (e.kind === 'macro' && (e.macroPath ?? '').startsWith('assert')) n++;
    if (e.receiver) walk(e.receiver);
    for (const a of e.args ?? []) walk(a);
    if (e.left) walk(e.left);
    if (e.right) walk(e.right);
  };
  for (const e of body) walk(e);
  return n;
}

function spanOf(path: string, s: { line: number; column: number }): SourceSpan {
  return { file: path, startLine: s.line, startCol: s.column, endLine: s.line, endCol: s.column + 1 };
}
