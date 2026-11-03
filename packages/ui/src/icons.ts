import type { LucideProps } from 'lucide-react';

export * from 'lucide-react';

/** Fixed icon size scale (px). Use these instead of ad-hoc numbers. */
export const iconSize = { xs: 12, sm: 14, md: 16, lg: 20, xl: 24 } as const;
export type IconSize = keyof typeof iconSize;
export type { LucideProps };
