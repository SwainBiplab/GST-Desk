import base from '@gst/config/eslint';

// Indexed reads are asserted where proven in range; rule signatures keep unused `_args` for the interface.
export default [
  ...base,
  {
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
];
