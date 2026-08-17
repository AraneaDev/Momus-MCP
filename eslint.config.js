import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'docs/.vitepress/dist/**',
      'coverage/**',
      '**/test/fixtures/**',
      '**/test/fixtures-syntax-only/**',
      '**/test/syntax-only-fixtures/**',
      'syntax-only-fixtures/**',
      '**/test/golden/fixtures/**',
      'experiments/**',
      '.momus/**',
      '*.sqlite',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      // the codebase intentionally embeds U+200B zero-width spaces in comments to write "*/"
      'no-irregular-whitespace': ['error', { skipComments: true }],
    },
  },
);
