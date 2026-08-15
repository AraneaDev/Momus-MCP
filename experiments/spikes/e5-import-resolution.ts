// E5 — module resolution for mock targets.
// Validates: docs/02 §2.4.2 resolution rules (relative + tsconfig paths + node_modules).
import * as ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { makeProgram } from './lib/engine.ts';

const root = fileURLToPath(new URL('../fixtures/ts', import.meta.url));
const fromFile = fileURLToPath(new URL('../fixtures/ts/tests/ledger.test.ts', import.meta.url));

// 1. TypeScript-native resolution via resolveModuleName (what the real engine would use)
const parsed = ts.getParsedCommandLineOfConfigFile(
  ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json')!,
  {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
)!;
console.log('== E5: module resolution ==');

const resolveTs = (spec: string) => {
  const r = ts.resolveModuleName(spec, fromFile, parsed.options, ts.sys).resolvedModule;
  return r?.resolvedFileName ?? null;
};

// 2. Independent fallback implementation (relative + extension probing + index)
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cts', '.mts', '.d.ts'];
const resolveRelative = (spec: string, from: string): string | null => {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec);
  for (const ext of EXTENSIONS) if (existsSync(base + ext)) return base + ext;
  for (const ext of EXTENSIONS) if (existsSync(join(base, 'index' + ext))) return join(base, 'index' + ext);
  return null;
};

// 3. tsconfig paths aliases (@app/*)
const resolveAlias = (spec: string): string | null => {
  const paths = parsed.options.paths ?? {};
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!spec.startsWith(pattern.replace('*', ''))) continue;
    const star = spec.slice(pattern.indexOf('*') === -1 ? pattern.length : pattern.indexOf('*'));
    const target = targets[0].replace('*', star);
    return resolve(root, parsed.options.baseUrl ?? '.', target);
  }
  return null;
};

const cases: Array<[string, string, string | null]> = [
  ['../src/services/db', 'relative specifier', 'src/services/db.ts'],
  ['../src/services/ledger', 'relative, no extension', 'src/services/ledger.ts'],
  ['@app/services/ledger', 'tsconfig paths alias', 'src/services/ledger.ts'],
  ['vitest', 'node_modules (unresolvable here)', null],
  ['./nope', 'missing module', null],
];

let pass = true;
for (const [spec, desc, want] of cases) {
  const got = resolveTs(spec) ?? resolveRelative(spec, fromFile) ?? resolveAlias(spec);
  const wantAbs = want ? resolve(root, want) : null;
  const ok = wantAbs ? got === wantAbs : got === null;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${desc}: '${spec}' -> ${got ? got.replace(root + '/', '') : 'null'} (want ${want ?? 'null'})`);
  pass &&= ok;
}

// The fallback chain must agree with ts-native resolution for relative specifiers
for (const spec of ['../src/services/db', '../src/services/ledger']) {
  const a = resolveTs(spec);
  const b = resolveRelative(spec, fromFile);
  const ok = a === b;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  fallback agrees with TS resolution for '${spec}'`);
  pass &&= ok;
}

console.log(pass ? 'E5 PASS: resolution chain works (TS-native + fallback + aliases)' : 'E5 FAIL');
process.exit(pass ? 0 : 1);
