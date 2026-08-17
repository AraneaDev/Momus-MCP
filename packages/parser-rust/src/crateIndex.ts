import { parseRust } from './wasm.ts';
import type { RustItem } from './ast.ts';

/**
 * Resolves a Rust `use`/type path (e.g. `crate::repo::Repo`) to a production symbol id
 * (`${filePath}#${name}`), matching the id convention of `extractSymbols`. The audit engine
 * builds its own core `SymbolIndex` from production modules, so this index only needs
 * path/name resolution — it does not duplicate the member graph.
 */
export class RustCrateIndex {
  private moduleToFile = new Map<string, string>();
  private nameToFiles = new Map<string, string[]>();

  constructor(files: { path: string; source: string }[]) {
    for (const f of files) {
      const module = moduleOf(f.path);
      this.moduleToFile.set(module, f.path);
      this.moduleToFile.set(module.replace(/::/g, '/'), f.path);
      const file = parseRust(f.source);
      for (const item of file.items) {
        if (!('name' in item)) continue;
        const name = (item as RustItem & { name: string }).name;
        const list = this.nameToFiles.get(name) ?? [];
        list.push(f.path);
        this.nameToFiles.set(name, list);
      }
    }
  }

  /** Resolve a `use`/type specifier to a production symbol id, or null when unresolvable. */
  resolveSymbolId(specifier: string): string | null {
    const segs = specifier.split('::').filter((s) => s && s !== 'crate' && s !== 'self' && s !== 'super');
    const name = segs.pop() ?? '';
    const module = segs.join('::');
    const file =
      this.moduleToFile.get(module) ??
      this.moduleToFile.get(module.replace(/::/g, '/')) ??
      this.nameToFiles.get(name)?.[0];
    if (!file || !name) return null;
    return `${file}#${name}`;
  }
}

/** Derive the module path of a .rs file (lib.rs/main.rs/mod.rs -> crate root). */
export function moduleOf(path: string): string {
  const base = path.split(/[\\/]/).pop()?.replace(/\.rs$/, '') ?? 'lib';
  return base === 'lib' || base === 'main' || base === 'mod' ? 'crate' : base;
}
