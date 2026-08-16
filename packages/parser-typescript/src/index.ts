/** TypeScript/JavaScript parser plugin for Momus. */
import * as ts from 'typescript';
import type { ImportIR, LanguageParser, MockFramework, ModuleIR, ParseContext, ParseDiagnostic } from '@momus/core';
import { span } from '@momus/core';
import { getProgram, resolveImport as resolveImportTs } from './program.ts';

export { invalidateProgramCache } from './program.ts';
import { extractSymbols } from './symbols.ts';
import { detectMocks } from './mocks.ts';
import { analyzeAssertions } from './dataflow.ts';
import { extractComments } from './comments.ts';

export class TypeScriptParser implements LanguageParser {
  readonly language = 'typescript' as const;

  canParse(path: string): boolean {
    return /\.(ts|tsx|js|jsx|mts|cts|mjs)$/.test(path) && !/\.d\.[cm]?ts$/.test(path);
  }

  resolveImport(specifier: string, fromFile: string): string | null {
    return resolveImportTs(specifier, fromFile);
  }

  parseModule(path: string, source: string, _ctx: ParseContext): ModuleIR {
    const handle = getProgram(path);
    // Use the program's own source file instance for type-aware analysis (F5/F6).
    let sf = handle.program.getSourceFile(path);
    const typeAware = sf !== undefined && handle.hasConfig;
    if (!sf) sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);

    const diagnostics: ParseDiagnostic[] = [];
    const parseDiagnostics =
      (sf as ts.SourceFile & { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
    for (const d of parseDiagnostics) {
      const p = sf.getLineAndCharacterOfPosition(d.start);
      diagnostics.push({
        severity: 'error',
        span: span(path, p.line + 1, p.character + 1, p.line + 1, p.character + 1),
        message: `SYS-001: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`.slice(0, 120),
      });
    }

    const isTest = /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || path.includes('__tests__');
    const imports = extractImports(sf);
    const framework = detectFramework(imports);
    const { symbols, exports } = extractSymbols(sf);
    const { mocks, instanceIds } = detectMocks(sf, {
      framework: framework ?? 'manual',
      typeAware,
      resolveImport: (spec) => this.resolveImport(spec, path),
    });
    const { assertions, functions } = analyzeAssertions(sf, imports, instanceIds, framework);
    const comments = extractComments(source);

    return {
      path,
      language: 'typescript',
      kind: isTest ? 'test' : 'production',
      framework,
      imports,
      symbols,
      exports,
      mocks,
      assertions,
      functions,
      comments,
      diagnostics,
      hash: '',
    };
  }
}

function extractImports(sf: ts.SourceFile): ImportIR[] {
  const out: ImportIR[] = [];
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const specifier = stmt.moduleSpecifier.text;
      const names: string[] = [];
      const clause = stmt.importClause;
      if (clause?.name) names.push(clause.name.text);
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          names.push(clause.namedBindings.name.text);
        } else {
          for (const el of clause.namedBindings.elements) names.push(el.name.text);
        }
      }
      out.push({
        specifier,
        resolvedPath: resolveImportTs(specifier, sf.fileName) ?? undefined,
        names,
      });
    }
  }
  return out;
}

function detectFramework(imports: ImportIR[]): MockFramework | undefined {
  for (const i of imports) {
    if (i.specifier === 'vitest' || i.specifier.startsWith('@vitest/')) return 'vitest';
    if (i.specifier === '@jest/globals' || i.specifier === 'jest') return 'jest';
  }
  return undefined;
}
