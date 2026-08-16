import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditEngine, CompositeParser, DEFAULT_CONFIG } from '../src/index.ts';
import { PhpParser } from '@momus/parser-php';
import type { LanguageParser } from '../src/parser.ts';

/**
 * Perf budgets (docs/02 §2.7): `verify_mock_drift` workspace (100k LOC) < 2s, peak memory
 * < 200 MB. This is a smoke assert — the ceilings below are deliberately looser than the
 * normative budgets so slow CI/coverage-instrumented runners never flake, while still
 * catching order-of-magnitude regressions (a parse loop that suddenly becomes quadratic,
 * a leaked per-file program, etc.). The generated workspace is deterministic.
 */
function makeWorkspace(root: string, files: number, methodsPerFile: number): number {
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  let lines = 0;
  for (let i = 0; i < files; i++) {
    let prod = `<?php\nnamespace App\\Svc${i};\n`;
    for (let m = 0; m < methodsPerFile; m++) {
      prod += `/** doc ${m} */\npublic function method${m}(int $a, string $b): int { return $a + 1; }\n`;
      lines += 2;
    }
    writeFileSync(join(root, 'src', `Svc${i}.php`), prod);
    const test =
      `<?php\nclass Svc${i}Test extends TestCase {\n` +
      `  public function testM() {\n` +
      `    $svc = $this->createMock(App\\Svc${i}\\Svc${i}::class);\n` +
      `    $svc->method('method0')->willReturn(1);\n` +
      `    $this->assertSame(1, $svc->method0(0));\n` +
      `  }\n}\n`;
    writeFileSync(join(root, 'tests', `Svc${i}Test.php`), test);
    lines += 5;
  }
  return lines;
}

function phpParser(): LanguageParser {
  return new PhpParser();
}

describe('perf budgets (§2.7)', () => {
  it('audits a 100k-LOC workspace well within the time and memory budgets', { timeout: 60_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), 'momus-perf-'));
    try {
      const lines = makeWorkspace(root, 500, 100);
      expect(lines).toBeGreaterThanOrEqual(100_000);

      const engine = new AuditEngine({
        root,
        parser: new CompositeParser([phpParser()]),
        config: {
          ...DEFAULT_CONFIG,
          languages: { typescript: false, php: true },
          cache: { dir: '.momus/cache', enabled: false },
        },
        maxIssues: 0,
      });
      const result = engine.run();

      expect(result.summary.filesAudited).toBe(1000);
      // Normative: < 2s for 100k LOC. Smoke ceiling: 15s covers slow CI + coverage
      // instrumentation without masking an order-of-magnitude regression.
      expect(result.summary.durationMs).toBeLessThan(15_000);
      // Normative: < 200 MB peak. The smoke ceiling is generous; the real signal is
      // that a 100k-LOC workspace does not blow up the heap.
      expect(process.memoryUsage().heapUsed).toBeLessThan(500 * 1024 * 1024);
      // The planted createMock + assertSame(1, ...) echo is a genuine TAUT-002 finding
      // — the perf workspace must still produce correct findings at scale. (`issues` is the
      // maxIssues-truncated view; `totalIssues` is the real count.)
      expect(result.summary.totalIssues).toBe(500);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
