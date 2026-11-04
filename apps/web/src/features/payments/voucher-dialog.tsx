import {
  BusinessAccountRepo,
  DocumentFlowRepo,
  PartyRepo,
  type PaymentListRow,
  type Row,
} from '@gst/db';
import { amountToWordsEn, toDecimalString } from '@gst/domain';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  formatPaise,
} from '@gst/ui';
import { useTranslation } from 'react-i18next';

import { useAppDb, useLiveQuery } from '@/app/db';

interface VoucherMeta {
  paymentId?: string;
  mode?: string;
  reference?: string | null;
  chequeDate?: string | null;
  allocations?: { documentId: string; number: string | null; amountPaise: number }[];
}

const addressLine = (a: unknown): string => {
  if (!a || typeof a !== 'object') return '';
  const x = a as Record<string, string>;
  return [x['line1'], x['line2'], x['city'], x['pincode']].filter(Boolean).join(', ');
};

/**
 * A receipt voucher: who paid, how much, how, and what it settled. Printable, and shareable as a
 * WhatsApp message. A cancelled voucher (its payment was deleted) is stamped and keeps its number.
 */
export function VoucherDialog({ row, onClose }: { row: PaymentListRow; onClose: () => void }) {
  const { t } = useTranslation();
  const { business } = useAppDb();
  const data = useLiveQuery<{ voucher: Row; party: Row | null; accounts: Row[] } | null>({
    tables: ['documents', 'payments', 'business_accounts'],
    key: ['voucher', row.voucherId],
    enabled: !!row.voucherId,
    fn: async (d, c) => {
      const v = await new DocumentFlowRepo(d).get(c, row.voucherId!);
      if (!v) return null;
      return {
        voucher: v,
        party: row.partyId ? await new PartyRepo(d).get(c, row.partyId) : null,
        accounts: await new BusinessAccountRepo(d).forDocuments(c),
      };
    },
  });
  const voucher = data.data?.voucher;
  const meta = (voucher?.['metadata_json'] ?? {}) as VoucherMeta;
  const kind = t('pay.credit');
  const cancelled = voucher?.['status'] === 'cancelled';
  const revision = Number(voucher?.['revision'] ?? 1);
  const businessName = String(business?.['trade_name'] ?? business?.['legal_name'] ?? '');
  const phone = String(data.data?.party?.['phone'] ?? '').replace(/\D/g, '');

  const share = () => {
    const text = t('voucher.shareText', {
      party: row.partyName,
      amount: formatPaise(row.amountPaise),
      date: row.date,
      number: row.voucherNumber ?? '',
      business: businessName,
    });
    window.open(
      `https://wa.me/${phone ? `91${phone.slice(-10)}` : ''}?text=${encodeURIComponent(text)}`,
      '_blank',
      'noopener',
    );
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-auto" data-testid="voucher-dialog">
        <DialogTitle className="text-lg font-semibold print:hidden">
          {t('voucher.title')}
        </DialogTitle>
        <DialogDescription className="sr-only">{row.voucherNumber}</DialogDescription>
        {voucher && (
          <article
            id="print-area"
            data-testid="voucher-sheet"
            className="relative bg-white p-6 text-[13px] leading-snug text-black"
          >
            {cancelled && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 flex items-center justify-center"
                data-testid="voucher-cancelled"
              >
                <span className="-rotate-[20deg] rounded border-4 border-red-600/50 px-4 py-1 text-5xl font-bold text-red-600/50">
                  {t('voucher.cancelled')}
                </span>
              </div>
            )}
            <header className="flex justify-between gap-4 border-b border-black pb-2">
              <div>
                <h2 className="text-base font-bold">{businessName}</h2>
                <p>{addressLine(business?.['address'])}</p>
                {business?.['gstin'] && <p>GSTIN: {String(business['gstin'])}</p>}
              </div>
              <div className="text-right">
                <h3 className="text-sm font-bold uppercase">{t('voucher.title')}</h3>
                <p data-testid="voucher-number">{String(voucher['number'] ?? '')}</p>
                <p>{String(voucher['date'])}</p>
                {revision > 1 && <p>{t('voucher.revision', { n: revision })}</p>}
              </div>
            </header>

            <p className="pt-3">{t('voucher.receivedFrom')}</p>
            <p className="text-base font-semibold" data-testid="voucher-party">
              {row.partyName}
            </p>

            <p className="pt-3 text-xl font-bold" data-testid="voucher-amount">
              ₹ {toDecimalString(row.amountPaise)}
            </p>
            <p className="text-gray-700">
              {t('voucher.inWords')}: {amountToWordsEn(row.amountPaise)}
            </p>

            <p className="pt-3">
              {t('voucher.mode')}:{' '}
              {t(`pay.modes.${meta.mode ?? row.mode}`, { defaultValue: meta.mode ?? row.mode })}
              {meta.reference ? ` · ${t('voucher.reference')}: ${meta.reference}` : ''}
              {meta.chequeDate ? ` (${meta.chequeDate})` : ''}
            </p>

            {(meta.allocations?.length ?? 0) > 0 && (
              <table className="mt-3 w-full border-collapse" data-testid="voucher-towards">
                <thead>
                  <tr className="border-y border-black text-left">
                    <th className="py-1">{t('voucher.towards')}</th>
                    <th className="text-right">{t('voucher.amount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {meta.allocations!.map((a) => (
                    <tr key={a.documentId} className="border-b border-gray-300">
                      <td className="py-1">{a.number ?? ''}</td>
                      <td className="text-right">{toDecimalString(BigInt(a.amountPaise))}</td>
                    </tr>
                  ))}
                  {row.unallocatedPaise > 0n && (
                    <tr>
                      <td className="py-1">{t('voucher.advance', { kind })}</td>
                      <td className="text-right">{toDecimalString(row.unallocatedPaise)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}

            {(data.data?.accounts.length ?? 0) > 0 && (
              <div className="pt-3 text-xs text-gray-700">
                {t('voucher.bank')}:{' '}
                {data
                  .data!.accounts.map((a) =>
                    a['kind'] === 'upi'
                      ? `${a['name']} ${a['upi_id']}`
                      : `${a['name']}${a['account_no'] ? ` ${a['account_no']}` : ''}${a['ifsc'] ? ` ${a['ifsc']}` : ''}`,
                  )
                  .join(' · ')}
              </div>
            )}
            <p className="pt-10 text-right text-xs">{t('voucher.signature')}</p>
          </article>
        )}
        <div className="flex justify-end gap-2 print:hidden">
          <Button variant="outline" data-testid="voucher-share" onClick={share}>
            {t('voucher.share')}
          </Button>
          <Button data-testid="voucher-print" onClick={() => window.print()}>
            {t('voucher.print')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
