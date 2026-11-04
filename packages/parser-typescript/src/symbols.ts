/** Symbol extraction (spec docs/02 §2.3.2): classes, interfaces, functions, exports. */
import type { SymbolIR } from '@momus/core';
import { span } from '@momus/core';
import * as ts from 'typescript';
import { signatureToIR } from './types.ts';

export function extractSymbols(sf: ts.SourceFile): {
  symbols: SymbolIR[];
  exports: string[];
  /** True when the export list cannot be enumerated (`export *`, `export =`, opaque `module.exports`). */
  exportsOpen: boolean;
} {
  const symbols: SymbolIR[] = [];
  const exports: string[] = [];
  let exportsOpen = false;
  const file = sf.fileName;

  const memberSpan = (m: ts.Node) => {
    const p = sf.getLineAndCharacterOfPosition(m.getStart());
    const e = sf.getLineAndCharacterOfPosition(m.getEnd());
    return span(file, p.line + 1, p.character + 1, e.line + 1, e.character + 1);
  };

  for (const stmt of sf.statements) {
    const exported = hasExportModifier(stmt);
    // `export default function Widget` / `export default class {}` export the name `default`
    // (the declared name is still recorded below so the symbol index can find the symbol).
    if (exported && hasModifier(stmt, ts.SyntaxKind.DefaultKeyword)) exports.push('default');
    if (ts.isExportAssignment(stmt)) {
      // `export default <expr>` exports `default`; `export = X` replaces the whole module.
      if (stmt.isExportEquals) exportsOpen = true;
      else exports.push('default');
      continue;
    }
    if (ts.isExpressionStatement(stmt)) {
      const cjs = commonJsExports(stmt.expression);
      if (cjs) {
        exports.push(...cjs.names);
        if (cjs.open) exportsOpen = true;
      }
      continue;
    }
    if (ts.isClassDeclaration(stmt) && stmt.name) {
      const id = `${file}#${stmt.name.text}`;
      if (exported) exports.push(stmt.name.text);
      const members: SymbolIR[] = [];
      for (const m of stmt.members) {
        if (ts.isMethodDeclaration(m)) {
          members.push({
            id: `${id}.${m.name.getText(sf)}`,
            name: m.name.getText(sf),
            kind: 'method',
            span: memberSpan(m),
            members: [],
            extendsIds: [],
            implementsIds: [],
            signature: signatureToIR(m),
            visibility: m.modifiers?.some((x) => x.kind === ts.SyntaxKind.PublicKeyword)
              ? 'public'
              : m.modifiers?.some((x) => x.kind === ts.SyntaxKind.PrivateKeyword)
                ? 'private'
                : m.modifiers?.some((x) => x.kind === ts.SyntaxKind.ProtectedKeyword)
                  ? 'protected'
                  : undefined,
            isStatic: m.modifiers?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword),
            isAbstract: m.modifiers?.some((x) => x.kind === ts.SyntaxKind.AbstractKeyword),
          });
        } else if (ts.isGetAccessorDeclaration(m)) {
          members.push({
            id: `${id}.${m.name.getText(sf)}`,
            name: m.name.getText(sf),
            kind: 'property',
            span: memberSpan(m),
            members: [],
            extendsIds: [],
            implementsIds: [],
            signature: { parameters: [], returnType: undefined, typeParams: [] },
          });
        } else if (ts.isPropertyDeclaration(m)) {
          members.push({
            id: `${id}.${m.name.getText(sf)}`,
            name: m.name.getText(sf),
            kind: 'property',
            span: memberSpan(m),
            members: [],
            extendsIds: [],
            implementsIds: [],
            isStatic: m.modifiers?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword),
          });
        }
      }
      const extendsClause = stmt.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
      const implementsClause = stmt.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ImplementsKeyword);
      symbols.push({
        id,
        name: stmt.name.text,
        kind: 'class',
        span: memberSpan(stmt),
        members,
        extendsIds: extendsClause?.types.map((t) => `${file}#${t.expression.getText(sf)}`) ?? [],
        implementsIds: implementsClause?.types.map((t) => `${file}#${t.expression.getText(sf)}`) ?? [],
      });
    } else if (ts.isInterfaceDeclaration(stmt)) {
      const id = `${file}#${stmt.name.text}`;
      if (exported) exports.push(stmt.name.text);
      const members: SymbolIR[] = [];
      for (const m of stmt.members) {
        if (ts.isMethodSignature(m)) {
          members.push({
            id: `${id}.${m.name.getText(sf)}`,
            name: m.name.getText(sf),
            kind: 'method',
            span: memberSpan(m),
            members: [],
            extendsIds: [],
            implementsIds: [],
            signature: signatureToIR(m),
          });
        } else if (ts.isPropertySignature(m)) {
          members.push({
            id: `${id}.${m.name.getText(sf)}`,
            name: m.name.getText(sf),
            kind: 'property',
            span: memberSpan(m),
            members: [],
            extendsIds: [],
            implementsIds: [],
          });
        }
      }
      const extendsClause = stmt.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
      symbols.push({
        id,
        name: stmt.name.text,
        kind: 'interface',
        span: memberSpan(stmt),
        members,
        extendsIds: extendsClause?.types.map((t) => `${file}#${t.expression.getText(sf)}`) ?? [],
        implementsIds: [],
      });
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const id = `${file}#${stmt.name.text}`;
      if (exported) exports.push(stmt.name.text);
      symbols.push({
        id,
        name: stmt.name.text,
        kind: 'function',
        span: memberSpan(stmt),
        members: [],
        extendsIds: [],
        implementsIds: [],
        signature: signatureToIR(stmt),
      });
    } else if (ts.isVariableStatement(stmt) && exported) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) exports.push(d.name.text);
      }
    } else if (ts.isTypeAliasDeclaration(stmt) && exported) {
      exports.push(stmt.name.text);
    } else if (ts.isEnumDeclaration(stmt) && exported) {
      exports.push(stmt.name.text);
    } else if (ts.isExportDeclaration(stmt)) {
      // Barrel re-exports: `export { a, b as c } [from '...']` and `export * as ns from '...'`.
      // `export * from '...'` is not enumerated (its names require resolving the target module).
      const clause = stmt.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const el of clause.elements) exports.push(el.name.text);
      } else if (clause && ts.isNamespaceExport(clause)) {
        exports.push(clause.name.text);
      } else if (!clause) {
        exportsOpen = true;
      }
    }
  }
  // A CommonJS module imported through ESM interop exposes `module.exports` as `default`.
  if (exports.length > 0 && !exports.includes('default') && hasCommonJsExports(sf)) exports.push('default');
  return { symbols, exports: [...new Set(exports)], exportsOpen };
}

function hasExportModifier(stmt: ts.Node): boolean {
  return hasModifier(stmt, ts.SyntaxKind.ExportKeyword);
}

function hasModifier(stmt: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = (stmt as { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
  return modifiers?.some((m) => m.kind === kind) ?? false;
}

const isModuleExports = (e: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(e) &&
  ts.isIdentifier(e.expression) &&
  e.expression.text === 'module' &&
  e.name.text === 'exports';

const isExportsObject = (e: ts.Expression): boolean =>
  (ts.isIdentifier(e) && e.text === 'exports') || isModuleExports(e);

function propertyKey(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

/**
 * Names a top-level CommonJS export statement contributes:
 * `module.exports = { a, b: x, c() {} }`, `module.exports.a = …`, `exports.a = …`, and the
 * compiled-TS form `Object.defineProperty(exports, 'a', …)`. Anything whose keys cannot be read
 * (`module.exports = factory()`, a spread, `__exportStar(...)`) marks the export list open.
 */
function commonJsExports(expr: ts.Expression): { names: string[]; open: boolean } | undefined {
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const left = expr.left;
    if (isModuleExports(left)) {
      let right = expr.right;
      while (ts.isParenthesizedExpression(right)) right = right.expression;
      // `module.exports = exports = {...}` chains
      while (ts.isBinaryExpression(right) && right.operatorToken.kind === ts.SyntaxKind.EqualsToken)
        right = right.right;
      const names = ['default'];
      if (!ts.isObjectLiteralExpression(right)) return { names, open: true };
      let open = false;
      for (const p of right.properties) {
        if (ts.isSpreadAssignment(p)) {
          open = true;
          continue;
        }
        const key = p.name ? propertyKey(p.name) : undefined;
        if (key === undefined) open = true;
        else names.push(key);
      }
      return { names, open };
    }
    if (ts.isPropertyAccessExpression(left) && isExportsObject(left.expression)) {
      return { names: [left.name.text], open: false };
    }
    if (ts.isElementAccessExpression(left) && isExportsObject(left.expression)) {
      const arg = left.argumentExpression;
      return ts.isStringLiteral(arg) ? { names: [arg.text], open: false } : { names: [], open: true };
    }
    return undefined;
  }
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression;
    const [target, key] = expr.arguments;
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'Object' &&
      callee.name.text === 'defineProperty' &&
      target &&
      isExportsObject(target)
    ) {
      return key && ts.isStringLiteral(key) ? { names: [key.text], open: false } : { names: [], open: true };
    }
    // tslib / compiled-TS `__exportStar(require('./x'), exports)` re-exports an unknown set.
    if (ts.isIdentifier(callee) && /^_*exportStar$/.test(callee.text)) return { names: [], open: true };
  }
  return undefined;
}

function hasCommonJsExports(sf: ts.SourceFile): boolean {
  return sf.statements.some((s) => ts.isExpressionStatement(s) && commonJsExports(s.expression) !== undefined);
}
