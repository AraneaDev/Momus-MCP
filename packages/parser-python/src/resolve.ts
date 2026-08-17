/** Python import resolution: dotted specifier -> absolute file path (conservative, never throws). */
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function resolvePythonImport(specifier: string, fromFile: string): string | null {
  const trimmed = specifier.trim().replace(/^\.+/, '');
  if (!trimmed) return null;
  const parts = trimmed.split('.');

  // Absolute imports: walk upward from the file, looking for a package root that contains the path.
  // src-layout (`src/pkg/mod.py`, the modern default for flask/django/httpx) is probed at each
  // ancestor in addition to the flat layout — resolves `flask.sessions` against `src/flask/`.
  let dir = dirname(fromFile);
  for (let depth = 0; depth < 8; depth++) {
    const candidate = resolveModulePath(join(dir, ...parts));
    if (candidate) return candidate;
    const srcCandidate = resolveModulePath(join(dir, 'src', ...parts));
    if (srcCandidate) return srcCandidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function resolveModulePath(base: string): string | null {
  if (isFile(`${base}.py`)) return `${base}.py`;
  if (isFile(join(base, '__init__.py'))) return join(base, '__init__.py');
  return null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
