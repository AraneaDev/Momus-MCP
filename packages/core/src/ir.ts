/**
 * Language-neutral intermediate representation (spec docs/02 §2.3).
 * All spans are 1-based lines / 1-based columns; endCol exclusive.
 */

import type { Language } from './languages.ts';

/**
 * IR cache schema version. Folded into the workspace cache digest so that a parser/IR change
 * invalidates cached modules even when the audited workspace is unchanged. Bump whenever the
 * ModuleIR shape or any parser's extraction changes in a way that would make cached IR stale.
 */
export const IR_SCHEMA_VERSION = '23'; // 23: TS `new` production calls, config-arg hand-off, dynamic-import + local-helper provenance

export type { Language };
export type Severity = 'error' | 'warning' | 'info';

export type RuleId =
  | 'TAUT-001'
  | 'TAUT-002'
  | 'TAUT-003'
  | 'TAUT-004'
  | 'TAUT-005'
  | 'TAUT-006'
  | 'DRIFT-000'
  | 'DRIFT-001'
  | 'DRIFT-002'
  | 'DRIFT-003'
  | 'DRIFT-004'
  | 'DRIFT-005'
  | 'DRIFT-006'
  | 'MOCK-001'
  | 'MOCK-002'
  | 'SYS-001'
  | 'SYS-002'
  | 'SYS-003'
  | 'SYS-004'
  | 'SYS-005';

export interface SourceSpan {
  file: string; // absolute path
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export const span = (file: string, sl: number, sc: number, el: number, ec: number): SourceSpan => ({
  file,
  startLine: sl,
  startCol: sc,
  endLine: el,
  endCol: ec,
});

export interface ParseDiagnostic {
  severity: 'error' | 'warning' | 'info';
  span: SourceSpan;
  message: string;
}

// ---------------------------------------------------------------- module

export type MockFramework =
  | 'vitest'
  | 'jest'
  | 'phpunit'
  | 'pest'
  | 'unittest'
  | 'pytest'
  | 'mockall'
  | 'mockito'
  | 'wiremock'
  | 'httpmock'
  | 'mry'
  | 'faux'
  | 'mockers'
  | 'mockiato'
  | 'mocktopus'
  | 'mock_derive'
  | 'galvanic'
  | 'double'
  | 'manual';

export interface ModuleIR {
  path: string;
  language: Language;
  kind: 'test' | 'production';
  framework?: MockFramework;
  imports: ImportIR[];
  symbols: SymbolIR[];
  exports: string[]; // exported names of this module
  mocks: MockIR[];
  assertions: AssertionIR[];
  functions: TestFnIR[]; // test functions/blocks (TAUT-004 / MOCK-001 stats)
  comments: RawComment[]; // for suppression handling
  diagnostics: ParseDiagnostic[];
  hash: string; // sha256 of file bytes
}

export interface RawComment {
  text: string;
  line: number; // 1-based line the comment starts on
  kind: 'line' | 'docblock';
  /** Line comments only: true when code precedes the comment on the same line. */
  trailing?: boolean;
}

export interface ImportIR {
  specifier: string;
  resolvedPath?: string;
  names: string[]; // local names imported
}

export interface TestFnIR {
  id: string; // `${path}#fn:${startLine}`
  span: SourceSpan;
  hasProductionCalls: boolean;
  productionCallCount: number;
  assertionCount: number;
  /** Rust: the fn carries `#[should_panic]` — the drop-time panic is the assertion (TAUT-005). */
  shouldPanic?: boolean;
}

// ---------------------------------------------------------------- symbols

export type SymbolKind = 'class' | 'interface' | 'function' | 'method' | 'property' | 'type-alias' | 'enum' | 'const';

export interface SymbolIR {
  id: string; // `${modulePath}#${name}` (methods: `${parentId}.${name}`)
  name: string;
  kind: SymbolKind;
  span: SourceSpan;
  members: SymbolIR[]; // for class/interface
  extendsIds: string[]; // resolved symbol ids
  implementsIds: string[];
  signature?: SignatureIR; // functions and methods
  visibility?: 'public' | 'protected' | 'private';
  isStatic?: boolean;
  isAbstract?: boolean;
}

export interface SignatureIR {
  parameters: ParamIR[];
  returnType?: TypeIR;
  typeParams: string[];
  /** Exception class names documented via `@throws` (PHP docblocks). */
  throws?: string[];
}

export interface ParamIR {
  name: string;
  type?: TypeIR;
  optional: boolean;
  variadic: boolean;
  hasDefault: boolean;
}

export type TypeIR =
  | { kind: 'named'; name: string; resolvedId?: string; typeArgs: TypeIR[] }
  | { kind: 'union'; members: TypeIR[] }
  | { kind: 'intersection'; members: TypeIR[] }
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'array'; element?: TypeIR }
  | { kind: 'tuple'; elements: TypeIR[] }
  | { kind: 'function'; params: ParamIR[]; returnType?: TypeIR }
  | { kind: 'unknown' } // any / mixed / untyped
  | { kind: 'void' | 'never' | 'null' | 'undefined' };

// ---------------------------------------------------------------- mocks

export type MockPattern =
  | 'vi.mock'
  | 'jest.mock'
  | 'jest.doMock'
  | 'vi.spyOn'
  | 'jest.spyOn'
  | 'vi.fn'
  | 'jest.fn'
  | 'vi.mocked-instance'
  | 'vi.importMock'
  | 'jest.requireMock'
  | 'jest.createMockFromModule'
  | 'jest.genMockFromModule'
  | 'vi.stubGlobal'
  | 'createMock'
  | 'createStub'
  | 'createConfiguredMock'
  | 'createPartialMock'
  | 'getMockBuilder'
  | 'getMockForAbstractClass'
  | 'mockery'
  | 'mockery-spy'
  | 'pest-mock'
  | 'anonymous-class'
  | 'object-literal'
  | 'proxy'
  | 'patch'
  | 'patch-object'
  | 'patch-multiple'
  | 'patch-dict'
  | 'autospec'
  | 'pytest-mock'
  | 'monkeypatch'
  | 'automock'
  | 'mock-macro'
  | 'mockito'
  | 'wiremock'
  | 'httpmock'
  | 'mry'
  | 'faux'
  | 'mockers'
  | 'mockiato'
  | 'mocktopus'
  | 'mock_derive'
  | 'galvanic'
  | 'double'
  | 'unknown';

export interface MockIR {
  id: string; // `${file}#mock:${startLine}:${startCol}`
  span: SourceSpan;
  framework: MockFramework;
  pattern: MockPattern;
  target?: MockTarget;
  stubbedMembers: StubbedMemberIR[];
  configuredValues: ConfiguredValueIR[];
  invocationSites: SourceSpan[];
  isAutomock: boolean;
  /** Enclosing test fn id (TestFnIR.id) when the mock is created inside one. */
  fnId?: string;
  /** PHP constructor arguments supplied when original construction is explicitly enabled. */
  constructorArgs?: { count: number; span: SourceSpan };
}

export interface MockTarget {
  kind: 'module' | 'class' | 'instance-member' | 'global' | 'unknown';
  modulePath?: string;
  exportName?: string;
  symbolId?: string; // resolved production class/interface id
  memberName?: string;
  specifier?: string;
  span: SourceSpan;
}

export interface StubbedMemberIR {
  name: string;
  span: SourceSpan;
  signature?: SignatureIR; // arity/types as declared on the stub
  returnValues: ConfiguredValueIR[];
  api: 'spyOn' | 'shouldReceive' | 'mockFactoryKey' | 'objectLiteralKey' | 'instance-member' | 'unknown';
}

export interface ConfiguredValueIR {
  span: SourceSpan;
  api: string; // mockReturnValue | mockResolvedValue | willReturn | literal | ...
  value?: TypeIR;
  once: boolean;
  /** Parser-enriched: is the configured value assignable to the production return type?
   *  'unknown' = no type info (skip check). */
  assignable: boolean | 'unknown';
}

// ---------------------------------------------------------------- assertions

export type SourceKind = 'mock-config' | 'mock-call' | 'production' | 'literal' | 'parameter' | 'unknown';

export interface AssertionIR {
  id: string;
  span: SourceSpan;
  api: string; // toBe | toEqual | assertSame | toHaveBeenCalled ...
  operands: ExprIR[];
  fnId: string; // enclosing TestFnIR.id
}

export interface ExprIR {
  kind: 'identifier' | 'call' | 'member' | 'new' | 'literal' | 'template' | 'unknown';
  text: string; // source text
  mockRefs: string[]; // mock ids this expression provably flows from
  provenance: SourceKind; // dominant provenance of this operand
  /** When provenance is 'mock-config': the configured value's source text. */
  configuredValue?: string;
  constant: boolean;
}

// ---------------------------------------------------------------- issues

export interface FixSuggestion {
  kind: 'replace' | 'insert' | 'delete';
  span?: SourceSpan;
  code: string;
  description: string; // ≤ 60 chars
}

export interface Issue {
  id: string; // stable dedupe id
  rule: RuleId;
  severity: Severity;
  span: SourceSpan;
  message: string; // ≤ 80 chars
  evidence?: string; // ≤ 60 chars
  fix?: FixSuggestion;
  tokens: number; // estimated tokens of the rendered line
}

export interface Summary {
  filesAudited: number;
  issues: number; // shown (post-truncation)
  errors: number;
  warnings: number;
  infos: number;
  /** Pre-truncation totals (exit codes and CI gates must use these). */
  totalIssues: number;
  totalErrors: number;
  totalWarnings: number;
  totalInfos: number;
  suppressed: number;
  durationMs: number;
  truncated: boolean;
}

export interface AuditResult {
  summary: Summary;
  issues: Issue[];
  suppressed: Issue[];
  diagnostics: ParseDiagnostic[];
  indexStats: { modules: number; symbols: number; mocks: number };
}

/**
 * Narrow a result to a subset of its issues (e.g. DRIFT-only or TAUT-only views) and recompute
 * the summary counts so the header, CLEAN line, and truncation footer describe the filtered set.
 * Keeps diagnostics/indexStats/suppressed as-is.
 */
export function filterResult(result: AuditResult, keep: (issue: Issue) => boolean): AuditResult {
  const issues = result.issues.filter(keep);
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  const infos = issues.filter((i) => i.severity === 'info').length;
  return {
    ...result,
    issues,
    summary: {
      ...result.summary,
      issues: issues.length,
      errors,
      warnings,
      infos,
      totalIssues: issues.length,
      totalErrors: errors,
      totalWarnings: warnings,
      totalInfos: infos,
      truncated: false,
    },
  };
}
