import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { onDisplay, type DisplayMessage } from './hardware';

/**
 * The customer's screen (prompt 52): a second window, fed by the counter over a BroadcastChannel, showing the
 * lines as they are scanned, the total and, after payment, what was paid and the change. It holds nothing and
 * reads nothing: close it and the sale carries on.
 */
export function CustomerDisplay() {
  const { t } = useTranslation();
  const [m, setM] = useState<DisplayMessage | null>(null);
  useEffect(() => onDisplay(setM), []);
  return (
    <main
      className="flex min-h-screen flex-col gap-4 bg-bg p-8"
      data-testid="pos-display"
      aria-live="polite"
    >
      <h1 className="text-3xl font-semibold">{m?.business ?? t('pos.display.welcome')}</h1>
      {m && m.lines.length > 0 ? (
        <table className="w-full text-2xl">
          <tbody>
            {m.lines.map((l, i) => (
              <tr key={i} className="border-b border-border">
                <td className="py-2">{l.name}</td>
                <td className="tabular py-2 text-right text-fg-muted">× {l.qty}</td>
                <td className="tabular py-2 text-right">{l.amount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-2xl text-fg-muted">{t('pos.display.waiting')}</p>
      )}
      <div className="mt-auto flex items-baseline justify-between border-t-2 border-border pt-4">
        <span className="text-3xl">{t('pos.display.total')}</span>
        <span className="tabular text-6xl font-semibold" data-testid="pos-display-total">
          {m?.total ?? '0.00'}
        </span>
      </div>
      {m?.paid && (
        <div
          className="flex items-baseline justify-between text-3xl"
          data-testid="pos-display-paid"
        >
          <span>
            {t('pos.display.paid')} {m.paid.paid}
          </span>
          <span className="font-semibold">
            {t('pos.display.change')} {m.paid.change}
          </span>
        </div>
      )}
    </main>
  );
}
