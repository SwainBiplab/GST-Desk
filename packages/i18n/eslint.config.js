import base from '@gst/config/eslint';

// Indexed reads and map lookups are asserted where they are proven in range (noUncheckedIndexedAccess).
export default [...base, { rules: { '@typescript-eslint/no-non-null-assertion': 'off' } }];
