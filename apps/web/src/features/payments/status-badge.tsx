import type { DocPosition } from '@gst/db';
import { Badge } from '@gst/ui';
import { useTranslation } from 'react-i18next';

const TONE = { unpaid: 'neutral', partial: 'warning', paid: 'success', overpaid: 'info' } as const;

/** Unpaid, partly paid, paid or overpaid, with an overdue badge when something late is still owed. */
export function PayStatusBadge({ position }: { position: DocPosition | undefined }) {
  const { t } = useTranslation();
  if (!position) return null;
  return (
    <span
      className="inline-flex flex-wrap gap-1"
      data-testid="pay-status"
      data-status={position.status}
    >
      <Badge tone={TONE[position.status]}>{t(`paystatus.${position.status}`)}</Badge>
      {position.overdueDays > 0 && (
        <Badge tone="danger" data-testid="pay-overdue">
          {t('paystatus.overdue', { days: position.overdueDays })}
        </Badge>
      )}
    </span>
  );
}
