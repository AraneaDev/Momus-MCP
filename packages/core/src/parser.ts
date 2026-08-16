/** Language parser plugin contract (spec docs/02 §2.3.1). */
import type { Language, ModuleIR } from './ir.ts';

export interface ParseContext {
  config: unknown; // language-agnostic config slice
  /** Resolve a specifier to an absolute path, or null. */
  resolveImport(specifier: string, fromFile: string): string | null;
}

/**
 * Advisory persistent parse cache (spec docs/02 §2.4.3): never the source of truth.
 * Keyed by file content hash + a workspace digest so type-aware parses (whose IR can
 * depend on other files) are only served when the whole workspace is unchanged.
 */
export interface ParseCache {
  get(path: string, fileHash: string, workspaceHash: string): ModuleIR | undefined;
  put(path: string, fileHash: string, workspaceHash: string, module: ModuleIR): void;
  /** Release any held resources (SQLite handle). Optional for in-memory caches. */
  close?(): void;
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
