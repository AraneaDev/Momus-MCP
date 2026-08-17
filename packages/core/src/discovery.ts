/** File discovery (spec docs/02 §2.1, §2.7 caps). */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { anyMatch } from './glob.ts';
import { allExtensions } from './languages.ts';

/** Source-file extensions recognized for indexing, derived from the language registry. */
const SOURCE_EXT = new RegExp(`[.](${allExtensions().join('|')})$`);

export interface DiscoveredFile {
  path: string; // absolute
  sizeBytes: number;
}

export interface DiscoveryOptions {
  testPatterns: string[];
  ignorePatterns: string[];
  maxFileSizeBytes: number;
  maxIndexedLines: number;
  root: string;
}

export interface DiscoveryResult {
  files: DiscoveredFile[];
  skipped: Array<{ path: string; reason: string }>;
}

function gitignoreRules(root: string): string[] {
  const gi = join(root, '.gitignore');
  if (!existsSync(gi)) return [];
  return readFileSync(gi, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'));
}

const isIgnored = (abs: string, root: string, ignore: string[]): boolean => {
  const rel = relative(root, abs).replace(/\\/g, '/');
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
  return ignore.some((p) => {
    const norm = p.replace(/\\/g, '/');
    if (norm.startsWith('/')) return matchRel(norm.slice(1), rel);
    return matchRel(norm, rel) || matchRel(`${norm}/**`, rel);
  });
};

function matchRel(pattern: string, rel: string): boolean {
  return anyMatch([pattern], rel) || anyMatch([pattern], rel.split('/').pop() ?? '');
}

export function discoverFiles(opts: DiscoveryOptions): DiscoveryResult {
  const { root, testPatterns, ignorePatterns, maxFileSizeBytes, maxIndexedLines } = opts;
  const ignore = [...ignorePatterns, ...gitignoreRules(root)];
  const files: DiscoveredFile[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  let lines = 0;
  let capped = false;

  const isTest = (rel: string): boolean => anyMatch(testPatterns, rel);

  const walk = (dir: string) => {
    if (capped) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (isIgnored(abs, root, ignore)) continue;
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === 'node_modules') continue;
        walk(abs);
        continue;
      }
      if (!e.isFile()) continue;
      const rel = relative(root, abs).replace(/\\/g, '/');
      if (!isTest(rel) && !SOURCE_EXT.test(rel)) continue;
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.size > maxFileSizeBytes) {
        skipped.push({ path: abs, reason: `SYS-002: file exceeds ${maxFileSizeBytes} bytes` });
        continue;
      }
      if (lines + st.size / 32 > maxIndexedLines) {
        // ~32 bytes/line heuristic
        capped = true;
        skipped.push({ path: abs, reason: 'SYS-002: workspace exceeds maxIndexedLines' });
        return;
      }
      lines += st.size / 32;
      files.push({ path: abs, sizeBytes: st.size });
    }
  };
  walk(resolve(root));
  return { files, skipped };
}
