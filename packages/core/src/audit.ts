/** Audit pipeline (spec docs/02 §2.1): discover → parse → index → rules → format. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';
import { anyMatch } from './glob.ts';
import type { AuditResult, ModuleIR, Issue, ParseDiagnostic } from './ir.ts';
import type { LanguageParser } from './parser.ts';
import type { MomusConfig } from './config.ts';
import { DEFAULT_CONFIG } from './config.ts';
import { discoverFiles } from './discovery.ts';
import { SymbolIndex } from './symbolIndex.ts';
import { runRules, sortIssues } from './rules/engine.ts';
import { tautologyRules } from './rules/tautology.ts';
import { driftRules } from './rules/drift.ts';
import { hygieneRules } from './rules/hygiene.ts';
import { buildSuppressionState, isSuppressed } from './suppress.ts';
import { issueTokens } from './tokens.ts';

const ALL_RULES = [...tautologyRules, ...driftRules, ...hygieneRules];

export interface AuditOptions {
  root: string;
  parser: LanguageParser;
  config?: MomusConfig;
  /** Restrict audit to these files/globs (workspace-relative). */
  paths?: string[];
  maxIssues?: number;
  includeSuppressed?: boolean;
  includeUnresolved?: boolean;
}

export class AuditEngine {
  private readonly config: MomusConfig;
  private readonly opts: AuditOptions;

  constructor(opts: AuditOptions) {
    this.opts = opts;
    this.config = opts.config ?? DEFAULT_CONFIG;
  }

  run(): AuditResult {
    const t0 = Date.now();
    const root = resolve(this.opts.root);
    const parser = this.opts.parser;
    const limit = this.opts.maxIssues ?? this.config.tokenBudget.maxIssuesPerReport;

    const { files, skipped } = discoverFiles({
      root,
      testPatterns: this.config.testFilePatterns,
      ignorePatterns: this.config.ignorePatterns,
      maxFileSizeBytes: this.config.maxFileSizeBytes,
      maxIndexedLines: this.config.maxIndexedLines,
    });

    const production: ModuleIR[] = [];
    const testModules: ModuleIR[] = [];
    const diagnostics: ParseDiagnostic[] = skipped.map((s) => ({
      severity: 'info',
      span: { file: s.path, startLine: 0, startCol: 0, endLine: 0, endCol: 0 },
      message: s.reason,
    }));
    const pathFilter = this.pathFilter();

    for (const f of files) {
      // Production files are ALWAYS indexed (rules need the workspace symbol graph);
      // the path filter restricts which TEST files get audited.
      const source = readFileSync(f.path, 'utf8');
      const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
      if (!parser.canParse(f.path, source)) continue;
      let module: ModuleIR;
      try {
        module = parser.parseModule(f.path, source, { config: this.config, resolveImport: (spec) => parser.resolveImport(spec, f.path) });
      } catch (e) {
        diagnostics.push({
          severity: 'error',
          span: { file: f.path, startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
          message: `SYS-001: parse error: ${(e as Error).message}`.slice(0, 120),
        });
        continue;
      }
      module.hash = hash;
      if (module.kind === 'test') testModules.push(module);
      else production.push(module);
    }

    const index = new SymbolIndex(production);
    const issues: Issue[] = [];
    const suppressed: Issue[] = [];
    const selected = pathFilter
      ? testModules.filter((m) => pathFilter(relative(root, m.path).replace(/\\/g, '/')))
      : testModules;

    for (const m of selected) {
      const state = buildSuppressionState(m.comments, m.path, m.functions);
      const ctx = { index, module: m, config: this.config };
      const found = runRules(ALL_RULES, ctx);
      for (const issue of found) {
        issue.tokens = issueTokens(issue, root);
        if (issue.rule === 'DRIFT-000' && !this.opts.includeUnresolved) continue;
        if (isSuppressed(issue, state)) {
          suppressed.push(issue);
          continue;
        }
        issues.push(issue);
      }
    }

    const sorted = sortIssues(issues);
    const truncated = sorted.length > limit;
    const shown = truncated ? sorted.slice(0, limit) : sorted;
    const count = (list: Issue[], sev: Issue['severity']) => list.filter((i) => i.severity === sev).length;
    const summary = {
      filesAudited: selected.length + production.length,
      issues: shown.length,
      errors: count(shown, 'error'),
      warnings: count(shown, 'warning'),
      infos: count(shown, 'info'),
      totalIssues: sorted.length,
      totalErrors: count(sorted, 'error'),
      totalWarnings: count(sorted, 'warning'),
      totalInfos: count(sorted, 'info'),
      suppressed: suppressed.length,
      durationMs: Date.now() - t0,
      truncated,
    };
    return {
      summary,
      issues: shown,
      suppressed: this.opts.includeSuppressed ? suppressed : [],
      diagnostics,
      indexStats: index.stats(),
    };
  }

  private pathFilter(): ((rel: string) => boolean) | undefined {
    const paths = this.opts.paths;
    if (!paths || paths.length === 0) return undefined;
    return (rel) => anyMatch(paths, rel) || paths.some((p) => p === rel);
  }
}
