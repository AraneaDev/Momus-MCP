import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuditEngine, CompositeParser, DEFAULT_CONFIG } from '@momus/core';
import { PhpParser } from '../src/index.ts';

const ROOT = join(import.meta.dirname, 'fixtures');
const PROD = join(ROOT, 'src', 'InvoiceRepository.php');
const LEGACY = join(ROOT, 'src', 'legacy', 'LegacyRepository.php');
const TEST = join(ROOT, 'tests', 'InvoiceTest.php');
const parser = new PhpParser();

function parse(path: string) {
  return parser.parseModule(path, readFileSync(path, 'utf8'), {
    config: undefined,
    resolveImport: () => null,
  });
}

describe('PHP parser', () => {
  it('extracts typed production symbols and methods', () => {
    const module = parse(PROD);
    const repository = module.symbols.find((symbol) => symbol.name === 'InvoiceRepository');
    expect(module.kind).toBe('production');
    expect(repository?.members.map((member) => member.name)).toEqual(['__construct', 'findById', 'save']);
    expect(
      repository?.members.find((member) => member.name === 'findById')?.signature?.parameters[0]?.type,
    ).toMatchObject({ kind: 'named', name: 'int' });
  });

  it('enriches PHP signatures from PHPDoc @param/@return annotations', () => {
    const module = parse(join(ROOT, 'src', 'DocblockService.php'));
    const service = module.symbols.find((symbol) => symbol.name === 'DocblockService');
    const findById = service?.members.find((member) => member.name === 'findById');
    expect(findById?.signature?.parameters[0]?.type).toMatchObject({ kind: 'named', name: 'int' });
    expect(findById?.signature?.returnType).toMatchObject({ kind: 'named', name: 'Invoice' });
    const fetchIds = service?.members.find((member) => member.name === 'fetchIds');
    expect(fetchIds?.signature?.returnType).toMatchObject({ kind: 'array', element: { kind: 'named', name: 'int' } });
    const tag = service?.members.find((member) => member.name === 'tag');
    expect(tag?.signature?.returnType).toMatchObject({ kind: 'void' });
    expect(tag?.signature?.parameters[0]?.type).toMatchObject({
      kind: 'union',
      members: [{ kind: 'named', name: 'string' }, { kind: 'null' }],
    });
  });

  it('resolves PSR-4 namespaces and falls back to the Composer classmap', () => {
    expect(parser.resolveImport('App\\InvoiceRepository', TEST)).toBe(PROD);
    expect(parser.resolveImport('Legacy\\LegacyRepository', TEST)).toBe(LEGACY);
    expect(parser.resolveImport('App\\OptionsRepository', TEST)).toBe(join(ROOT, 'src', 'OptionsRepository.php'));
  });

  it('extracts PHPUnit createMock chains and configured values', () => {
    const module = parse(TEST);
    expect(module.kind).toBe('test');
    const repositoryImport = module.imports.find((item) => item.specifier === 'App\\InvoiceRepository');
    expect(repositoryImport?.names).toContain('Repo');
    expect(repositoryImport?.resolvedPath).toBe(PROD);
    expect(module.imports.find((item) => item.specifier === 'Legacy\\LegacyRepository')?.resolvedPath).toBe(LEGACY);
    expect(module.mocks).toHaveLength(3);
    const planted = module.mocks[0]!;
    expect(planted.pattern).toBe('createMock');
    expect(planted.target?.exportName).toBe('InvoiceRepository');
    expect(module.mocks.map((mock) => mock.stubbedMembers.map((member) => member.name))).toEqual([
      ['findById', 'fetchAll'],
      ['findById'],
      ['findById'],
    ]);
    expect(planted.configuredValues[0]?.api).toBe('willReturn');
    expect(module.assertions).toHaveLength(3);
    const echo = module.assertions.find(
      (assertion) =>
        assertion.api === 'assertSame' && assertion.operands.some((operand) => operand.provenance === 'mock-config'),
    );
    expect(echo?.operands.find((operand) => operand.provenance === 'mock-config')?.configuredValue).toBe('42');
  });

  it('detects Mockery and Pest mock factories with chained and closure-form configuration', () => {
    const mockery = parse(join(ROOT, 'tests', 'MockeryPestTest.php'));
    expect(mockery.mocks.map((mock) => mock.pattern)).toEqual([
      'mockery',
      'mockery',
      'mockery',
      'mockery',
      'pest-mock',
    ]);
    expect(mockery.mocks.map((mock) => mock.stubbedMembers[0]?.name)).toEqual([
      'fetchAll',
      'findById',
      'findById',
      'fetchAll',
      'fetchAll',
    ]);
    expect(mockery.mocks.every((mock) => mock.configuredValues[0]?.api === 'andReturn')).toBe(true);
    expect(mockery.mocks.every((mock) => mock.target?.exportName === 'InvoiceRepository')).toBe(true);
  });

  it('extracts original-constructor argument counts for PHP doubles', () => {
    const constructor = parse(join(ROOT, 'tests', 'ConstructorTest.php'));
    expect(
      constructor.mocks.filter((mock) => mock.pattern === 'getMockBuilder').map((mock) => mock.constructorArgs?.count),
    ).toEqual([0, 1, 0]);
  });

  it('extracts anonymous-class overrides as mock doubles', () => {
    const module = parse(join(ROOT, 'tests', 'AnonymousTest.php'));
    const anonymous = module.mocks.filter((mock) => mock.pattern === 'anonymous-class');
    expect(anonymous).toHaveLength(2);
    expect(anonymous.every((mock) => mock.target?.exportName === 'InvoiceRepository')).toBe(true);
    expect(anonymous.map((mock) => mock.stubbedMembers.map((member) => member.name))).toEqual([
      ['staleMethod'],
      ['findById'],
    ]);
    expect(anonymous[1]?.stubbedMembers[0]?.api).toBe('instance-member');
  });

  it('extracts getMockForAbstractClass doubles targeting the abstract class', () => {
    const module = parse(join(ROOT, 'tests', 'AbstractMockTest.php'));
    const mocks = module.mocks.filter((mock) => mock.pattern === 'getMockForAbstractClass');
    expect(mocks).toHaveLength(2);
    expect(mocks.every((mock) => mock.target?.exportName === 'AbstractGateway')).toBe(true);
    // both test fns reuse `$mock` — this proves bindings are function-scoped, not name-global
    expect(mocks.map((mock) => mock.stubbedMembers.map((member) => member.name))).toEqual([
      ['staleProcess'],
      ['process'],
    ]);
  });

  it('captures setUp-assigned property mocks and resolves configs through $this', () => {
    const module = parse(join(ROOT, 'tests', 'SetUpMockTest.php'));
    expect(module.mocks).toHaveLength(1);
    const mock = module.mocks[0]!;
    expect(mock.pattern).toBe('createMock');
    expect(mock.target?.exportName).toBe('InvoiceRepository');
    expect(mock.stubbedMembers.map((member) => member.name)).toEqual(['deleteById', 'findById', 'save']);
    const echo = module.assertions.find(
      (assertion) =>
        assertion.api === 'assertSame' && assertion.operands.some((operand) => operand.provenance === 'mock-config'),
    );
    expect(echo?.operands.find((operand) => operand.provenance === 'mock-config')?.configuredValue).toBe('42');
  });

  it('binds configs to the nearest reassignment of the same variable', () => {
    const module = parse(join(ROOT, 'tests', 'ReassignTest.php'));
    expect(module.mocks).toHaveLength(2);
    expect(module.mocks.map((mock) => mock.stubbedMembers.map((member) => member.name))).toEqual([
      ['save'],
      ['findById'],
    ]);
  });

  it('honors the PHP language gate in the composite parser', () => {
    const result = new AuditEngine({ root: ROOT, parser: new CompositeParser([parser]) }).run();
    expect(result.issues).toHaveLength(0);
    expect(result.summary.filesAudited).toBe(0);
  });

  it('runs PHP mocks through the existing drift and tautology rules', () => {
    const result = new AuditEngine({
      root: ROOT,
      parser: new CompositeParser([parser]),
      config: { ...DEFAULT_CONFIG, languages: { typescript: false, php: true } },
    }).run();
    expect(result.issues.filter((issue) => issue.rule === 'DRIFT-001')).toHaveLength(7);
    const drift003 = result.issues.filter((issue) => issue.rule === 'DRIFT-003');
    // 2 planted in Drift003Test + InvoiceTest echo willReturn(42) + 2 docblock-typed + SetUpMockTest echo willReturn(42)
    expect(drift003).toHaveLength(7);
    const drift004 = result.issues.filter((issue) => issue.rule === 'DRIFT-004');
    expect(drift004).toHaveLength(1);
    expect(drift004[0]?.message).toMatch(/requires 1/);
    expect(result.issues.filter((issue) => issue.rule === 'TAUT-002')).toHaveLength(2);
    expect(result.issues.filter((issue) => issue.rule === 'TAUT-003')).toHaveLength(1);
  });
});
