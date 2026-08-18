/** Symbol index (spec docs/02 §2.4): in-memory graph over parsed ModuleIRs. */
import type { ModuleIR, SymbolIR } from './ir.ts';

export interface IndexStats {
  modules: number;
  symbols: number;
  mocks: number;
}

export class SymbolIndex {
  private modules = new Map<string, ModuleIR>();
  private symbols = new Map<string, SymbolIR>();
  private moduleExports = new Map<string, SymbolIR[]>();
  private byName = new Map<string, SymbolIR[]>(); // name -> symbols (for loose resolution)

  constructor(productionModules: ModuleIR[], extraModules: ModuleIR[] = []) {
    for (const m of productionModules) this.addModule(m);
    // Test-module symbols join id/member lookups only: a mock-of-own-file (mockall tests define
    // their own `trait Foo` and mock it) must resolve its same-file members, while loose byName
    // resolution and export lookups stay production-only so test symbols never pollute cross-file
    // resolution (docs/11 row 54).
    for (const m of extraModules) this.addSymbolsOnly(m);
  }

  addModule(m: ModuleIR): void {
    this.modules.set(m.path, m);
    const exports: SymbolIR[] = [];
    for (const s of m.symbols) {
      this.symbols.set(s.id, s);
      if (m.exports.includes(s.name)) exports.push(s);
      const bucket = this.byName.get(s.name) ?? [];
      bucket.push(s);
      this.byName.set(s.name, bucket);
    }
    this.moduleExports.set(m.path, exports);
  }

  private addSymbolsOnly(m: ModuleIR): void {
    for (const s of m.symbols) this.symbols.set(s.id, s);
  }

  getModule(path: string): ModuleIR | undefined {
    return this.modules.get(path);
  }
  getSymbol(id: string): SymbolIR | undefined {
    return this.symbols.get(id);
  }

  /** Members of a symbol including inherited (via extendsIds, recursive). */
  membersOf(id: string): SymbolIR[] {
    const out: SymbolIR[] = [];
    const seen = new Set<string>();
    const visit = (symId: string) => {
      if (seen.has(symId)) return;
      seen.add(symId);
      const s = this.symbols.get(symId);
      if (!s) return;
      for (const m of s.members) if (!out.some((x) => x.id === m.id)) out.push(m);
      for (const ext of s.extendsIds) visit(ext);
    };
    visit(id);
    return out;
  }

  /** Named exports of a module path (empty when the module is not indexed). */
  exportsOf(path: string): SymbolIR[] {
    return this.moduleExports.get(path) ?? [];
  }

  /** Loose name-based resolution (syntax-only mode). */
  resolveByName(name: string, fromModule: string): SymbolIR | undefined {
    const same = this.byName.get(name)?.find((s) => s.span.file === fromModule);
    if (same) return same;
    return this.byName.get(name)?.[0];
  }

  stats(): IndexStats {
    let mocks = 0;
    for (const m of this.modules.values()) mocks += m.mocks.length;
    return { modules: this.modules.size, symbols: this.symbols.size, mocks };
  }
}
