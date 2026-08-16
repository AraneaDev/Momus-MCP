import { describe, expect, it } from 'vitest';
import type { LanguageParser, ParseContext } from '../src/parser.ts';
import type { ModuleIR } from '../src/ir.ts';
import { CompositeParser } from '../src/compositeParser.ts';

function module(language: ModuleIR['language'], path: string): ModuleIR {
  return {
    path,
    language,
    kind: 'test',
    framework: undefined,
    imports: [],
    symbols: [],
    exports: [],
    mocks: [],
    assertions: [],
    functions: [],
    comments: [],
    diagnostics: [],
    hash: '',
  };
}

function stubParser(overrides: Partial<LanguageParser> & { claims?: RegExp } = {}): LanguageParser {
  return {
    language: overrides.language ?? 'typescript',
    canParse: overrides.canParse ?? ((p: string) => overrides.claims?.test(p) ?? false),
    resolveImport: overrides.resolveImport ?? (() => null),
    parseModule: overrides.parseModule ?? ((p: string) => module(overrides.language ?? 'typescript', p)),
  };
}

describe('CompositeParser', () => {
  it('delegates canParse across parsers', () => {
    const ts = stubParser({ claims: /\.ts$/ });
    const php = stubParser({ language: 'php', claims: /\.php$/ });
    const composite = new CompositeParser([ts, php]);
    expect(composite.canParse('/x/a.ts', '')).toBe(true);
    expect(composite.canParse('/x/b.php', '<?php')).toBe(true);
    expect(composite.canParse('/x/c.rb', '')).toBe(false);
  });

  it('returns the first non-null resolveImport, else null', () => {
    const a = stubParser({ resolveImport: () => null });
    const b = stubParser({ resolveImport: (s) => (s === 'foo' ? '/resolved/foo' : null) });
    const composite = new CompositeParser([a, b]);
    expect(composite.resolveImport('foo', '/from.ts')).toBe('/resolved/foo');
    expect(composite.resolveImport('bar', '/from.ts')).toBeNull();
  });

  it('dispatches parseModule to the claiming parser', () => {
    const php = stubParser({ language: 'php', claims: /\.php$/, parseModule: (p) => module('php', p) });
    const composite = new CompositeParser([php]);
    const out = composite.parseModule('/x/a.php', '<?php', {} as ParseContext);
    expect(out.language).toBe('php');
    expect(out.path).toBe('/x/a.php');
  });

  it('throws when no parser claims the file', () => {
    const composite = new CompositeParser([]);
    expect(() => composite.parseModule('/x/a.rb', '', {} as ParseContext)).toThrow("no parser claims '/x/a.rb'");
  });
});
