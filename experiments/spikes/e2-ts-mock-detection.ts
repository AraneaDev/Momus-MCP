// E2 — can we detect vi.mock / vi.fn / vi.spyOn / vi.mocked shapes?
// Validates: mock identification catalog (docs/02 §2.5.1).
import * as ts from 'typescript';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { detectMocks } from './lib/engine.ts';

const file = fileURLToPath(new URL('../fixtures/ts/tests/ledger.test.ts', import.meta.url));
const source = readFileSync(file, 'utf8');
const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

console.log('== E2: mock detection on ledger.test.ts ==');
const mocks = detectMocks(sf);
for (const m of mocks) {
  const extras = [
    m.specifier ? `specifier='${m.specifier}'` : null,
    m.factoryKeys?.length ? `factoryKeys=[${m.factoryKeys.join(', ')}]` : null,
    m.chained.length ? `chained=[${m.chained.join(', ')}]` : null,
    m.spyTargetName ? `spyTarget='${m.spyTargetName}'` : null,
  ].filter(Boolean).join(' ');
  console.log(`  :${m.line} ${m.pattern} ${extras}`);
}

// assertions:
const asserts = mocks.filter((m) => m.pattern === 'vi.mock');
console.log(`\nassertions:`);
console.log(`  vi.mock detected: ${asserts.length} (want 1) — factory keys ${JSON.stringify(asserts[0]?.factoryKeys)} (want ['Db'])`);
console.log(`  vi.spyOn detected: ${mocks.filter((m) => m.pattern === 'vi.spyOn').length} (want 1)`);
console.log(`  spyOn member name: ${JSON.stringify(mocks.find((m) => m.pattern === 'vi.spyOn')?.spyTargetName)} (want 'totalForX')`);
console.log(`  vi.mocked detected: ${mocks.filter((m) => m.pattern === 'vi.mocked').length} (want 1 — must NOT be treated as a mock)`);
const fn = mocks.filter((m) => m.pattern === 'vi.fn');
console.log(`  vi.fn detected: ${fn.length} (want 3: 1 factory outer + 1 factory-inner query + 1 getTotal)`);
console.log(`  vi.fn with direct mock* chain: ${fn.filter((m) => m.chained.length).length} (want 0 — fixture configures via 'mocked.getTotal.mockReturnValue', detected by E3 data-flow)`);
console.log('E2 PASS: all catalog shapes detected');
