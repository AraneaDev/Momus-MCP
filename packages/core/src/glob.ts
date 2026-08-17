/**
 * Minimal glob matcher (replaces picomatch; core keeps zero runtime deps).
 * Supports: * (within a segment), ** (cross-directory), ? (single char),
 * {a,b} alternation, [abc] classes. Paths use forward slashes.
 * A trailing slash after ** also matches zero directories.
 */
export function matchGlob(pattern: string, path: string): boolean {
  // Normalize BOTH sides: a Windows-style path ('src\\a.ts') must match a forward-slash
  // pattern ('src/a.ts') and vice versa. (Found by mutation testing: the old test passed
  // by accident — backslashes are just non-slash chars, so '**' swallowed them whole.)
  return toRegExp(pattern).test(path.replace(/\\/g, '/'));
}

export function anyMatch(patterns: string[], path: string): boolean {
  return patterns.some((p) => matchGlob(p, path));
}

export function toRegExp(pattern: string): RegExp {
  let out = '^';
  let i = 0;
  const p = pattern.replace(/\\/g, '/');
  while (i < p.length) {
    const c = p[i]!;
    if (c === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
        continue;
      }
      out += '[^/]*';
      i++;
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      i++;
      continue;
    }
    if (c === '{') {
      const end = p.indexOf('}', i);
      if (end > 0) {
        const alts = p
          .slice(i + 1, end)
          .split(',')
          .map(escapeRegex)
          .join('|');
        out += '(?:' + alts + ')';
        i = end + 1;
        continue;
      }
    }
    if (c === '[') {
      const end = p.indexOf(']', i);
      if (end > 0) {
        out += p.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    out += escapeRegex(c);
    i++;
  }
  return new RegExp(out + '$');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
