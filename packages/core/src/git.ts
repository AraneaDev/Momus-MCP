/** Git plumbing for git-diff scope (spec docs/03 §3.1, docs/10 Step 4). Read-only. */
import { execFileSync } from 'node:child_process';
import { relative, resolve } from 'node:path';

/** Prefix from the repo toplevel back to `root` ('' when `root` is the toplevel). */
function repoPrefix(root: string): string {
  const toplevel = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    maxBuffer: 1 << 20,
  }).trim();
  const prefix = relative(resolve(root), resolve(toplevel));
  return prefix && !prefix.startsWith('..') ? prefix : '';
}

/** Parse `git diff --name-status` output; rename pairs contribute every path. */
function parseNameStatus(out: string): string[] {
  const paths: string[] = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    if (parts.length < 2) continue;
    for (const part of parts.slice(1)) {
      if (part.startsWith('"')) continue; // quoted path (non-ASCII) — skip conservatively
      paths.push(part);
    }
  }
  return paths;
}

function parseUntracked(out: string): string[] {
  const paths: string[] = [];
  for (const p of out.split('\n')) {
    const trimmed = p.trim();
    if (trimmed && !trimmed.startsWith('"')) paths.push(trimmed);
  }
  return paths;
}

function relToRoot(paths: string[], prefix: string): string[] {
  return prefix === '' ? paths : paths.map((p) => `${prefix}/${p}`);
}

/**
 * Paths (workspace-relative to `root`) changed vs `baseRef`, including staged and
 * unstaged working-tree changes when `baseRef` is a commit. Rename pairs contribute
 * both the old and new path so either side is flagged. Non-ASCII (quoted) paths are
 * skipped conservatively — better to under-report than mis-map.
 */
export function gitChangedPaths(root: string, baseRef: string): string[] {
  const prefix = repoPrefix(root);
  const out = execFileSync('git', ['-C', root, 'diff', '--name-status', '--find-renames', baseRef, '--'], {
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
  const untracked = execFileSync('git', ['-C', root, 'ls-files', '--others', '--exclude-standard'], {
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
  return relToRoot([...parseUntracked(untracked), ...parseNameStatus(out)], prefix);
}

/**
 * Paths staged in the index vs `baseRef` (the pre-commit gate). Only the index diff is
 * considered, so unstaged working-tree edits and untracked files are excluded. Rename
 * pairs contribute both sides.
 */
export function gitStagedPaths(root: string, baseRef: string): string[] {
  const prefix = repoPrefix(root);
  const out = execFileSync('git', ['-C', root, 'diff', '--cached', '--name-status', '--find-renames', baseRef, '--'], {
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
  return relToRoot(parseNameStatus(out), prefix);
}
