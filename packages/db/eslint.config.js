import base from '@gst/config/eslint';

// Repositories are dialect-agnostic over Drizzle's sqlite/pg builders, so `any` is deliberate here (ADR 0002).
export default [
  ...base,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];
