import base from '@gst/config/eslint';

// Indexed reads are asserted where proven in range (noUncheckedIndexedAccess); `any` is confined to the drizzle proxy.
export default [
  ...base,
  { ignores: ['src/routeTree.gen.ts', 'public'] },
  {
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
