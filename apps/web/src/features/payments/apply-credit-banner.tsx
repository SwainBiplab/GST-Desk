import { PaymentFlowRepo } from '@gst/db';
import { today, type CreditSource } from '@gst/domain';
import { Button, formatPaise, toast } from '@gst/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAppDb, useLiveQuery } from '@/app/db';

const todayIso = () => today(() => new Date());

type Plan = { source: CreditSource; amountPaise: bigint }[];

/**
 * Offered right after issuing an invoice (or bill) for a party that has credit: an advance, or a
 * credit note. The plan uses the oldest credit first and never more than the document owes. It sits
 * above the document rather than over it, so it never blocks what the user does next.
 */
export function ApplyCreditBanner({
  documentId,
  number,
  partyName,
  onClose,
}: {
  documentId: string;
  number: string;
  partyName: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const [busy, setBusy] = useState(false);
  const plan = useLiveQuery<Plan>({
    tables: ['payments', 'payment_allocations', 'documents'],
    key: ['credit-plan', documentId],
    fn: (d, c) => new PaymentFlowRepo(d).planCredit(c, documentId, todayIso()),
  });
  const items = plan.data ?? [];
  const total = items.reduce((n, p) => n + p.amountPaise, 0n);
  if (plan.isSuccess && items.length === 0) return null;

  const apply = async () => {
    if (!database || !ctx) return;
    setBusy(true);
    try {
      await new PaymentFlowRepo(database).applyCredit(
        ctx,
        {
          documentId,
          uses: items.map((p) => ({
            kind: p.source.kind,
            id: p.source.id,
            amountPaise: p.amountPaise,
          })),
        },
        todayIso(),
      );
      toast.success(t('credit.applied', { amount: formatPaise(total), number }));
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      role="status"
      className="flex flex-col gap-2 rounded-md border border-border bg-surface-1 p-3 text-sm"
      data-testid="apply-credit"
    >
      <p className="font-medium">{t('credit.title')}</p>
      <p className="text-fg-muted">
        {t('credit.body', { party: partyName, amount: formatPaise(total), number })}
      </p>
      <ul data-testid="credit-sources">
        {items.map((p) => (
          <li key={p.source.id} className="flex justify-between border-b border-border py-1">
            <span>
              {t(p.source.kind === 'payment' ? 'credit.payment' : 'credit.document', {
                label: p.source.label,
              })}
            </span>
            <span className="tabular">{formatPaise(p.amountPaise)}</span>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button data-testid="credit-apply" disabled={busy} onClick={() => void apply()}>
          {t('credit.apply', { amount: formatPaise(total) })}
        </Button>
        <Button variant="outline" data-testid="credit-skip" onClick={onClose}>
          {t('credit.skip')}
        </Button>
      </div>
    </section>
  );
}
