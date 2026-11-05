/** One period, start to finish: both returns, every issue, and what the Filing Desk card needs. */
import { buildGstr1 } from './gstr1';
import { buildGstr3b } from './gstr3b';
import type { Gstr1, Gstr3b, GstrDoc, GstrIssue, GstrPeriod, PeriodAdjustment } from './types';
import { blockers, crossCheck, validateGstr1, type GstrValidationContext } from './validate';

export interface PeriodReview {
  period: GstrPeriod;
  gstr1: Gstr1;
  gstr3b: Gstr3b;
  /** Errors first, then warnings, each in the order found. */
  issues: GstrIssue[];
  blockers: number;
  /** Any issued document dated in the period (so an empty month is "not started", not "ready"). */
  hasDocuments: boolean;
}

export function reviewPeriod(
  period: GstrPeriod,
  docs: GstrDoc[],
  adjustments: PeriodAdjustment[],
  ctx: GstrValidationContext,
): PeriodReview {
  const gstr1 = buildGstr1(period, docs);
  const built = buildGstr3b(period, docs, adjustments);
  const all = [
    ...validateGstr1(gstr1, docs, ctx),
    ...built.issues,
    ...crossCheck(gstr1, built.gstr3b),
  ];
  const issues = [
    ...all.filter((i) => i.severity === 'error'),
    ...all.filter((i) => i.severity === 'warning'),
  ];
  return {
    period,
    gstr1,
    gstr3b: built.gstr3b,
    issues,
    blockers: blockers(issues),
    hasDocuments: docs.some(
      (d) => d.status === 'issued' && d.date >= period.from && d.date <= period.to,
    ),
  };
}
