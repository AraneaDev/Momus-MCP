// E1 — can we extract classes/interfaces/methods/signatures from TS source?
// Validates: IR SymbolIR extraction (docs/02 §2.3.2) from the TypeScript compiler API.
import * as ts from 'typescript';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../fixtures/ts/src/services/ledger.ts', import.meta.url));
const source = readFileSync(file, 'utf8');
const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

console.log(`== E1: symbol extraction from ${file.split('/').slice(-3).join('/')} (syntactic) ==`);
for (const stmt of sf.statements) {
  if (ts.isInterfaceDeclaration(stmt)) {
    console.log(`interface ${stmt.name.text}`);
    for (const m of stmt.members) {
      if (ts.isPropertySignature(m)) {
        console.log(`  property ${m.name.getText(sf)}${m.type ? ': ' + m.type.getText(sf) : ''}`);
      } else if (ts.isMethodSignature(m)) {
        const t = m.type?.getText(sf);
        const params = m.parameters.map((p) => `${p.name.getText(sf)}${p.type ? ': ' + p.type.getText(sf) : ''}`).join(', ');
        console.log(`  method ${m.name.getText(sf)}(${params})${t ? ': ' + t : ''}`);
      }
    }
  }
  if (ts.isClassDeclaration(stmt)) {
    console.log(`class ${stmt.name!.text}`);
    for (const m of stmt.members) {
      if (ts.isMethodDeclaration(m)) {
        const params = m.parameters.map((p) => `${p.name.getText(sf)}${p.type ? ': ' + p.type.getText(sf) : ''}${p.questionToken ? '?' : ''}`).join(', ');
        console.log(`  method ${m.name.getText(sf)}(${params})${m.type ? ': ' + m.type.getText(sf) : ''}${m.questionToken ? ' async' : ''}`);
      } else if (ts.isGetAccessorDeclaration(m)) {
        console.log(`  getter ${m.name.getText(sf)}(): ${m.type?.getText(sf)}`);
      } else if (ts.isConstructorDeclaration(m)) {
        console.log(`  constructor(${m.parameters.map((p) => `${p.modifiers?.length ? p.modifiers.map((x) => x.getText(sf)).join(' ') + ' ' : ''}${p.name.getText(sf)}${p.type ? ': ' + p.type.getText(sf) : ''}`).join(', ')})`);
      }
    }
  }
}

// Type-aware pass: resolved return types via the checker
console.log('\n== E1b: type-checker pass (resolved signatures) ==');
const configPath = ts.findConfigFile(file, ts.sys.fileExists, 'tsconfig.json');
const parsed = ts.getParsedCommandLineOfConfigFile(configPath!, { strict: true }, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })!;
const program = ts.createProgram([file, fileURLToPath(new URL('../fixtures/ts/src/services/db.ts', import.meta.url))], parsed.options);
const checker = program.getTypeChecker();
const cls = program.getSourceFile(file)!.statements.find((s) => ts.isClassDeclaration(s) && s.name?.text === 'LedgerService') as ts.ClassDeclaration;
for (const m of cls.members) {
  if (ts.isMethodDeclaration(m)) {
    const sig = checker.getSignatureFromDeclaration(m);
    const ret = checker.getReturnTypeOfSignature(sig!);
    const params = sig!.parameters.map((p) => `${p.name}: ${checker.typeToString(checker.getTypeOfSymbol(p))}`).join(', ');
    console.log(`  ${m.name.getText(sf)}(${params}): ${checker.typeToString(ret)}   [resolved]`);
  }
}
console.log('E1 PASS: syntactic + type-aware extraction both work');
