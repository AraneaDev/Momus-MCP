/** .momusrc loading + validation (spec docs/02 §2.6). */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { defaultEnabledLanguages, defaultTestFilePatterns } from './languages.ts';
import type { Language } from './languages.ts';

export interface RuleSeverityConfig {
  severity?: 'error' | 'warning' | 'info' | 'off';
  options?: Record<string, unknown>;
}

export interface MomusConfig {
  languages: Record<Language, boolean>;
  testFilePatterns: string[];
  rules: Record<string, RuleSeverityConfig>;
  mockSaturationThreshold: number;
  ignorePatterns: string[];
  suppressions: Array<{ rule?: string; files?: string[]; reason?: string }>;
  tokenBudget: { maxIssuesPerReport: number; maxIssueLineTokens: number; verbosity: 'summary' | 'issues' };
  maxFileSizeBytes: number;
  maxIndexedLines: number;
  cache: { dir: string; enabled: boolean };
}

export const DEFAULT_CONFIG: MomusConfig = {
  languages: defaultEnabledLanguages(),
  testFilePatterns: defaultTestFilePatterns(),
  rules: {},
  mockSaturationThreshold: 0.7,
  ignorePatterns: ['**/node_modules/**', '**/vendor/**', '**/dist/**', '**/.git/**'],
  suppressions: [],
  tokenBudget: { maxIssuesPerReport: 50, maxIssueLineTokens: 100, verbosity: 'issues' },
  maxFileSizeBytes: 2 * 1024 * 1024,
  maxIndexedLines: 500_000,
  cache: { dir: '.momus/cache', enabled: true },
};

/** Minimal JSONC stripper: removes // and /* *​/ comments outside strings. */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const n = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export class ConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function loadConfig(rootDir: string, explicitPath?: string): MomusConfig {
  const path = explicitPath ?? join(rootDir, '.momusrc');
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError('CONFIG_ERROR', `cannot read config at ${path}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(stripJsonComments(raw));
  } catch (e) {
    throw new ConfigError('CONFIG_ERROR', `invalid JSON in ${path}: ${(e as Error).message}`);
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new ConfigError('CONFIG_ERROR', `${path} must contain a JSON object`);
  }
  const cfg = { ...DEFAULT_CONFIG } as Record<string, unknown>;
  for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
    if (k === 'tokenBudget' && typeof v === 'object' && v !== null) {
      cfg.tokenBudget = { ...DEFAULT_CONFIG.tokenBudget, ...(v as object) };
    } else if (k === 'languages' && typeof v === 'object' && v !== null) {
      cfg.languages = { ...DEFAULT_CONFIG.languages, ...(v as object) };
    } else if (k === 'cache' && typeof v === 'object' && v !== null) {
      cfg.cache = { ...DEFAULT_CONFIG.cache, ...(v as object) };
    } else {
      cfg[k] = v;
    }
  }
  // validate rule ids / severities
  const rules = (cfg.rules ?? {}) as Record<string, RuleSeverityConfig>;
  const known = /^(TAUT|DRIFT|MOCK|SYS)-\d{3}$/;
  for (const id of Object.keys(rules)) {
    if (!known.test(id)) throw new ConfigError('CONFIG_ERROR', `unknown rule id '${id}' in ${path}`);
    const r = rules[id]!;
    if (typeof r === 'string' && !['error', 'warning', 'info', 'off'].includes(r)) {
      throw new ConfigError('CONFIG_ERROR', `invalid severity '${r}' for rule ${id}`);
    }
  }
  return cfg as unknown as MomusConfig;
}

/** Effective severity for a rule: config override > default. */
export function effectiveSeverity(config: MomusConfig, rule: string, def: 'error' | 'warning' | 'info'): SeverityOrOff {
  const r = config.rules[rule];
  if (!r) return def;
  if (typeof r === 'string') return r as SeverityOrOff;
  return r.severity ?? def;
}

export type SeverityOrOff = 'error' | 'warning' | 'info' | 'off';
