import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuditEngine } from '@momus/core';
import { TypeScriptParser } from '../src/index.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', 'syntax-only-fixtures');
const TEST_FILE = join(ROOT, 'tests', 'syntax.test.ts');
const parser = new TypeScriptParser();

describe('syntax-only target resolution', () => {
  it('keeps the parser target syntactic before index enrichment', () => {
    const module = parser.parseModule(TEST_FILE, readFileSync(TEST_FILE, 'utf8'), {
      config: undefined,
      resolveImport: (spec) => parser.resolveImport(spec, TEST_FILE),
    });
    const objectMock = module.mocks.find((m) => m.pattern === 'object-literal');
    expect(objectMock?.target?.exportName).toBe('Widget');
    expect(objectMock?.target?.symbolId).toBeUndefined();
  });

  it('resolves the planted syntax-only drift while keeping the healthy twin quiet', () => {
    const result = new AuditEngine({ root: ROOT, parser }).run();
    const drift = result.issues.filter((issue) => issue.rule === 'DRIFT-002');
    expect(drift).toHaveLength(1);
    expect(drift[0]?.span.startLine).toBe(5);
    expect(drift[0]?.message).toContain('stub declares 2 required params, production has 1');
  });
});
