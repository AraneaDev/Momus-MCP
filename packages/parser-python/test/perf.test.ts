import { describe, expect, it } from 'vitest';
import { PythonParser } from '../src/index.ts';

/**
 * Regression guard (found by the requests dogfood, docs/11): assertion extraction was
 * quadratic — every operand lookup walked the entire tree via `enclosingFunctionStart`,
 * so a 3k-line file with 353 assertions took ~17s to parse (12s over the §2.7 single-file
 * budget). The scope map precompute makes it linear. The smoke ceiling is deliberately
 * loose (slow CI/coverage runners must never flake); a regression to the quadratic walk
 * takes this suite ~10s+ and fails loudly.
 */
function makeSuite(functions: number): string {
  const out = ['from unittest.mock import Mock', ''];
  for (let i = 0; i < functions; i++) {
    out.push(`def test_f${i}():`);
    out.push('    m = Mock()');
    out.push('    m.f.return_value = 1');
    out.push('    assert m.f() == 1');
    out.push('    assert m.f() != 2');
    out.push('');
  }
  return out.join('\n');
}

describe('parser-python perf regression (assertion extraction is linear)', () => {
  it('extracts assertions from a large suite well under the parse budget', { timeout: 30_000 }, () => {
    const source = makeSuite(300);
    const t0 = Date.now();
    const module = new PythonParser().parseModule('/synthetic.py', source, {
      config: undefined,
      resolveImport: () => null,
    });
    const elapsed = Date.now() - t0;
    // Correctness at scale: every planted mock and assertion must be extracted.
    expect(module.mocks).toHaveLength(300);
    expect(module.assertions).toHaveLength(600);
    // docs/02 §2.7 single-file parse budget: 2000ms. Smoke ceiling 5s.
    expect(elapsed).toBeLessThan(5000);
  });
});
