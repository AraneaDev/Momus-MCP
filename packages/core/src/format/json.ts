/** JSON envelope (spec docs/05 §5.4) — the structuredContent shape. */
import type { AuditResult } from '../ir.ts';
import { toRel } from '../tokens.ts';

export interface JsonEnvelopeOptions {
  tool: string;
  workspaceRoot: string;
  diffBase?: string;
  changedFiles?: number;
  staleMockCandidates?: number;
}

export function buildJsonEnvelope(result: AuditResult, opts: JsonEnvelopeOptions): Record<string, unknown> {
  const root = opts.workspaceRoot;
  const issue = (i: (typeof result.issues)[number]) => ({
    rule: i.rule,
    severity: i.severity,
    file: toRel(i.span.file, root),
    line: i.span.startLine,
    column: i.span.startCol,
    endLine: i.span.endLine,
    endColumn: i.span.endCol,
    message: i.message,
    ...(i.evidence ? { evidence: i.evidence } : {}),
    ...(i.fix
      ? {
          fix: {
            kind: i.fix.kind,
            ...(i.fix.span ? { span: i.fix.span } : {}),
            ...(i.fix.code ? { code: i.fix.code } : {}),
            description: i.fix.description,
          },
        }
      : {}),
    tokens: i.tokens,
  });
  return {
    schemaVersion: 1,
    tool: opts.tool,
    result: {
      summary: {
        ...result.summary,
        ...(opts.diffBase ? { diffBase: opts.diffBase } : {}),
        ...(opts.changedFiles !== undefined ? { changedFiles: opts.changedFiles } : {}),
        ...(opts.staleMockCandidates !== undefined ? { staleMockCandidates: opts.staleMockCandidates } : {}),
      },
      indexStats: result.indexStats,
      issues: result.issues.map(issue),
      ...(result.suppressed.length ? { suppressed: result.suppressed.map(issue) } : {}),
      ...(result.diagnostics.length
        ? {
            diagnostics: result.diagnostics.map((d) => ({
              code: 'SYS',
              severity: d.severity,
              file: toRel(d.span.file, root),
              message: d.message.slice(0, 120),
            })),
          }
        : {}),
    },
  };
}
