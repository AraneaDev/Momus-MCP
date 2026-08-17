import { describe, expect, it } from 'vitest';
import {
  LANGUAGES,
  allExtensions,
  defaultEnabledLanguages,
  defaultTestFilePatterns,
  languageExtensions,
} from '../src/languages.ts';

describe('languages registry', () => {
  it('derives every language list from one table', () => {
    expect(LANGUAGES.typescript.extensions).toEqual(['ts', 'tsx', 'js', 'jsx', 'mts', 'cts']);
    expect(LANGUAGES.python.testFilePatterns).toEqual(['**/test_*.py', '**/*_test.py']);
    expect(languageExtensions('php')).toEqual(['php']);
  });

  it('flattens extensions and test patterns', () => {
    expect(allExtensions()).toContain('py');
    expect(allExtensions()).toContain('php');
    expect(defaultTestFilePatterns()).toContain('**/test_*.py');
    expect(defaultTestFilePatterns()).toContain('**/__tests__/**');
  });

  it('derives enabled-by-default languages', () => {
    const enabled = defaultEnabledLanguages();
    expect(enabled.typescript).toBe(true);
    expect(enabled.php).toBe(false);
    expect(enabled.python).toBe(false);
    expect(enabled.rust).toBe(false);
  });

  it('registers rust with structural (non-filename) test detection', () => {
    expect(LANGUAGES.rust).toEqual({ extensions: ['rs'], testFilePatterns: [], defaultEnabled: false });
  });
});
