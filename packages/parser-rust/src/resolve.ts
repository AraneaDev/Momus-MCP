import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { RustCrateIndex } from './crateIndex.ts';

const cache = new Map<string, RustCrateIndex>(); // crate root -> index

function findCrateRoot(fromFile: string): string {
  let dir = dirname(fromFile);
  for (let depth = 0; depth < 16; depth++) {
    if (existsSync(join(dir, 'Cargo.toml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirname(fromFile);
}

function listRsFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  const seen = new Set<string>();
  while (stack.length) {
    const dir = stack.pop()!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (dir.includes(`${sep}target${sep}`) || dir.includes(`${sep}node_modules${sep}`)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(p);
      else if (e.endsWith('.rs')) out.push(p);
    }
  }
  return out;
}

/** Lazily build (and memoize per crate root) the crate index for a source file. */
export function getCrateIndex(fromFile: string): RustCrateIndex {
  const root = findCrateRoot(fromFile);
  const cached = cache.get(root);
  if (cached) return cached;
  const files = listRsFiles(root).map((path) => ({ path, source: readFileSync(path, 'utf8') }));
  const idx = new RustCrateIndex(files);
  cache.set(root, idx);
  return idx;
}

/** Resolve a `use`/`mod` specifier to an absolute path, or null (LanguageParser contract). */
export function resolveRustImport(specifier: string, fromFile: string): string | null {
  const id = getCrateIndex(fromFile).resolveSymbolId(specifier);
  return id ? (id.split('#')[0] ?? null) : null;
}
