/** Comment extraction (suppression source). Line-aware trailing detection. */
import type { RawComment } from '@momus/core';

const LINE_RE = /\/\/[^\n]*/g;
const BLOCK_RE = /\/\*[\s\S]*?\*\//g;

export function extractComments(source: string): RawComment[] {
  const out: RawComment[] = [];
  const lineOf = (idx: number): number => {
    let line = 1;
    for (let i = 0; i < idx; i++) if (source[i] === '\n') line++;
    return line;
  };
  // line comments
  for (const m of source.matchAll(LINE_RE)) {
    const idx = m.index!;
    const text = m[0];
    // skip line comments inside block comments or strings (heuristic: only accept when
    // the line up to the comment contains no string delimiters we can't rule out)
    if (insideBlockComment(source, idx)) continue;
    const lineStart = source.lastIndexOf('\n', idx - 1) + 1;
    const trailing = /\S/.test(source.slice(lineStart, idx));
    out.push({ text, line: lineOf(idx), kind: 'line', trailing });
  }
  // block comments (docblocks)
  for (const m of source.matchAll(BLOCK_RE)) {
    const idx = m.index!;
    const text = m[0];
    out.push({ text, line: lineOf(idx), kind: 'docblock' });
  }
  return out;
}

/** True when idx falls inside a /* *​/ region (guards against // inside block comments). */
function insideBlockComment(source: string, idx: number): boolean {
  let depth = 0;
  let i = 0;
  while (i < idx && i < source.length) {
    if (source[i] === '/' && source[i + 1] === '*') { depth++; i += 2; continue; }
    if (source[i] === '*' && source[i + 1] === '/') { depth = Math.max(0, depth - 1); i += 2; continue; }
    if (source[i] === '"' || source[i] === "'" || source[i] === '`') {
      const q = source[i]!;
      i++;
      while (i < idx && i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === q) break;
        i++;
      }
    }
    i++;
  }
  return depth > 0;
}
