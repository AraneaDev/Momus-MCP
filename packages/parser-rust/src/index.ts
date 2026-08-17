/** Rust parser plugin: syn-WASM AST -> language-neutral Momus IR. */
import type { LanguageParser, MockFramework, ModuleIR, ParseContext } from '@momus/core';
import { parseRust } from './wasm.ts';
import type { RustFile, RustItem } from './ast.ts';
import { extractSymbols } from './symbols.ts';
import { extractImports } from './imports.ts';
import { resolveRustImport } from './resolve.ts';

export class RustParser implements LanguageParser {
  readonly language = 'rust' as const;

  canParse(path: string): boolean {
    return /\.rs$/i.test(path);
  }

  resolveImport(specifier: string, fromFile: string): string | null {
    return resolveRustImport(specifier, fromFile);
  }

  parseModule(path: string, source: string, _ctx: ParseContext): ModuleIR {
    try {
      const file = parseRust(source);
      if (file.error) throw new Error(file.error);
      const symbols = extractSymbols(file, path);
      const isTest = isTestSource(file);
      return {
        path,
        language: 'rust',
        kind: isTest ? 'test' : 'production',
        framework: isTest ? detectFramework(file) : undefined,
        imports: extractImports(file),
        symbols,
        exports: symbols.map((s) => s.name),
        mocks: [],
        assertions: [],
        functions: [],
        comments: [],
        diagnostics: [],
        hash: '',
      };
    } catch (error) {
      return {
        path,
        language: 'rust',
        kind: 'production',
        framework: undefined,
        imports: [],
        symbols: [],
        exports: [],
        mocks: [],
        assertions: [],
        functions: [],
        comments: [],
        diagnostics: [
          {
            severity: 'error',
            span: { file: path, startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
            message: `SYS-001: Rust parse error: ${(error as Error).message}`.slice(0, 120),
          },
        ],
        hash: '',
      };
    }
  }
}

/** A file is a test if any item carries #[test] or a #[cfg(test)] mod (recursive). */
function isTestSource(file: RustFile): boolean {
  const check = (items: RustItem[]): boolean =>
    items.some((i) => attrsOf(i).some((a) => a.path === 'test') || (i.kind === 'mod' && check(i.items)));
  return check(file.items);
}

function detectFramework(file: RustFile): MockFramework {
  // mockall: a `mock!` macro or an `#[automock]` attr anywhere. HTTP crates (mockito/
  // wiremock) are call expressions, detected in the mocks task (Task 6).
  const hasMockall = file.items.some(
    (i) => attrsOf(i).some((a) => a.path === 'automock') || (i.kind === 'macro' && i.path === 'mock'),
  );
  return hasMockall ? 'mockall' : 'manual';
}

function attrsOf(item: RustItem): { path: string; args: string | null }[] {
  if (item.kind === 'use' || item.kind === 'macro') return [];
  return item.attrs;
}
