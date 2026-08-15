/** Symbol extraction (spec docs/02 §2.3.2): classes, interfaces, functions, exports. */
import type { SymbolIR } from '@momus/core';
import { span } from '@momus/core';
import * as ts from 'typescript';
import { signatureToIR } from './types.ts';

export function extractSymbols(sf: ts.SourceFile): { symbols: SymbolIR[]; exports: string[] } {
  const symbols: SymbolIR[] = [];
  const exports: string[] = [];
  const file = sf.fileName;

  const memberSpan = (m: ts.Node) => {
    const p = sf.getLineAndCharacterOfPosition(m.getStart());
    const e = sf.getLineAndCharacterOfPosition(m.getEnd());
    return span(file, p.line + 1, p.character + 1, e.line + 1, e.character + 1);
  };

  for (const stmt of sf.statements) {
    const exported = hasExportModifier(stmt);
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
            visibility: m.modifiers?.some((x) => x.kind === ts.SyntaxKind.PublicKeyword) ? 'public'
              : m.modifiers?.some((x) => x.kind === ts.SyntaxKind.PrivateKeyword) ? 'private'
              : m.modifiers?.some((x) => x.kind === ts.SyntaxKind.ProtectedKeyword) ? 'protected'
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
    }
  }
  return { symbols, exports };
}

function hasExportModifier(stmt: ts.Node): boolean {
  const modifiers = (stmt as { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}
