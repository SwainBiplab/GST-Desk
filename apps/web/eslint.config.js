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
  {
    // Words a person reads go through t(), so they can be translated: no text typed straight into JSX.
    files: ['src/**/*.tsx'],
    ignores: ['src/**/*.test.tsx', 'src/routes/books/*kit.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXText[value=/[A-Za-z]{2,}/]',
          message: 'Put this text in the catalogue and use t(): it must be translatable.',
        },
        {
          selector: 'JSXExpressionContainer > Literal[value=/[A-Za-z]{2,}/]',
          message: 'Put this text in the catalogue and use t(): it must be translatable.',
        },
        {
          selector:
            'JSXAttribute[name.name=/^(aria-label|title|placeholder|alt|label)$/] > Literal[value=/[A-Za-z]{2,}/]',
          message: 'Put this text in the catalogue and use t(): it must be translatable.',
        },
      ],
    },
  },
];
