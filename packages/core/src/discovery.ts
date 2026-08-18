/** File discovery (spec docs/02 §2.1, §2.7 caps). */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { anyMatch, matchGlob } from './glob.ts';
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

/** A parsed .gitignore rule (spec docs/02 §2.1). */
interface GitignoreRule {
  pattern: string; // glob, leading '/' stripped, trailing '/' folded into dirOnly
  negated: boolean; // '!' prefix
  dirOnly: boolean; // trailing '/'
  anchored: boolean; // pattern contains a '/' (or had a leading '/'), so matches relative to root
}

function parseGitignoreLine(raw: string): GitignoreRule | null {
  // Strip trailing whitespace (gitignore ignores unescaped trailing space).
  let line = raw.trimEnd();
  if (line === '' || line.startsWith('#')) return null;
  let negated = false;
  if (line.startsWith('!')) {
    negated = true;
    line = line.slice(1);
  }
  if (line === '') return null;
  let dirOnly = false;
  if (line.endsWith('/')) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  let anchored = false;
  if (line.startsWith('/')) {
    anchored = true;
    line = line.slice(1);
  } else if (line.includes('/')) {
    anchored = true;
  }
  if (line === '') return null;
  return { pattern: line, negated, dirOnly, anchored };
}

function readGitignore(root: string): GitignoreRule[] {
  const gi = join(root, '.gitignore');
  if (!existsSync(gi)) return [];
  const rules: GitignoreRule[] = [];
  for (const raw of readFileSync(gi, 'utf8').split('\n')) {
    const rule = parseGitignoreLine(raw);
    if (rule) rules.push(rule);
  }
  return rules;
}

function pathAncestors(rel: string): string[] {
  const parts = rel.split('/');
  const out: string[] = [];
  for (let i = parts.length - 1; i >= 1; i--) out.push(parts.slice(0, i).join('/'));
  return out;
}

/** True when a rule matches a path — either the path itself or an ancestor directory. */
function ruleMatches(rule: GitignoreRule, rel: string, isDir: boolean): boolean {
  if (rule.anchored) {
    for (const cand of [rel, ...pathAncestors(rel)]) {
      const candIsDir = cand !== rel || isDir;
      if (rule.dirOnly && !candIsDir) continue;
      if (matchGlob(rule.pattern, cand)) return true;
    }
    return false;
  }
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const segIsDir = i < segs.length - 1 || isDir;
    if (rule.dirOnly && !segIsDir) continue;
    if (matchGlob(rule.pattern, segs[i]!)) return true;
  }
  return false;
}

/** Returns true when a path is excluded by .gitignore (negations honored, last match wins). */
function gitignorePredicate(root: string): (rel: string, isDir: boolean) => boolean {
  const rules = readGitignore(root);
  if (rules.length === 0) return () => false;
  return (rel, isDir) => {
    let ignored = false;
    for (const rule of rules) {
      if (ruleMatches(rule, rel, isDir)) ignored = !rule.negated;
    }
    return ignored;
  };
}

const isIgnored = (
  abs: string,
  root: string,
  ignore: string[],
  gitIgnored: (rel: string, isDir: boolean) => boolean,
  isDir: boolean,
): boolean => {
  const rel = relative(root, abs).replace(/\\/g, '/');
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
  if (
    ignore.some((p) => {
      const norm = p.replace(/\\/g, '/');
      if (norm.startsWith('/')) return matchRel(norm.slice(1), rel);
      return matchRel(norm, rel) || matchRel(`${norm}/**`, rel);
    })
  )
    return true;
  return gitIgnored(rel, isDir);
};

function matchRel(pattern: string, rel: string): boolean {
  return anyMatch([pattern], rel) || anyMatch([pattern], rel.split('/').pop() ?? '');
}

export function discoverFiles(opts: DiscoveryOptions): DiscoveryResult {
  const { root, testPatterns, ignorePatterns, maxFileSizeBytes, maxIndexedLines } = opts;
  const ignore = [...ignorePatterns];
  const gitIgnored = gitignorePredicate(root);
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
      if (isIgnored(abs, root, ignore, gitIgnored, e.isDirectory())) continue;
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
