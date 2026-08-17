/** PEP 484/526/585/604 annotation text -> language-neutral TypeIR (the PHP-docblock precedent). */
import type { TypeIR } from '@momus/core';

/** Split on a separator at top level (outside `[]`). */
function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '[') depth++;
    else if (ch === ']') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/** Strip a surrounding pair of matching quotes (forward refs are written `"Item"`). */
function stripQuotes(text: string): string {
  const t = text.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

export function parseAnnotation(text: string): TypeIR | undefined {
  const trimmed = stripQuotes(text);
  if (!trimmed) return undefined;
  const union = splitTopLevel(trimmed, '|')
    .map((p) => p.trim())
    .filter(Boolean);
  if (union.length > 1) return unionType(union.map(parseAnnotation));
  return parseAtom(trimmed);
}

function unionType(parts: Array<TypeIR | undefined>): TypeIR | undefined {
  const members: TypeIR[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (part.kind === 'union') members.push(...part.members);
    else members.push(part);
  }
  if (members.length === 0) return undefined;
  if (members.length === 1) return members[0];
  return { kind: 'union', members };
}

function parseAtom(text: string): TypeIR {
  const t = stripQuotes(text);
  if (t === '...' || t === 'Any' || t === 'any') return { kind: 'unknown' };
  if (t === 'None' || t === 'NoneType') return { kind: 'null' };
  const open = t.indexOf('[');
  if (open > 0 && t.endsWith(']')) {
    const name = t.slice(0, open).trim();
    const argsText = t.slice(open + 1, -1).trim();
    const args = splitTopLevel(argsText, ',')
      .map((a) => parseAnnotation(a.trim()))
      .filter((x): x is TypeIR => !!x);
    const lower = name.toLowerCase();
    if (lower === 'optional') return { kind: 'union', members: [args[0] ?? { kind: 'unknown' }, { kind: 'null' }] };
    if (lower === 'union') return unionType(args) ?? { kind: 'unknown' };
    if (lower === 'callable') return { kind: 'unknown' }; // conservative: Callable has no param names
    if (lower === 'literal') return literalType(argsText) ?? { kind: 'unknown' };
    return { kind: 'named', name, typeArgs: args };
  }
  return { kind: 'named', name: t, typeArgs: [] };
}

function literalType(argsText: string): TypeIR | undefined {
  const first = splitTopLevel(argsText, ',').map((p) => p.trim())[0];
  if (first === undefined) return undefined;
  if (/^['"].*['"]$/.test(first)) return { kind: 'literal', value: first.slice(1, -1) };
  if (first === 'True') return { kind: 'literal', value: true };
  if (first === 'False') return { kind: 'literal', value: false };
  if (first === 'None') return { kind: 'null' };
  const num = Number(first);
  if (!Number.isNaN(num)) return { kind: 'literal', value: num };
  return undefined;
}
