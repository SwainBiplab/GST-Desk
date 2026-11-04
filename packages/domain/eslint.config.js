import base from '@gst/config/eslint';

// `noUncheckedIndexedAccess` makes indexed reads `T | undefined`; where an index is proven in range we assert it.
export default [...base, { rules: { '@typescript-eslint/no-non-null-assertion': 'off' } }];
