import js from '@eslint/js'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // Turn off base rules that conflict with TS
      'no-unused-vars': 'off',
      'no-undef': 'off',
      'no-redeclare': 'off',

      // TypeScript rules
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],

      // General
      'no-console': 'off',
      'prefer-const': 'warn',
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      // Standalone node scripts rely on node globals.
      'no-undef': 'off',
    },
  },
  {
    files: ['scripts/**/*.ts'],
    rules: {
      // Operational scripts are intentionally pragmatic and not part of runtime path.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'prefer-const': 'off',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'contracts/**', 'data/**', 'scripts/tmp-*'],
  },
]
