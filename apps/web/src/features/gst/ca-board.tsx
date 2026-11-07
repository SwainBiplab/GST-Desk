/**
 * The CA's board (prompt 46): every business of every organisation the account belongs to, a cell per period and
 * return coloured by state, and the exceptions that need a look. Read from the cloud; nothing here changes a book.
 */
import { Badge, Card, formatPaise } from '@gst/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  readSession,
  CloudClient,
  type BoardCell,
  type FilingBoard,
} from '@/features/cloud/client';
import { browserStore } from '@/features/team/source';
import { dyn } from '@/lib/dyn-key';

const COLOUR: Record<BoardCell['status'], string> = {
  filed: 'bg-success/30',
  pushed: 'bg-info/30',
  exported: 'bg-info/15',
  late: 'bg-danger/40',
  open: 'bg-surface-2',
};

export function CaBoardPage() {
  const { t } = useTranslation();
  const session = readSession(browserStore.get);
  const [board, setBoard] = useState<FilingBoard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    void new CloudClient(session.baseUrl, session.token)
      .filingBoard()
      .then(setBoard, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [session?.baseUrl, session?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!session)
    return (
      <div className="p-4">
        <p className="text-sm text-fg-muted" data-testid="board-signed-out">
          {t('filing.board.signedOut')}
        </p>
      </div>
    );
  const exceptions = (board?.rows ?? [])
    .flatMap((r) => r.exceptions.map((e) => ({ r, e })))
    .sort((a, b) => b.e.amount - a.e.amount);
  return (
    <div className="flex flex-col gap-4 p-4" data-testid="ca-board">
      <h1 className="text-xl font-semibold">{t('filing.board.title')}</h1>
      <p className="text-sm text-fg-muted">{t('filing.board.help')}</p>
      {error && <p className="text-sm text-danger">{error}</p>}
      {board && board.rows.length === 0 && (
        <p className="text-sm text-fg-muted" data-testid="board-empty">
          {t('filing.board.none')}
        </p>
      )}
      {board && board.rows.length > 0 && (
        <>
          <Card className="overflow-auto p-3">
            <table className="w-full text-sm" data-testid="board-table">
              <thead>
                <tr className="text-left text-xs text-fg-muted">
                  <th className="pr-3">{t('filing.board.client')}</th>
                  {board.periods.map((p) => (
                    <th
                      key={p}
                      className="px-1 text-center"
                      colSpan={2}
                    >{`${p.slice(0, 2)}/${p.slice(2)}`}</th>
                  ))}
                </tr>
                <tr className="text-xs text-fg-muted">
                  <th />
                  {board.periods.flatMap((p) =>
                    ['gstr1', 'gstr3b'].map((ret) => (
                      <th key={`${p}${ret}`} className="px-0.5 text-center font-normal">
                        {ret === 'gstr1' ? '1' : '3B'}
                      </th>
                    )),
                  )}
                </tr>
              </thead>
              <tbody>
                {board.rows.map((r) => (
                  <tr key={r.businessId} data-testid="board-row">
                    <td className="py-1 pr-3">
                      <div className="font-medium">{r.businessName}</div>
                      <div className="text-xs text-fg-muted">
                        {r.orgName} · {r.gstin}
                      </div>
                    </td>
                    {board.periods.flatMap((p) =>
                      (['gstr1', 'gstr3b'] as const).map((ret) => {
                        const c = r.cells.find((x) => x.fp === p && x.ret === ret);
                        return (
                          <td key={`${p}${ret}`} className="px-0.5">
                            {c ? (
                              <div
                                className={`mx-auto h-6 w-8 rounded ${COLOUR[c.status]}`}
                                data-testid="board-cell"
                                data-status={c.status}
                                data-period={p}
                                data-ret={ret}
                                title={`${t(dyn(`filing.board.status.${c.status}`))} · ${t('filing.due', { date: c.due })}${c.lateFeePaise > 0 ? ` · ${t('filing.lateFee', { days: c.overdueDays, fee: formatPaise(c.lateFeePaise) })}` : ''}`}
                              />
                            ) : null}
                          </td>
                        );
                      }),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="flex flex-wrap gap-3 pt-2 text-xs" aria-label={t('filing.board.legend')}>
              {(['filed', 'pushed', 'exported', 'late', 'open'] as const).map((s) => (
                <li key={s} className="flex items-center gap-1">
                  <span className={`inline-block h-3 w-4 rounded ${COLOUR[s]}`} />
                  {t(dyn(`filing.board.status.${s}`))}
                </li>
              ))}
            </ul>
          </Card>
          <Card className="p-3" data-testid="board-exceptions">
            <h2 className="pb-2 font-medium">{t('filing.board.exceptions')}</h2>
            {exceptions.length === 0 && (
              <p className="text-sm text-fg-muted">{t('filing.board.noExceptions')}</p>
            )}
            <ul className="flex flex-col gap-1 text-sm">
              {exceptions.map(({ r, e }, i) => (
                <li
                  key={`${r.businessId}${e.kind}${i}`}
                  className="flex flex-wrap items-center gap-2"
                  data-testid="board-exception"
                >
                  <Badge tone={e.kind === 'overdue' ? 'danger' : 'warning'}>
                    {t(dyn(`filing.board.kind.${e.kind}`))}
                  </Badge>
                  <span className="font-medium">{r.businessName}</span>
                  <span className="text-fg-muted">{e.message}</span>
                </li>
              ))}
            </ul>
          </Card>
          <p className="text-xs text-fg-muted">{t('filing.lateFeeNote')}</p>
        </>
      )}
    </div>
  );
}
