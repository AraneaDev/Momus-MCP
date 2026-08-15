// E3 — provenance-based tautology detection (TAUT-001/002/006).
// Validates: docs/03 §3.2 data-flow pass and §3.3.1 rules.
// Critical check: the healthy test ('computes totals from the db') must stay quiet.
import * as ts from 'typescript';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tautologyIssues, rel } from './lib/engine.ts';

const file = fileURLToPath(new URL('../fixtures/ts/tests/ledger.test.ts', import.meta.url));
const source = readFileSync(file, 'utf8');
const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

console.log('== E3: tautology rules on ledger.test.ts ==');
const issues = tautologyIssues(sf, file);
if (issues.length === 0) {
  console.log('  (no findings)');
}
for (const i of issues) {
  console.log(`  ${rel(i.file)}:${i.line}:${i.col} [${i.rule}] ${i.severity} — ${i.message}`);
}

const byLine = new Map(issues.map((i) => [i.line, i]));
const itLines = new Map<string, number>(); // it-block name -> assertion line (approx, for report)
const want: Array<[string, number, string]> = [
  // rule, line, must-be-present-in-fixture
  ['TAUT-002', 23, 'mock-echo on mocked.getTotal() vs 42'],
  ['TAUT-006', 31, 'unconfigured spy assertion'],
];
let pass = true;
for (const [rule, line, why] of want) {
  const found = byLine.get(line)?.rule === rule;
  console.log(`  ${found ? 'PASS' : 'FAIL'}  ${rule} at line ${line} (${why})`);
  pass &&= found;
}
// healthy case must produce NO findings in its block (lines 10-17)
const healthy = [...issues].filter((i) => i.line >= 10 && i.line <= 17);
console.log(`  ${healthy.length === 0 ? 'PASS' : 'FAIL'}  healthy test (lines 10-17) stays quiet — ${healthy.length} finding(s)`);
pass &&= healthy.length === 0;
console.log(pass ? 'E3 PASS: provenance-based tautology detection works' : 'E3 FAIL');
process.exit(pass ? 0 : 1);
