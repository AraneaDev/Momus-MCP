/** Dispatches each file to the first language parser that claims its extension. */
import type { LanguageParser, ParseContext } from './parser.ts';
import type { ModuleIR } from './ir.ts';
import type { Language } from './languages.ts';

export class CompositeParser implements LanguageParser {
  // The contract predates multi-language parsers; AuditEngine uses each ModuleIR.language.
  readonly language: Language = 'typescript';

  private readonly parsers: LanguageParser[];

  constructor(parsers: LanguageParser[]) {
    this.parsers = parsers;
  }

  canParse(path: string, source: string): boolean {
    return this.parsers.some((parser) => parser.canParse(path, source));
  }

  resolveImport(specifier: string, fromFile: string): string | null {
    for (const parser of this.parsers) {
      const resolved = parser.resolveImport(specifier, fromFile);
      if (resolved) return resolved;
    }
    return null;
  }

  parseModule(path: string, source: string, ctx: ParseContext): ModuleIR {
    const parser = this.parsers.find((candidate) => candidate.canParse(path, source));
    if (!parser) throw new Error(`no parser claims '${path}'`);
    return parser.parseModule(path, source, ctx);
  }
}
