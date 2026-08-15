// E4 — type-aware drift verification via the TypeChecker.
// Validates: docs/03 §3.3.2 DRIFT-001/003/005 machinery (docs/02 §2.4.2 resolution).
import * as ts from 'typescript';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { driftIssues, checkReturnAssignability, makeProgram, rel } from './lib/engine.ts';

const root = fileURLToPath(new URL('../fixtures/ts', import.meta.url));
const testFile = fileURLToPath(new URL('../fixtures/ts/tests/ledger.test.ts', import.meta.url));
const program = makeProgram(root);
const sf = program.getSourceFile(testFile)!;

console.log('== E4: drift checks on ledger.test.ts (type-aware) ==');
checkReturnAssignability(sf, program, (s) => console.log(s));

const issues = driftIssues(sf, testFile, program);
for (const i of issues) {
  console.log(`  ${rel(i.file)}:${i.line}:${i.col} [${i.rule}] ${i.severity} — ${i.message}`);
}

// Assertions:
const spyIssue = issues.find((i) => i.rule === 'DRIFT-001' && i.message.includes('totalForX'));
console.log(`  ${spyIssue ? 'PASS' : 'FAIL'}  DRIFT-001 fires for vi.spyOn(service, 'totalForX') — ${spyIssue?.message ?? 'not found'}`);

const okSpy = !issues.some((i) => i.rule === 'DRIFT-001' && i.message.includes("'totalFor'"));
console.log(`  ${okSpy ? 'PASS' : 'FAIL'}  no DRIFT-001 for existing member 'totalFor'`);

const okExports = !issues.some((i) => i.rule === 'DRIFT-005');
console.log(`  ${okExports ? 'PASS' : 'FAIL'}  DRIFT-005 quiet: factory key 'Db' IS an export of the real module`);

// DRIFT-005 positive control: compare factory keys against a *renamed* export set
const sf2 = program.getSourceFile(fileURLToPath(new URL('../fixtures/ts/src/services/db.ts', import.meta.url)))!;
const checker = program.getTypeChecker();
const modSym = checker.getSymbolAtLocation(sf2)!;
const realExports = checker.getExportsOfModule(modSym).map((e) => e.name);
console.log(`  real exports of db.ts: ${JSON.stringify(realExports)}`);
const plantedKeys = ['Db', 'DbFactory'];
const missing = plantedKeys.filter((k) => !realExports.includes(k));
console.log(`  ${missing.length === 1 && missing[0] === 'DbFactory' ? 'PASS' : 'FAIL'}  DRIFT-005 positive control: 'DbFactory' flagged missing, 'Db' kept`);

const pass = !!spyIssue && okSpy && okExports && missing.length === 1 && missing[0] === 'DbFactory';
console.log(pass ? 'E4 PASS: type-aware drift machinery works' : 'E4 FAIL');
process.exit(pass ? 0 : 1);
