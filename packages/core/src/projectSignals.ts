/**
 * Bounded, read-only project signals for the per-language readiness reports
 * (`momus doctor`, MCP `doctor_status`).
 *
 * These live in core rather than in the CLI because both the CLI and the MCP server need
 * them, and `@momus/cli` already depends on `@momus/mcp-server` — the server importing back
 * from the CLI would close a package cycle. Core is the one package both already depend on.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** How far up the tree a manifest search walks before giving up. */
const MANIFEST_SEARCH_DEPTH = 8;

/**
 * Skip lists, kept per language exactly as each counter had them before this module existed.
 * They are deliberately NOT unified: `target` matters only to Rust, the virtualenv names only
 * to Python, and widening a list changes the counts a `doctor` report prints. Dot-directories
 * other than `.git` are not skipped, so a `.github`-style directory is still walked.
 */
const SKIP_COMMON = ['node_modules', '.git', 'vendor', 'dist'] as const;
const SKIP_PHP = new Set<string>(SKIP_COMMON);
const SKIP_RUST = new Set<string>([...SKIP_COMMON, 'target']);
const SKIP_PYTHON = new Set<string>([...SKIP_COMMON, '.venv', 'venv', '__pycache__']);

/**
 * Is `filename` present in `root` or any of its ancestors (bounded depth)?
 * A package inside a monorepo can sit several levels below the manifest that governs it.
 */
export function findUpwards(root: string, filename: string): boolean {
  let dir = root;
  for (let depth = 0; depth < MANIFEST_SEARCH_DEPTH; depth++) {
    if (existsSync(join(dir, filename))) return true;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

/**
 * Count files under `root` whose name ends with `suffix`, stopping at `cap`.
 * Capped and skip-listed because this runs on every `doctor` call: the answer only has to
 * distinguish "none", "some", and "many", never to be exact.
 */
export function countFilesBySuffix(root: string, suffix: string, cap: number, skipDirs: ReadonlySet<string>): number {
  let count = 0;
  const stack = [root];
  const seen = new Set<string>();
  while (stack.length && count < cap) {
    const dir = stack.pop()!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (count >= cap) break;
      if (skipDirs.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(suffix)) count++;
    }
  }
  return count;
}

export interface PhpProjectSignals {
  composerJson: boolean;
  phpFiles: number;
}
export interface PythonProjectSignals {
  pyprojectToml: boolean;
  pyFiles: number;
}
export interface RustProjectSignals {
  cargoToml: boolean;
  rsFiles: number;
}

export function phpProjectSignals(root: string): PhpProjectSignals {
  return {
    composerJson: findUpwards(root, 'composer.json'),
    phpFiles: countFilesBySuffix(root, '.php', 200, SKIP_PHP),
  };
}

export function pythonProjectSignals(root: string): PythonProjectSignals {
  return {
    pyprojectToml: findUpwards(root, 'pyproject.toml'),
    pyFiles: countFilesBySuffix(root, '.py', 200, SKIP_PYTHON),
  };
}

export function rustProjectSignals(root: string): RustProjectSignals {
  return {
    cargoToml: findUpwards(root, 'Cargo.toml'),
    rsFiles: countFilesBySuffix(root, '.rs', 200, SKIP_RUST),
  };
}
