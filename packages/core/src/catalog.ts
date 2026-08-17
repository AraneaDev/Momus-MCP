/**
 * Single source of truth for the rule catalog (spec docs/03 §3, docs/06 §6.4).
 * Both the CLI `momus rules` command and the MCP `list_rules` tool read this list, so the
 * two surfaces can never drift apart again (they diverged at 12 vs 14 rules when DRIFT-004
 * and DRIFT-006 were added to the server list only).
 */
import type { RuleId, Severity } from './ir.ts';

export interface RuleCatalogEntry {
  id: RuleId;
  name: string;
  severity: Severity;
  description: string;
}

export const RULES_CATALOG: readonly RuleCatalogEntry[] = [
  {
    id: 'TAUT-001',
    name: 'self-comparison',
    severity: 'error',
    description: 'assertion compares an expression with itself',
  },
  {
    id: 'TAUT-002',
    name: 'mock-echo',
    severity: 'error',
    description: "assertion re-asserts a stub's own configured return",
  },
  {
    id: 'TAUT-003',
    name: 'constant-tautology',
    severity: 'error',
    description: 'both assertion sides are compile-time constants',
  },
  {
    id: 'TAUT-004',
    name: 'mock-only-assertion',
    severity: 'warning',
    description: 'test exercises no production code',
  },
  {
    id: 'TAUT-005',
    name: 'zero-reach-stub',
    severity: 'warning',
    description: 'mock configured but never invoked or asserted',
  },
  {
    id: 'TAUT-006',
    name: 'unconfigured-spy-assert',
    severity: 'warning',
    description: 'toHaveBeenCalled* on a spy with no stub and no call path',
  },
  {
    id: 'DRIFT-001',
    name: 'missing-member',
    severity: 'error',
    description: 'stubbed member does not exist on the production target',
  },
  {
    id: 'DRIFT-002',
    name: 'signature-mismatch',
    severity: 'warning',
    description: 'stub call signature diverges from production (arity)',
  },
  {
    id: 'DRIFT-003',
    name: 'return-type-mismatch',
    severity: 'warning',
    description: 'configured value not assignable to the production return type',
  },
  {
    id: 'DRIFT-004',
    name: 'constructor-drift',
    severity: 'error',
    description: 'double construction omits required constructor parameters (PHP)',
  },
  {
    id: 'DRIFT-005',
    name: 'missing-export',
    severity: 'error',
    description: 'vi.mock factory keys reference exports that do not exist',
  },
  {
    id: 'DRIFT-006',
    name: 'stale-mock',
    severity: 'warning',
    description: 'mock target changed since the base ref but the mock file was not updated (git-diff mode)',
  },
  { id: 'MOCK-001', name: 'mock-saturation', severity: 'warning', description: 'over-mocking heuristic' },
  {
    id: 'MOCK-002',
    name: 'mock-of-self',
    severity: 'info',
    description: 'the test mocks a module it also imports as the SUT',
  },
];
