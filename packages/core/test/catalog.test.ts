import { describe, expect, it } from 'vitest';
import { RULES_CATALOG } from '../src/catalog.ts';

describe('RULES_CATALOG', () => {
  it('lists all 14 rules including DRIFT-004 and DRIFT-006', () => {
    const ids = RULES_CATALOG.map((r) => r.id);
    expect(ids).toHaveLength(14);
    expect(ids).toContain('DRIFT-004');
    expect(ids).toContain('DRIFT-006');
  });

  it('carries the normative severities', () => {
    expect(RULES_CATALOG.find((r) => r.id === 'DRIFT-004')?.severity).toBe('error');
    expect(RULES_CATALOG.find((r) => r.id === 'DRIFT-006')?.severity).toBe('warning');
    expect(RULES_CATALOG.find((r) => r.id === 'MOCK-002')?.severity).toBe('info');
  });
});
