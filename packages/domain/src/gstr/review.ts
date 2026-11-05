/** One period, start to finish: both returns, every issue, and what the Filing Desk card needs. */
import { NO_CHECK_CONTEXT, issueKey, prefilingChecks, type CheckContext } from './checks';
import { buildGstr1 } from './gstr1';
import { buildGstr3b } from './gstr3b';
import type { Gstr1, Gstr3b, GstrDoc, GstrIssue, GstrPeriod, PeriodAdjustment } from './types';
import { crossCheck, validateGstr1, type GstrValidationContext } from './validate';

export interface PeriodReview {
  period: GstrPeriod;
  gstr1: Gstr1;
  gstr3b: Gstr3b;
  /** Errors first, then warnings, each in the order found. Every one has a `key`. */
  issues: GstrIssue[];
  /**
   * Problems still standing: neither fixed nor acknowledged with a reason. The Filing Desk will not
   * export while this is above zero.
   */
  blockers: number;
  /** Any issued document dated in the period (so an empty month is "not started", not "ready"). */
  hasDocuments: boolean;
}

export function reviewPeriod(
  period: GstrPeriod,
  docs: GstrDoc[],
  adjustments: PeriodAdjustment[],
  ctx: GstrValidationContext,
  extra: { checks?: CheckContext; acknowledged?: ReadonlyMap<string, string> } = {},
): PeriodReview {
  const gstr1 = buildGstr1(period, docs);
  const built = buildGstr3b(period, docs, adjustments);
  const found = [
    ...validateGstr1(gstr1, docs, ctx),
    ...built.issues,
    ...crossCheck(gstr1, built.gstr3b),
    ...prefilingChecks(period, docs, extra.checks ?? NO_CHECK_CONTEXT),
  ];
  // the same problem found twice (by two checks) is one problem
  const seen = new Set<string>();
  const all: GstrIssue[] = [];
  for (const i of found) {
    const key = issueKey(i);
    if (seen.has(key)) continue;
    seen.add(key);
    all.push({ ...i, key, acknowledged: extra.acknowledged?.get(key) ?? null });
  }
  const issues = [
    ...all.filter((i) => i.severity === 'error'),
    ...all.filter((i) => i.severity === 'warning'),
  ];
  return {
    period,
    gstr1,
    gstr3b: built.gstr3b,
    issues,
    blockers: issues.filter((i) => !i.acknowledged).length,
    hasDocuments: docs.some(
      (d) => d.status === 'issued' && d.date >= period.from && d.date <= period.to,
    ),
  };
}
