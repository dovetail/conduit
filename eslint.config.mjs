import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

/**
 * Flat ESLint config (ESLint v9). Lints the TypeScript/React sources without
 * type-checking (fast, no tsconfig project needed) — `npm run typecheck` covers
 * type correctness. Rules are kept pragmatic so the check is a useful signal on
 * this codebase rather than a wall of stylistic noise.
 */
export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '**/*.config.{js,mjs,cjs,ts}',
      'scripts/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // `any` is used deliberately at several boundaries (WS payloads, JSON).
      '@typescript-eslint/no-explicit-any': 'off',
      // Non-null assertions are used intentionally after invariant checks.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Allow intentionally-unused args/vars when prefixed with _.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Empty catch/blocks are sometimes intentional (best-effort cleanup).
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // \x1b ANSI-escape handling in log/output parsing is intentional.
      'no-control-regex': 'off',
      // `declare namespace` is used to augment Express Request typing.
      '@typescript-eslint/no-namespace': 'off',
      // Empty interfaces extending a supertype are a common React props pattern.
      '@typescript-eslint/no-empty-object-type': 'off',
      // Cross-runtime dynamic require() (e.g. optional electron) is intentional.
      '@typescript-eslint/no-require-imports': 'off',
    },
  }
)
