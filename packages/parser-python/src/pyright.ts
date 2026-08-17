/**
 * Type inference via the `pyright` CLI's `--createstub` subprocess.
 *
 * `pyright-internal` (the in-process API) is unpublished on npm, so we shell out to the
 * `pyright` package's CLI instead. `--createstub <module>` emits a `.pyi` stub per module
 * with each function/method's inferred return type written as a `# -> Type:` comment. We
 * parse those comments and map them back to source symbols. Everything is memoized per
 * project root and degrades to `undefined` (annotations-only) on any failure.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

const require = createRequire(import.meta.url);

/** root -> topModule -> (module path -> (qualified name -> return type string)). */
const cache = new Map<string, Map<string, Map<string, Map<string, string>> | undefined>>();

function findProjectRoot(fromFile: string): string {
  let dir = dirname(fromFile);
  for (let depth = 0; depth < 16; depth++) {
    if (
      existsSync(join(dir, 'pyproject.toml')) ||
      existsSync(join(dir, 'setup.py')) ||
      existsSync(join(dir, 'setup.cfg')) ||
      existsSync(join(dir, 'pyrightconfig.json'))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirname(fromFile);
}

/** Dotted module path of a source file relative to its project root (`pkg/mod.py` -> `pkg.mod`). */
function modulePathOf(file: string, root: string): string {
  const rel = relative(root, file).split(sep).join('/');
  const withoutPy = rel.endsWith('.py') ? rel.slice(0, -3) : rel;
  return withoutPy
    .split('/')
    .filter((segment) => segment && segment !== '__init__')
    .join('.');
}

/** Dotted module path of a generated stub file (`typings/pkg/mod.pyi` -> `pkg.mod`). */
function stubModulePathOf(stubFile: string, stubsDir: string): string {
  const rel = relative(stubsDir, stubFile).split(sep).join('/');
  const withoutPyi = rel.endsWith('.pyi') ? rel.slice(0, -4) : rel;
  return withoutPyi
    .split('/')
    .filter((segment) => segment && segment !== '__init__')
    .join('.');
}

function listStubs(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = join(current, entry);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(p);
      else if (entry.endsWith('.pyi')) out.push(p);
    }
  }
  return out;
}

/** Extract `def name(...): # -> Type:` return-type comments into a qualified-name -> type map. */
function parseStubReturnTypes(stubSource: string): Map<string, string> {
  const out = new Map<string, string>();
  const classStack: Array<{ name: string; indent: number }> = [];
  for (const line of stubSource.split('\n')) {
    const indent = line.length - line.trimStart().length;
    const classMatch = /^\s*class\s+(\w+)/.exec(line);
    if (classMatch) {
      while (classStack.length && classStack[classStack.length - 1]!.indent >= indent) classStack.pop();
      classStack.push({ name: classMatch[1]!, indent });
      continue;
    }
    const defMatch = /^\s*def\s+(\w+)\s*\(.*\)\s*:\s*#\s*->\s*(.*)$/.exec(line);
    if (!defMatch) continue;
    let type = defMatch[2]!.trim();
    if (type.endsWith(':')) type = type.slice(0, -1).trim();
    const qualified = classStack.length ? `${classStack.map((c) => c.name).join('.')}.${defMatch[1]!}` : defMatch[1]!;
    out.set(qualified, type);
  }
  return out;
}

function resolvePyright(): string {
  return require.resolve('pyright');
}

function buildStubs(root: string, topModule: string): Map<string, Map<string, string>> | undefined {
  const tmp = mkdtempSync(join(tmpdir(), 'momus-pyright-'));
  try {
    writeFileSync(
      join(tmp, 'pyrightconfig.json'),
      JSON.stringify({ extraPaths: [root], pythonVersion: '3.12', typeCheckingMode: 'basic' }, null, 2),
    );
    execFileSync(process.execPath, [resolvePyright(), '--createstub', topModule], {
      cwd: tmp,
      stdio: 'pipe',
      timeout: 30_000,
    });
    const stubsDir = join(tmp, 'typings');
    if (!existsSync(stubsDir)) return undefined;
    const stubs = new Map<string, Map<string, string>>();
    for (const stubFile of listStubs(stubsDir)) {
      stubs.set(stubModulePathOf(stubFile, stubsDir), parseStubReturnTypes(readFileSync(stubFile, 'utf8')));
    }
    return stubs;
  } catch {
    return undefined;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Inferred return types for a source file's symbols, keyed by qualified name
 * (`fn` for module functions, `Class.method` for methods). `undefined` when inference is
 * unavailable (file not on disk, pyright missing/failed) — callers keep source annotations.
 */
export function getInferredReturnTypes(fromFile: string): Map<string, string> | undefined {
  if (!existsSync(fromFile)) return undefined;
  let root: string;
  let modulePath: string;
  try {
    root = findProjectRoot(fromFile);
    modulePath = modulePathOf(fromFile, root);
  } catch {
    return undefined;
  }
  if (!modulePath) return undefined;
  const topModule = modulePath.split('.')[0] ?? modulePath;
  let rootCache = cache.get(root);
  if (!rootCache) {
    rootCache = new Map();
    cache.set(root, rootCache);
  }
  if (!rootCache.has(topModule)) {
    try {
      rootCache.set(topModule, buildStubs(root, topModule));
    } catch {
      rootCache.set(topModule, undefined);
    }
  }
  return rootCache.get(topModule)?.get(modulePath);
}
