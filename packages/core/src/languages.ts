/**
 * Single source of truth for supported languages (spec docs/02 §2.2.4).
 * Every "language list" in core derives from this table — the `Language` type, config defaults,
 * test-file patterns, and the discovery extension regex — so adding a language is one edit here
 * plus a parser package, instead of several scattered hand-maintained lists.
 */
export const LANGUAGES = {
  typescript: {
    extensions: ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts'],
    testFilePatterns: ['**/*.{test,spec}.{ts,tsx,js,jsx,mjs}', '**/__tests__/**'],
    defaultEnabled: true,
  },
  php: {
    extensions: ['php'],
    testFilePatterns: [],
    defaultEnabled: false,
  },
  python: {
    extensions: ['py'],
    testFilePatterns: ['**/test_*.py', '**/*_test.py'],
    defaultEnabled: false,
  },
} as const;

export type Language = keyof typeof LANGUAGES;

/** The source-file extensions a language's parser claims (for discovery). */
export function languageExtensions(lang: Language): readonly string[] {
  return LANGUAGES[lang].extensions;
}

/** Every source-file extension across all languages (flat, sorted, deduped). */
export function allExtensions(): string[] {
  return [...new Set(Object.values(LANGUAGES).flatMap((l) => l.extensions))].sort();
}

/** Default test-file globs, flattened from the registry in declaration order. */
export function defaultTestFilePatterns(): string[] {
  return Object.values(LANGUAGES).flatMap((l) => l.testFilePatterns);
}

/** Default `languages` config map (opt-in languages default to false). */
export function defaultEnabledLanguages(): Record<Language, boolean> {
  return Object.fromEntries(Object.entries(LANGUAGES).map(([k, l]) => [k, l.defaultEnabled])) as Record<
    Language,
    boolean
  >;
}
