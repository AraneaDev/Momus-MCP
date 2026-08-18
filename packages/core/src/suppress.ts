/** Suppression semantics (spec docs/03 §3.5). Pure logic over comment texts. */
import type { Issue, RawComment, RuleId, TestFnIR } from './ir.ts';

export type { RawComment };

const LINE_RE = /^\/\/\s*@momus-ignore(?::(?<rules>[A-Z0-9-]+(?:,[A-Z0-9-]+)*))?$/;
const DOCBLOCK_RE = /^\/\*\*\s*@momus-ignore\s*\*\/$/;
const FILE_BANNER_RE = /^\/\/\s*@momus-ignore-file(?::(?<rules>[A-Z0-9-]+(?:,[A-Z0-9-]+)*))?$/;
/** Spec §3.5: the file banner only counts in the first 10 lines. */
const FILE_BANNER_MAX_LINE = 10;
/** A docblock above a test fn may be separated by up to this many blank lines. */
const DOCBLOCK_FN_GAP = 4;

export interface ParsedSuppression {
  /** undefined = suppress all rules; otherwise the listed rule ids. */
  rules?: RuleId[];
  file?: boolean;
  docblock?: boolean;
}

export function parseSuppression(c: RawComment): ParsedSuppression | null {
  const text = c.text.trim();
  if (c.kind === 'docblock') return DOCBLOCK_RE.test(text) ? { rules: undefined, docblock: true } : null;
  const banner = text.match(FILE_BANNER_RE);
  if (banner) return { file: true, rules: banner.groups?.rules?.split(',') as RuleId[] | undefined };
  const m = text.match(LINE_RE);
  if (!m) return null;
  const rules = m.groups?.rules?.split(',') as RuleId[] | undefined;
  return { rules };
}

export interface SuppressionState {
  fileIgnored: boolean;
  /**
   * Rule ids the file banner suppresses; undefined = every rule (the bare banner).
   * Only meaningful when `fileIgnored` is true.
   */
  fileRules?: RuleId[];
  /** target line -> rule ids; null = all rules. Absent = no suppression. */
  perLine: Map<number, RuleId[] | null>;
}

/**
 * Build the lookup state from raw comments (spec §3.5.1):
 *  - `// @momus-ignore` (standalone): suppresses the NEXT line
 *  - `// @momus-ignore` (trailing a statement): suppresses its own line
 *  - `/** @momus-ignore *​/` docblock: suppresses the enclosing test function
 *    (when one starts within DOCBLOCK_FN_GAP lines), else its own line
 *  - `// @momus-ignore-file[:RULE,RULE]`: whole file, only honored in the first 10 lines.
 *    The rule-scoped form is the only way to suppress a finding reported at file scope
 *    (MOCK-001 spans 1:1, so no comment can precede it).
 */
export function buildSuppressionState(comments: RawComment[], _file: string, fns?: TestFnIR[]): SuppressionState {
  const state: SuppressionState = { fileIgnored: false, perLine: new Map() };
  const add = (line: number, rules: RuleId[] | undefined) => {
    // later comments win; null = all rules
    state.perLine.set(line, rules ?? null);
  };
  for (const c of comments) {
    const p = parseSuppression(c);
    if (!p) continue;
    if (p.file) {
      if (c.line <= FILE_BANNER_MAX_LINE) {
        // A bare banner outranks a rule-scoped one: it already covers every rule.
        if (!state.fileIgnored || p.rules === undefined) state.fileRules = p.rules;
        else if (state.fileRules) state.fileRules = [...state.fileRules, ...p.rules];
        state.fileIgnored = true;
      }
      continue;
    }
    if (p.docblock) {
      const fn = fns?.find((f) => f.span.startLine >= c.line + 1 && f.span.startLine <= c.line + DOCBLOCK_FN_GAP);
      if (fn) {
        for (let l = c.line; l <= fn.span.endLine; l++) add(l, p.rules);
      } else {
        add(c.line, p.rules);
      }
      continue;
    }
    // line comment: trailing form suppresses its own line, standalone the next
    add(c.trailing ? c.line : c.line + 1, p.rules);
  }
  return state;
}

/** Does this issue fall under a suppression? */
export function isSuppressed(issue: Issue, state: SuppressionState): boolean {
  if (state.fileIgnored && (state.fileRules === undefined || state.fileRules.includes(issue.rule as RuleId))) {
    return true;
  }
  const entry = state.perLine.get(issue.span.startLine);
  if (entry === undefined) return false;
  if (entry === null) return true; // all rules
  return entry.includes(issue.rule as RuleId);
}
