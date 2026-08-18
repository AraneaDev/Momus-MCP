import type { SignatureIR, SourceSpan, SymbolIR } from '@momus/core';
import type { RustFile, RustItem, RustSignature } from './ast.ts';
import { rustTypeToIr } from './types.ts';

export function extractSymbols(file: RustFile, path: string): SymbolIR[] {
  const out: SymbolIR[] = [];
  for (const item of file.items) walk(item, path, '', out);
  // Rust model: `impl` blocks emit their methods as top-level symbols keyed `<TypeId>.<method>`
  // (the walker has no back-reference to the struct it may not have seen yet). Attach them to
  // the owning type's `members` so `membersOf` (DRIFT-001/002/003) sees impl methods — same
  // contract the trait/struct cases already satisfy with inline members.
  const byId = new Map(out.map((s) => [s.id, s]));
  for (const s of out) {
    if (s.kind !== 'method') continue;
    const dot = s.id.lastIndexOf('.');
    if (dot <= 0) continue;
    const owner = byId.get(s.id.slice(0, dot));
    if (owner && !owner.members.some((m) => m.id === s.id)) owner.members.push(s);
  }
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
        // `trait Derived : Base` inherits `Base`'s methods. Resolve each supertrait to its
        // same-file symbol id (`${path}#Base`) — path-qualified/external supertraits
        // (`std::fmt::Debug`, `export::ExportTrait`) won't resolve, which DRIFT-001 treats as a
        // conservative skip (a "missing" member may be inherited) instead of a false flag.
        extendsIds: item.supertraits.map((name) => `${path}#${name}`),
        implementsIds: [],
      });
      break;
    }
    case 'impl': {
      // Prefer the serializer's clean `name` (the last path segment — `foo::Foo` -> `Foo`, the
      // referent for `&'a Foo`), falling back to the token-stream text (`Box < T >` -> `Box`).
      // The text alone kept a path-qualified self-type (`impl foo::Foo`) unresolved, so its
      // methods never attached to `Foo` (faux's `paths.rs` exposed this).
      const name = item.selfType.name || (item.selfType.text.split('<')[0] ?? '').replace(/[&'\s]/g, '');
      const parent = `${path}#${name}`;
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
