// E8 — suppression comment extraction (TS) + regex contract from docs/03 §3.5.1.
import * as ts from 'typescript';

const IGNORE_RE = /^\/\/\s*@momus-ignore(?::(?<rules>[A-Z0-9-]+(?:,[A-Z0-9-]+)*))?$/;
const DOCBLOCK_RE = /^\/\*\*\s*@momus-ignore\s*\*\/$/;
const FILE_BANNER_RE = /^\/\/\s*@momus-ignore-file$/;

const sources: Array<[string, string]> = [
  ['line-above', `// @momus-ignore\nmock.getTotal.mockReturnValue(42);`],
  ['trailing', `expect(mock.f()).toBe(42); // @momus-ignore:TAUT-002`],
  ['multi-rule', `// @momus-ignore:TAUT-002,DRIFT-003\nmock.x.mockReturnValue(1);`],
  ['docblock', `/** @momus-ignore */\ntest('x', () => {});`],
  ['file-banner', `// @momus-ignore-file\nimport { x } from './x';\ntest('y', () => {});`],
  ['no-match', `// @momus-ignoree\nexpect(a).toBe(b);`],
  ['no-match2', `// @momus-ignore: TAUT-002 (space after colon — must not match)\nexpect(a).toBe(b);`],
];

let pass = true;
const check = (ok: boolean, label: string, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  pass &&= ok;
};

for (const [name, source] of sources) {
  const sf = ts.createSourceFile(`t-${name}.ts`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const stmt = sf.statements[0];
  const comments: Array<{ text: string; kind: 'line' | 'docblock' }> = [];
  const grab = (ranges: readonly ts.CommentRange[] | undefined, kind: 'line' | 'docblock') => {
    for (const r of ranges ?? []) {
      const text = source.slice(r.pos, r.end);
      comments.push({ text, kind });
    }
  };
  grab(ts.getLeadingCommentRanges(source, stmt.getFullStart()), 'line');
  grab(ts.getTrailingCommentRanges(source, stmt.end), 'line');
  // docblocks attach via the statement's jsDoc when present
  const jsDoc = (stmt as any).jsDoc as ts.JSDoc[] | undefined;
  if (jsDoc) for (const d of jsDoc) comments.push({ text: source.slice(d.pos, d.end), kind: 'docblock' });

  const matches = comments.filter((c) =>
    c.kind === 'docblock' ? DOCBLOCK_RE.test(c.text.trim()) : IGNORE_RE.test(c.text.trim()));
  const fileBanner = source.startsWith('// @momus-ignore-file') && FILE_BANNER_RE.test(source.split('\n')[0].trim());

  switch (name) {
    case 'line-above':
      check(matches.length === 1 && IGNORE_RE.test(matches[0].text), name, JSON.stringify(matches.map((m) => m.text)));
      break;
    case 'trailing':
      check(matches.length === 1 && matches[0].text.includes('TAUT-002'), name, JSON.stringify(matches.map((m) => m.text)));
      break;
    case 'multi-rule': {
      const m = matches[0]?.text.match(IGNORE_RE);
      check(matches.length === 1 && m?.groups?.rules === 'TAUT-002,DRIFT-003', name, m?.groups?.rules ?? 'no match');
      break;
    }
    case 'docblock':
      check(matches.length === 1, name, JSON.stringify(matches.map((m) => m.text)));
      break;
    case 'file-banner':
      check(fileBanner, name);
      break;
    case 'no-match':
    case 'no-match2':
      check(matches.length === 0, name, `${matches.length} matched`);
      break;
  }
}

// PHP side was validated in E6 (docblock extraction + inline comment shapes).
console.log(pass ? 'E8 PASS: suppression syntax extraction works for TS (PHP in E6)' : 'E8 FAIL');
process.exit(pass ? 0 : 1);
