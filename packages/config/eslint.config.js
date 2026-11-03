import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import importPlugin from 'eslint-plugin-import';

export default tseslint.config(
  {
    ignores: [
      'storybook-static',
      '.storybook',
      'stories',
      'dist',
      'coverage',
      'src-tauri',
      'playwright-report',
      'test-results',
      '*.config.*',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { react, 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y, import: importPlugin },
    settings: { react: { version: '19.0' } },
    rules: {
      ...react.configs.recommended.rules,
      ...react.configs['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      'react/prop-types': 'off',
      'jsx-a11y/heading-has-content': 'off',
      'react-hooks/incompatible-library': 'off',
      'import/order': ['error', { 'newlines-between': 'always', alphabetize: { order: 'asc' } }],
    },
  },
  {
    files: ['**/*.test.{ts,tsx}', '**/*.spec.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
