import type { SignatureIR, SourceSpan, SymbolIR } from '@momus/core';
import type { RustFile, RustItem, RustSignature } from './ast.ts';
import { rustTypeToIr } from './types.ts';

export function extractSymbols(file: RustFile, path: string): SymbolIR[] {
  const out: SymbolIR[] = [];
  for (const item of file.items) walk(item, path, '', out);
  return out;
}

function walk(item: RustItem, path: string, parentId: string, out: SymbolIR[]): void {
  switch (item.kind) {
    case 'fn': {
      const id = parentId ? `${parentId}.${item.name}` : `${path}#${item.name}`;
      out.push({
        id,
        name: item.name,
        kind: parentId ? 'method' : 'function',
        span: spanOf(path, item.span),
        members: [],
        extendsIds: [],
        implementsIds: [],
        signature: sigOf(item.sig),
        visibility: 'public',
        isStatic: false,
        isAbstract: false,
      });
      break;
    }
    case 'struct': {
      const id = `${path}#${item.name}`;
      const members: SymbolIR[] = item.fields.map((f) => ({
        id: `${id}.${f.name}`,
        name: f.name,
        kind: 'property',
        span: spanOf(path, f.span),
        members: [],
        extendsIds: [],
        implementsIds: [],
        signature: f.type ? { parameters: [], returnType: rustTypeToIr(f.type), typeParams: [] } : undefined,
        visibility: 'public',
        isStatic: false,
        isAbstract: false,
      }));
      out.push({
        id,
        name: item.name,
        kind: 'class',
        span: spanOf(path, item.span),
        members,
        extendsIds: [],
        implementsIds: [],
      });
      break;
    }
    case 'trait': {
      const id = `${path}#${item.name}`;
      const members: SymbolIR[] = [];
      for (const m of item.items) {
        if (!m.sig) continue;
        members.push({
          id: `${id}.${m.name}`,
          name: m.name,
          kind: 'method',
          span: spanOf(path, m.span),
          members: [],
          extendsIds: [],
          implementsIds: [],
          signature: sigOf(m.sig),
          visibility: 'public',
          isStatic: false,
          isAbstract: true,
        });
      }
      out.push({
        id,
        name: item.name,
        kind: 'interface',
        span: spanOf(path, item.span),
        members,
        extendsIds: [],
        implementsIds: [],
      });
      break;
    }
    case 'impl': {
      const parent = `${path}#${item.selfType.text.replace(/[<>, &]/g, '_')}`;
      for (const f of item.items) walk(f, path, parent, out);
      break;
    }
    case 'type':
      out.push({
        id: `${path}#${item.name}`,
        name: item.name,
        kind: 'type-alias',
        span: spanOf(path, item.span),
        members: [],
        extendsIds: [],
        implementsIds: [],
      });
      break;
    case 'mod':
      for (const child of item.items) walk(child, path, '', out);
      break;
    default:
      break; // enum/use/macro handled by imports (use) and mocks (macro) tasks
  }
}

function sigOf(sig: RustSignature): SignatureIR {
  return {
    parameters: sig.params.map((p) => ({
      name: p.name,
      type: rustTypeToIr(p.type),
      optional: false,
      variadic: false,
      hasDefault: false,
    })),
    returnType: sig.returnType ? rustTypeToIr(sig.returnType) : undefined,
    typeParams: sig.generics,
  };
}

function spanOf(path: string, s: { line: number; column: number }): SourceSpan {
  return { file: path, startLine: s.line, startCol: s.column, endLine: s.line, endCol: s.column + 1 };
}
