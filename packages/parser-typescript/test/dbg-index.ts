import { AuditEngine } from '@momus/core';
import { TypeScriptParser } from '../src/index.ts';
import { readFileSync } from 'node:fs';

const root = '/root/Momus-MCP/experiments/fixtures/ts';
const parser = new TypeScriptParser();
const engine = new AuditEngine({ root, parser, paths: ['tests/ledger.test.ts'], maxIssues: 50 });
const result = engine.run();
console.log('indexStats:', JSON.stringify(result.indexStats));
for (const f of ['src/services/db.ts', 'src/services/ledger.ts']) {
  const src = readFileSync(root + '/' + f, 'utf8');
  const m = parser.parseModule(root + '/' + f, src, { config: {} as never, resolveImport: () => null });
  console.log(
    f,
    'symbols:',
    m.symbols.map((s) => `${s.id} [${s.kind}] members=${s.members.map((x) => x.name).join(',')}`),
  );
}
// what does the checker resolve for the spyOn targets?
const src = readFileSync(root + '/tests/ledger.test.ts', 'utf8');
const tm = parser.parseModule(root + '/tests/ledger.test.ts', src, {
  config: {} as never,
  resolveImport: (s) => parser.resolveImport(s, root + '/tests/ledger.test.ts'),
});
for (const m of tm.mocks) {
  console.log(
    'mock:',
    m.pattern,
    'target:',
    JSON.stringify(m.target),
    'stubs:',
    m.stubbedMembers.map((s) => s.name).join(','),
  );
}
