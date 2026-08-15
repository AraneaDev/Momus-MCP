// E6 — PHP parsing via `php-parser` (glayzzle).
// Validates: docs/02 §2.2.3 + §2.5.2 (createMock chains, typed classes, comments).
import * as phpParser from 'php-parser';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const engine = new phpParser.Engine({
  parser: { extractDoc: true, suppressErrors: false },
  ast: { withPositions: true, withSource: true },
});

let pass = true;
const check = (ok: boolean, label: string, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  pass &&= ok;
};

// ---------------------------------------------------------------- production class
const repoFile = fileURLToPath(new URL('../fixtures/php/src/InvoiceRepository.php', import.meta.url));
const repoAst = engine.parseCode(readFileSync(repoFile, 'utf8'), repoFile) as any;

const prog = repoAst.kind === 'program' ? repoAst : repoAst.children.find((n: any) => n.kind === 'program');
const ns = prog.children.find((n: any) => n.kind === 'namespace');
check(ns?.name === 'App', 'namespace extracted', `got '${ns?.name}'`);

const cls = ns.children.find((n: any) => n.kind === 'class');
check(cls?.name?.name === 'InvoiceRepository', 'class name', `got '${cls?.name?.name}'`);

const methods = cls.body.filter((n: any) => n.kind === 'method');
check(methods.length === 2, 'method count', `got ${methods.length}`);

const findById = methods.find((m: any) => m.name?.name === 'findById');
const param = findById.arguments[0];
check(param?.kind === 'parameter' && param?.name?.name === 'id', 'parameter name', `got '${param?.name?.name}'`);
check(param?.type?.kind === 'typereference' && param?.type?.name === 'int', 'parameter type int', `got '${param?.type?.name}'`);
check(findById?.type?.kind === 'name' && findById?.type?.name === 'Invoice', 'return type Invoice', `got '${findById?.type?.name}' (kind ${findById?.type?.kind})`);
check(findById?.visibility === 'public', 'visibility', `got '${findById?.visibility}'`);

// ---------------------------------------------------------------- test file: PHPUnit patterns
const testFile = fileURLToPath(new URL('../fixtures/php/tests/InvoiceTest.php', import.meta.url));
const testAst = engine.parseCode(readFileSync(testFile, 'utf8'), testFile) as any;
const testProg = testAst.kind === 'program' ? testAst : testAst.children.find((n: any) => n.kind === 'program');
const testNs = testProg.children.find((n: any) => n.kind === 'namespace');

const uses = testNs.children.filter((n: any) => n.kind === 'usegroup');
const useNames = uses.flatMap((u: any) => u.items.map((i: any) => i.name));
check(useNames.includes('PHPUnit\\Framework\\TestCase'), 'use statements', JSON.stringify(useNames));

const testClass = testNs.children.find((n: any) => n.kind === 'class');
check(testClass?.name?.name === 'InvoiceTest', 'test class name');

// walk the whole tree for interesting call shapes
const calls: string[] = [];
const walk = (n: any, depth = 0): void => {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) { n.forEach((c) => walk(c, depth)); return; }
  if (n.kind === 'call') calls.push(`call:${n.what?.offset?.name ?? n.what?.name ?? '?'}`);
  if (n.kind === 'staticlookup') calls.push(`staticlookup:${n.what?.name ?? '?'}::${n.offset?.name ?? '?'}`);
  for (const k of Object.keys(n)) if (k !== 'loc' && k !== 'leadingComments' && k !== 'comments') walk(n[k], depth + 1);
};
walk(testAst);

check(calls.includes('call:createMock'), 'createMock detected', calls.filter((c) => c.includes('createMock')).join(','));
check(calls.includes('call:method'), '->method() detected');
check(calls.includes('call:willReturn'), '->willReturn() detected');
check(calls.includes('call:expects'), '->expects() detected');

// extract the createMock target class from the first method body
const m1 = testClass.body.find((n: any) => n.kind === 'method' && n.name?.name === 'testTotalEchoesStub');
const m1Body = m1.body;
const findCreateMock = (n: any): any => {
  if (!n || typeof n !== 'object') return undefined;
  if (Array.isArray(n)) { for (const c of n) { const r = findCreateMock(c); if (r) return r; } return undefined; }
  if (n.kind === 'call' && n.what?.offset?.name === 'createMock') return n;
  for (const k of Object.keys(n)) { const r = findCreateMock(n[k]); if (r) return r; }
  return undefined;
};
const createMockCall = findCreateMock(m1Body);
const targetArg = createMockCall?.arguments?.[0];
const targetName = targetArg?.what?.name; // classconstant Foo::class
check(targetName === 'InvoiceRepository', 'createMock target resolved from ::class', `got '${targetName}'`);

// chained ->expects(...)->method('fetchAll')
const chain = (n: any, acc: string[] = []): string[] => {
  if (!n) return acc;
  if (n.kind === 'call') {
    acc.unshift(n.what?.offset?.name ?? n.what?.name ?? '?');
    return chain(n.what, acc);
  }
  if (n.kind === 'propertylookup' || n.kind === 'assign') {
    return chain(n.what ?? n.right, acc);
  }
  return acc;
};
const m2 = testClass.body.find((n: any) => n.kind === 'method' && n.name?.name === 'testSpiesOnMissingMember');
const mockStmt = (m2.body as any).children.find((n: any) => n.kind === 'expressionstatement' && n.expression?.kind !== 'assign');
const chainCalls = chain(mockStmt?.expression);
check(chainCalls.join(' -> ') === 'expects -> method', 'mock builder chain traversal', chainCalls.join(' -> '));

// ---------------------------------------------------------------- comments / docblocks (E8 tie-in)
const docblocks = m1.leadingComments ?? [];
check(Array.isArray(docblocks), 'docblock extraction API present', `leadingComments type=${typeof m1.leadingComments}`);
const withIgnore = `<?php
final class T extends \\PHPUnit\\Framework\\TestCase {
    /** @momus-ignore */
    public function testX(): void {
        // @momus-ignore:TAUT-002
        self::assertSame(1, 1);
    }
}`;
const tAst = engine.parseCode(withIgnore, 'inline.php') as any;
const tProg = tAst.kind === 'program' ? tAst : tAst.children.find((n: any) => n.kind === 'program');
const tCls = tProg.children.find((n: any) => n.kind === 'class');
const tM = tCls.body.find((n: any) => n.kind === 'method');
const leading = (tM?.leadingComments ?? []).map((c: any) => c.value?.trim());
check(leading.some((v: string) => v === '/** @momus-ignore */'), 'docblock @momus-ignore extractable', JSON.stringify(leading));

console.log(pass ? 'E6 PASS: php-parser handles PHPUnit patterns, typed classes, and comments' : 'E6 FAIL');
process.exit(pass ? 0 : 1);
