import { toast } from '@gst/ui';
import type { TFunction } from 'i18next';
import type { ReactNode } from 'react';

import { dyn } from '@/lib/dyn-key';

export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Report a failure in plain words. */
export const fail = (e: unknown): void => {
  toast.error(errText(e));
};

export function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`flex min-w-40 flex-col gap-1 text-sm ${className ?? ''}`}>
      <span className="text-fg-muted">{label}</span>
      {children}
    </label>
  );
}

export const sectionLabel = (t: TFunction, section: string): string =>
  t(dyn(`directTax.sections.${section}`), { defaultValue: section });

export const natureLabel = (t: TFunction, nature: string): string =>
  t(dyn(`directTax.nature.${nature}`), { defaultValue: nature });

/** `1.00` for 100 basis points. */
export const pct = (bp: number): string => `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 2)}%`;

/** The text of a rule's label when the party only has the code, e.g. for the table of what was recorded. */
export const ruleText = (t: TFunction, r: { section: string; nature: string | null }): string =>
  r.nature ? natureLabel(t, r.nature) : sectionLabel(t, r.section);
