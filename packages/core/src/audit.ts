/** Audit pipeline (spec docs/02 §2.1): discover → parse → index → rules → format. */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getHeapStatistics } from 'node:v8';
import { relative, resolve, join } from 'node:path';
import { anyMatch } from './glob.ts';
import { IR_SCHEMA_VERSION, type AuditResult, type ModuleIR, type Issue, type ParseDiagnostic } from './ir.ts';
import type { LanguageParser, ParseCache } from './parser.ts';
import type { MomusConfig } from './config.ts';
import { DEFAULT_CONFIG } from './config.ts';
import { discoverFiles } from './discovery.ts';
import { SymbolIndex } from './symbolIndex.ts';
import { runRules, sortIssues, type DiffScope } from './rules/engine.ts';
import type { SymbolIR } from './ir.ts';
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
  /** git-diff mode: restrict drift checks to mocks whose targets changed vs baseRef. */
  diff?: { baseRef: string; changedPaths: string[] };
  /** Advisory persistent parse cache (keyed by file hash + workspace digest). */
  cache?: ParseCache;
  /** Per-file parse budget in ms (§2.7); parses over it emit a SYS-004 info diagnostic. */
  parseBudgetMs?: number;
  /**
   * Heap guard (issue #56). Before each uncached parse the used heap is compared with the V8
   * heap limit: above `release` the parser drops its memoized programs; above `stop` parsing
   * ends and the audit returns a partial result with a SYS-006 error instead of letting the
   * process die. Ratios of the heap limit; `heapUsage` is injectable for tests.
   */
  heapGuard?: { release?: number; stop?: number; heapUsage?: () => number };
}

/** Fraction of the V8 heap limit currently in use. */
function defaultHeapUsage(): number {
  const h = getHeapStatistics();
  return h.used_heap_size / h.heap_size_limit;
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
    // Requested test files that were not audited: they must not read as a clean result.
    const requested = (rel: string): boolean =>
      anyMatch(this.config.testFilePatterns, rel) && (!pathFilter || pathFilter(rel));
    const relOf = (abs: string): string => relative(root, abs).replace(/\\/g, '/');
    const failedTests: Issue[] = [];
    let missedTests = 0; // requested test files never parsed because the heap guard stopped the audit

    // Pass 1: read + content-hash every claimable file so the workspace digest (which the
    // cache key depends on) can be computed before any parse is served from cache.
    const hashOf = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);
    const candidates: Array<{ f: (typeof files)[number]; source: string; hash: string }> = [];
    const digestParts: string[] = [];
    for (const f of files) {
      const source = readFileSync(f.path, 'utf8');
      const hash = hashOf(source);
      if (!parser.canParse(f.path, source)) continue;
      candidates.push({ f, source, hash });
      digestParts.push(`${relative(root, f.path).replace(/\\/g, '/')}\u0000${hash}`);
    }
    // Type-aware TS parsing depends on tsconfig; PHP resolution on composer.json — fold them in.
    for (const cfgName of ['tsconfig.json', 'composer.json']) {
      const cfgPath = join(root, cfgName);
      if (existsSync(cfgPath)) digestParts.push(`${cfgName}\u0000${hashOf(readFileSync(cfgPath, 'utf8'))}`);
    }
    // Fold the IR schema version in so a tool upgrade invalidates the cache even when the
    // workspace files are unchanged (parser/rule logic changes must not serve stale IR).
    digestParts.push(`@momus/ir-schema\u0000${IR_SCHEMA_VERSION}`);
    const workspaceHash = hashOf(digestParts.sort().join('\n'));
    const cache = this.opts.cache;

    const heapUsage = this.opts.heapGuard?.heapUsage ?? defaultHeapUsage;
    const releaseAt = this.opts.heapGuard?.release ?? 0.75;
    const stopAt = this.opts.heapGuard?.stop ?? 0.92;
    let released = false;
    let unparsed: string[] = [];
    for (let ci = 0; ci < candidates.length; ci++) {
      const { f, source, hash } = candidates[ci]!;
      // Production files are ALWAYS indexed (rules need the workspace symbol graph);
      // the path filter restricts which TEST files get audited.
      let module = cache?.get(f.path, hash, workspaceHash);
      if (!module) {
        const usage = heapUsage();
        if (usage > releaseAt && !released) {
          parser.releaseMemory?.();
          released = true;
        }
        if (usage > stopAt) {
          unparsed = candidates.slice(ci).map((c) => c.f.path);
          diagnostics.push({
            severity: 'error',
            span: { file: f.path, startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
            message: `SYS-006: heap at ${Math.round(usage * 100)}% of limit; audit stopped, ${unparsed.length} files not parsed`,
          });
          break;
        }
        const parseT0 = Date.now();
        try {
          module = parser.parseModule(f.path, source, {
            config: this.config,
            resolveImport: (spec) => parser.resolveImport(spec, f.path),
          });
        } catch (e) {
          const failSpan = { file: f.path, startLine: 1, startCol: 1, endLine: 1, endCol: 1 };
          diagnostics.push({
            severity: 'error',
            span: failSpan,
            message: `SYS-001: parse error: ${(e as Error).message}`.slice(0, 120),
          });
          // A requested test file that could not be audited becomes an error-severity issue,
          // so the summary and exit code reflect it (issue #58).
          if (requested(relOf(f.path))) {
            failedTests.push({
              id: `SYS-001:${f.path}`,
              rule: 'SYS-001',
              severity: 'error',
              span: failSpan,
              message: `parse-error: file not audited (${(e as Error).message})`.slice(0, 80),
              tokens: 0,
            });
          }
          continue;
        }
        const parseMs = Date.now() - parseT0;
        // Perf budget §2.7: a single-file parse over the budget degrades to an info
        // diagnostic (SYS-004), never a crash. The normative budget is 50ms; the
        // 2s ceiling keeps CI free of flaky timing while still surfacing pathological
        // parses (huge/typed workspaces) as diagnostics.
        if (parseMs > (this.opts.parseBudgetMs ?? 2000)) {
          diagnostics.push({
            severity: 'info',
            span: { file: f.path, startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
            message: `SYS-004: single-file parse took ${parseMs}ms (budget 2000ms)`,
          });
        }
        module.hash = hash;
        cache?.put(f.path, hash, workspaceHash, module);
      }
      if (!this.config.languages[module.language]) continue;
      if (module.kind === 'test') testModules.push(module);
      else production.push(module);
    }

    const index = new SymbolIndex(production, testModules);
    const diff = this.buildDiffScope(root, production);
    // Syntax-only parser passes preserve a syntactic target name instead of relying on
    // checker identity. Resolve that name against the production index before rules run.
    for (const module of testModules) {
      for (const mock of module.mocks) {
        const target = mock.target;
        if (
          !target ||
          target.symbolId ||
          !target.exportName ||
          (target.kind !== 'class' && target.kind !== 'instance-member' && target.kind !== 'global')
        )
          continue;
        // Same-file symbols win (a test defining its own `trait Foo` mocks that Foo, not an
        // unrelated production Foo with the same name — mockall's tests do exactly this);
        // otherwise resolve against the production index.
        let symbol = module.symbols.find((s) => s.name === target.exportName);
        if (!symbol) symbol = index.resolveByName(target.exportName, module.path);
        if (symbol) target.symbolId = symbol.id;
      }
    }
    const issues: Issue[] = [];
    const suppressed: Issue[] = [];
    const selected = pathFilter
      ? testModules.filter((m) => pathFilter(relative(root, m.path).replace(/\\/g, '/')))
      : testModules;

    for (const m of selected) {
      const state = buildSuppressionState(m.comments, m.path, m.functions);
      const ctx = { index, module: m, config: this.config, ...(diff ? { diff } : {}) };
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

    if (unparsed.length > 0) {
      // A partial index cannot vouch for anything: report the stop as an error issue anchored on
      // the first requested test file that was not reached (or the first unparsed file).
      const firstTest = unparsed.findIndex((p) => requested(relOf(p)));
      const anchor = unparsed[firstTest >= 0 ? firstTest : 0]!;
      missedTests = unparsed.filter((p) => requested(relOf(p))).length;
      failedTests.push({
        id: `SYS-006:${anchor}`,
        rule: 'SYS-006',
        severity: 'error',
        span: { file: anchor, startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
        message: `out-of-memory: audit stopped early, ${unparsed.length} files not parsed`.slice(0, 80),
        tokens: 0,
      });
    }
    for (const failed of failedTests) {
      failed.tokens = issueTokens(failed, root);
      issues.push(failed);
    }
    const filesFailed = failedTests.filter((i) => i.rule === 'SYS-001').length + missedTests;
    const sorted = sortIssues(issues);
    const truncated = sorted.length > limit;
    const shown = truncated ? sorted.slice(0, limit) : sorted;
    const count = (list: Issue[], sev: Issue['severity']) => list.filter((i) => i.severity === sev).length;
    const summary = {
      filesAudited: selected.length + production.length,
      ...(filesFailed > 0 ? { filesFailed } : {}),
      issues: shown.length,
      errors: count(shown, 'error'),
      warnings: count(shown, 'warning'),
      infos: count(shown, 'info'),
      totalIssues: sorted.length,
      totalErrors: count(sorted, 'error'),
      totalWarnings: count(sorted, 'warning'),
      totalInfos: count(sorted, 'info'),
      suppressed: suppressed.length,
      // Guard against a backward clock jump (VM/NTP skew) ever producing a negative duration.
      durationMs: Math.max(0, Date.now() - t0),
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

  private buildDiffScope(root: string, production: ModuleIR[]): DiffScope | undefined {
    const input = this.opts.diff;
    if (!input) return undefined;
    const changed = new Set(input.changedPaths.map((p) => resolve(root, p)));
    const changedSymbolIds = new Set<string>();
    const collect = (s: SymbolIR): void => {
      changedSymbolIds.add(s.id);
      for (const member of s.members) collect(member);
    };
    for (const prod of production) {
      if (!changed.has(prod.path)) continue;
      for (const s of prod.symbols) collect(s);
    }
    return { baseRef: input.baseRef, changedPaths: [...changed], changedSymbolIds };
  }

  private pathFilter(): ((rel: string) => boolean) | undefined {
    const paths = this.opts.paths;
    if (!paths || paths.length === 0) return undefined;
    return (rel) => anyMatch(paths, rel) || paths.some((p) => p === rel);
  }
}
