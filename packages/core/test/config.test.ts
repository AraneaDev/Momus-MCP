import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, stripJsonComments, ConfigError, DEFAULT_CONFIG, effectiveSeverity } from '../src/config.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'momus-cfg-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('stripJsonComments', () => {
  it('strips line and block comments outside strings', () => {
    const input = '{ // line\n "a": "x // not a comment", /* block */ "b": 1 }';
    const out = stripJsonComments(input);
    expect(out).toContain('"a": "x // not a comment"');
    expect(out).not.toContain('// line');
    expect(out).not.toContain('/* block */');
  });
});

describe('loadConfig', () => {
  it('returns defaults when no config file exists', () => {
    const cfg = loadConfig(dir);
    expect(cfg).toEqual(DEFAULT_CONFIG);
    expect(cfg.testFilePatterns).toContain('**/*.{test,spec}.{ts,tsx,js,jsx,mjs}');
  });

  it('deep-merges nested sections', () => {
    writeFileSync(
      join(dir, '.momusrc'),
      JSON.stringify({
        languages: { php: true },
        tokenBudget: { maxIssuesPerReport: 10 },
        rules: { 'TAUT-002': 'warning' },
      }),
    );
    const cfg = loadConfig(dir);
    expect(cfg.languages.typescript).toBe(true); // untouched default preserved
    expect(cfg.languages.php).toBe(true);
    expect(cfg.tokenBudget.maxIssuesPerReport).toBe(10);
    expect(cfg.tokenBudget.verbosity).toBe('issues');
    expect(cfg.rules['TAUT-002']).toBe('warning');
  });

  it('accepts JSONC configs', () => {
    writeFileSync(join(dir, '.momusrc'), '{\n  // comment\n  "maxFileSizeBytes": 1024 /* block */\n}');
    expect(loadConfig(dir).maxFileSizeBytes).toBe(1024);
  });

  it('rejects unknown rule ids', () => {
    writeFileSync(join(dir, '.momusrc'), JSON.stringify({ rules: { 'NOPE-999': 'error' } }));
    expect(() => loadConfig(dir)).toThrow(ConfigError);
  });

  it('rejects invalid severities', () => {
    writeFileSync(join(dir, '.momusrc'), JSON.stringify({ rules: { 'TAUT-002': 'loud' } }));
    expect(() => loadConfig(dir)).toThrow(ConfigError);
  });

  it('rejects invalid JSON', () => {
    writeFileSync(join(dir, '.momusrc'), '{ not json');
    expect(() => loadConfig(dir)).toThrow(ConfigError);
  });

  it('honors an explicit config path', () => {
    writeFileSync(join(dir, 'custom.json'), JSON.stringify({ maxFileSizeBytes: 42 }));
    expect(loadConfig(dir, join(dir, 'custom.json')).maxFileSizeBytes).toBe(42);
  });
});

describe('effectiveSeverity', () => {
  it('falls back to the rule default', () => {
    expect(effectiveSeverity(DEFAULT_CONFIG, 'TAUT-001', 'error')).toBe('error');
  });
  it('uses string shorthand', () => {
    const cfg = { ...DEFAULT_CONFIG, rules: { 'TAUT-001': 'info' } };
    expect(effectiveSeverity(cfg, 'TAUT-001', 'error')).toBe('info');
  });
  it('uses severity object and honors off', () => {
    const cfg = { ...DEFAULT_CONFIG, rules: { 'TAUT-001': { severity: 'off' } } };
    expect(effectiveSeverity(cfg, 'TAUT-001', 'error')).toBe('off');
  });
});
