/** Language parser plugin contract (spec docs/02 §2.3.1). */
import type { Language, ModuleIR } from './ir.ts';

export interface ParseContext {
  config: unknown;              // language-agnostic config slice
  /** Resolve a specifier to an absolute path, or null. */
  resolveImport(specifier: string, fromFile: string): string | null;
}

export interface LanguageParser {
  readonly language: Language;
  /** True when this parser claims the file (extension + content sniffing). */
  canParse(path: string, source: string): boolean;
  /** Resolve an import/use specifier to an absolute path, or null. */
  resolveImport(specifier: string, fromFile: string): string | null;
  /** Parse a file into a language-neutral ModuleIR. Never throws for bad code:
   *  syntax errors become diagnostics. */
  parseModule(path: string, source: string, ctx: ParseContext): ModuleIR;
}
