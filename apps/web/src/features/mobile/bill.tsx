/**
 * Billing on a phone (prompt 43, FR-140): the same editor state as the desktop (`useDocumentEditor`,
 * priced by the engine on every change, autosaved), shaped for one hand: a party row, a list of lines
 * with a quantity stepper, an item sheet with favourites and the barcode, voice entry, a sticky total
 * with the Issue button, and after issuing the UPI QR for the customer and the PDF two taps from
 * WhatsApp.
 */
import type { Row } from '@gst/db';
import { isBlankLine, emptyDraftLine, type DocumentType } from '@gst/domain';
import { Button, Input, formatPaise, toast } from '@gst/ui';
import { Minus, Plus, Printer, Share2 } from '@gst/ui/icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { adoptedIds } from '../documents/adopt';
import {
  applyItem,
  applyParty,
  newLineKey,
  paiseText,
  removeLines,
  setCell,
  updateLine,
  withTrailingBlank,
} from '../documents/state';
import { defaultSaleFor, useDocumentEditor } from '../documents/use-editor';
import { useDefaultUpi } from '../parties/hooks';

import { ItemSheet } from './item-sheet';
import { qtyLabel, stepQty, upiLink } from './logic';
import { PartySheet } from './party-sheet';
import { useBillPdf } from './pdf';
import { printReceipt } from './print';
import { SwipeRow } from './swipe';
import { UpiQr } from './upi-qr';
import { VoiceEntry } from './voice';

import { useConfirm } from '@/app/components/confirm';
import { useAppDb } from '@/app/db';
import { useAppNavigate, useLocationInfo } from '@/app/hooks';
import { btPrintingSupported } from '@/platform/printer';

const TYPES: readonly string[] = [
  'tax_invoice',
  'bill_of_supply',
  'proforma',
  'quotation',
  'credit_note',
  'debit_note',
  'delivery_challan',
  'purchase_bill',
  'purchase_return',
  'expense',
];

interface Mounted {
  id: string | null;
  type: DocumentType;
  /** Counts mounts, so the same address opened again is a fresh editor. */
  n: number;
  stamp: string;
}

/**
 * `?type=&id=` open the bill; `fresh` or `voice` on the address start a new editor on purpose. A new
 * bill gets its id on the first autosave and the editor writes it into the address: that id is adopted
 * by the mounted editor (as the desktop's `EditorRoute` does), never a reason to start again.
 */
export function MobileBillRoute() {
  const { search } = useLocationInfo();
  const { business, ctx } = useAppDb();
  const id = typeof search['id'] === 'string' ? search['id'] : null;
  const asked = typeof search['type'] === 'string' ? search['type'] : '';
  const type = (TYPES.includes(asked) ? asked : defaultSaleFor(business)) as DocumentType;
  const stamp = `${String(search['fresh'] ?? '')}:${String(search['voice'] ?? '')}`;
  const [m, setM] = useState<Mounted>({ id, type, n: 0, stamp });
  const adopted = m.id === null && id !== null && adoptedIds.has(id);
  if (adopted) setM({ ...m, id });
  else if (m.id !== id || (id === null && (m.type !== type || m.stamp !== stamp)))
    setM({ id, type, n: m.n + 1, stamp });
  if (!ctx || !business) return null;
  return <MobileBill key={m.n} type={m.type} id={m.id} />;
}

function MobileBill({ type, id }: { type: DocumentType; id: string | null }) {
  const { t } = useTranslation();
  const navigate = useAppNavigate();
  const confirm = useConfirm();
  const { business } = useAppDb();
  const editor = useDocumentEditor({ type, id, shell: 'shop' });
  const { draft, built, meta } = editor;
  const pdf = useBillPdf({ draft, built, meta, currentId: editor.currentId });
  const upi = useDefaultUpi();
  const [sheet, setSheet] = useState<'party' | 'item' | null>(null);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const businessState = String(business?.['state_code'] ?? '');
  const lines = draft.lines.filter((l) => !isBlankLine(l));
  const number = issued ?? meta.number;
  const done = meta.status !== 'draft' || issued !== null;

  const addItem = (item: Row, qtyMicros: bigint) => {
    editor.setDraft((d) =>
      withTrailingBlank({
        ...d,
        lines: [
          ...d.lines.filter((l) => !isBlankLine(l)),
          { ...applyItem(emptyDraftLine(newLineKey()), item, d.type), qtyMicros },
        ],
      }),
    );
    setSheet(null);
  };
  const addText = (text: string) => {
    editor.setDraft((d) =>
      withTrailingBlank({
        ...d,
        lines: [
          ...d.lines.filter((l) => !isBlankLine(l)),
          { ...emptyDraftLine(newLineKey()), description: text },
        ],
      }),
    );
    setSheet(null);
  };
  const setQty = (key: string, qtyMicros: bigint) =>
    editor.setDraft((d) => updateLine(d, key, (l) => ({ ...l, qtyMicros })));
  const setRate = (key: string, text: string) =>
    editor.setDraft((d) =>
      updateLine(
        d,
        key,
        (l) =>
          setCell(l, 'rate', text, { discountMode: d.discountMode, unitsByCode: new Map() }).line,
      ),
    );

  const issue = async () => {
    setBusy(true);
    setProblems([]);
    try {
      let r = await editor.issue();
      if (r.stock?.action === 'block') {
        toast.error(t('docs.stock.blocked'));
        return;
      }
      if (r.stock?.action === 'warn') {
        if (!(await confirm({ title: t('docs.stock.warnTitle') }))) return;
        r = await editor.issue(undefined, { stockOk: true });
      }
      if (r.locked) {
        toast.error(t('mobile.bill.locked'));
        return;
      }
      if (r.issues.length) {
        setProblems(
          r.issues.map((i) =>
            t(`docs.issue.${i.code}` as never, { line: (i.line ?? 0) + 1, defaultValue: i.code }),
          ),
        );
        return;
      }
      if (r.number) setIssued(r.number);
    } finally {
      setBusy(false);
    }
  };

  const share = async () => {
    setBusy(true);
    try {
      const out = await pdf.share(number ? { number } : undefined);
      if (out === 'shared') toast.success(t('mobile.bill.shareDone'));
      else if (out === 'fallback') toast.info(t('mobile.bill.shareFallback'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const print = async () => {
    setBusy(true);
    try {
      const r = await pdf.make(number ? { number } : undefined);
      const out = await printReceipt(r.model, r.spec);
      if (out === 'no_printer') toast.error(t('mobile.bill.printNoPrinter'));
      else toast.success(t('mobile.bill.printed'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (editor.loading)
    return (
      <p className="p-4 text-fg-muted" data-testid="bill-loading">
        …
      </p>
    );
  if (editor.notFound) return <p className="p-4 text-fg-muted">{t('docs.notFound')}</p>;

  if (done) {
    const link =
      upi && number
        ? upiLink({
            upiId: upi,
            payee: String(business?.['trade_name'] || business?.['legal_name'] || ''),
            amountPaise: built.totals.totalPaise,
            note: number,
          })
        : null;
    return (
      <div className="flex flex-col items-center gap-3 text-center" data-testid="bill-done">
        <p className="text-sm text-fg-muted">
          {t('mobile.bill.issued')} · {draft.partyName || t('mobile.bill.noParty')}
        </p>
        <p className="text-2xl font-semibold" data-testid="bill-number">
          {number}
        </p>
        <p className="tabular text-xl" data-testid="bill-total">
          {formatPaise(built.totals.totalPaise)}
        </p>
        {link ? (
          <>
            <UpiQr link={link} label={t('mobile.bill.scanToPay')} />
            <p className="text-xs text-fg-muted">{t('mobile.bill.scanToPay')}</p>
          </>
        ) : (
          <p className="text-xs text-fg-muted" data-testid="bill-no-upi">
            {t('mobile.bill.upiNone')}
          </p>
        )}
        <div className="grid w-full grid-cols-2 gap-2">
          <Button
            className="min-h-12"
            data-testid="bill-share"
            disabled={busy || !pdf.ready}
            onClick={() => void share()}
          >
            <Share2 size={18} aria-hidden />
            {t('mobile.bill.share')}
          </Button>
          {btPrintingSupported() && (
            <Button
              variant="secondary"
              className="min-h-12"
              data-testid="bill-print"
              disabled={busy}
              onClick={() => void print()}
            >
              <Printer size={18} aria-hidden />
              {t('mobile.bill.print')}
            </Button>
          )}
          <Button
            variant="outline"
            className="col-span-2 min-h-12"
            data-testid="bill-new"
            onClick={() => navigate('/shop/sell', { type: draft.type, fresh: Date.now() })}
          >
            {t('mobile.bill.newBill')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 pb-28" data-testid="bill-editor">
      <button
        type="button"
        className="flex min-h-12 w-full items-center justify-between rounded-md border border-border px-3 text-left"
        data-testid="bill-party"
        onClick={() => setSheet('party')}
      >
        <span className="truncate font-medium">
          {draft.partyName || t('mobile.bill.chooseParty')}
        </span>
        <span className="text-xs text-fg-muted">
          {draft.partyName ? t('mobile.bill.changeParty') : ''}
        </span>
      </button>

      <ul className="flex flex-col gap-2" data-testid="bill-lines">
        {lines.map((l, i) => {
          const total = built.lines[i]?.result.totalPaise ?? 0n;
          return (
            <li key={l.key}>
              <SwipeRow
                testId="bill-line"
                className="rounded-md border border-border"
                actions={[
                  {
                    id: 'remove',
                    label: t('mobile.bill.remove'),
                    tone: 'danger',
                    run: () => editor.setDraft((d) => removeLines(d, new Set([l.key]))),
                  },
                ]}
              >
                <div className="flex flex-col gap-1 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{l.description}</span>
                    <span className="tabular text-sm font-semibold" data-testid="line-total">
                      {formatPaise(Number(total))}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      inputMode="decimal"
                      className="w-24"
                      aria-label={t('mobile.bill.rate')}
                      data-testid="line-rate"
                      defaultValue={paiseText(l.ratePaise)}
                      onBlur={(e) => setRate(l.key, e.target.value)}
                    />
                    <div className="ml-auto flex items-center gap-1">
                      <Button
                        variant="outline"
                        className="h-10 w-10 px-0"
                        aria-label={t('mobile.bill.less')}
                        data-testid="line-minus"
                        onClick={() => setQty(l.key, stepQty(l.qtyMicros, -1))}
                      >
                        <Minus size={18} aria-hidden />
                      </Button>
                      <span
                        className="tabular min-w-8 text-center text-base"
                        data-testid="line-qty"
                      >
                        {qtyLabel(l.qtyMicros)}
                      </span>
                      <Button
                        variant="outline"
                        className="h-10 w-10 px-0"
                        aria-label={t('mobile.bill.more')}
                        data-testid="line-plus"
                        onClick={() => setQty(l.key, stepQty(l.qtyMicros, 1))}
                      >
                        <Plus size={18} aria-hidden />
                      </Button>
                    </div>
                  </div>
                </div>
              </SwipeRow>
            </li>
          );
        })}
      </ul>
      {lines.length === 0 && (
        <p className="text-sm text-fg-muted" data-testid="bill-empty">
          {t('mobile.bill.noLines')}
        </p>
      )}
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <Button
          variant="secondary"
          className="min-h-12"
          data-testid="bill-add-item"
          onClick={() => setSheet('item')}
        >
          <Plus size={18} aria-hidden />
          {t('mobile.bill.addItem')}
        </Button>
        <VoiceEntry type={draft.type} />
      </div>
      {problems.length > 0 && (
        <ul
          className="rounded-md border border-danger/40 bg-danger/10 p-2 text-sm"
          data-testid="bill-problems"
        >
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div
        className="fixed inset-x-0 bottom-14 border-t border-border bg-surface-1 px-3 py-2"
        style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
        data-testid="bill-sticky"
      >
        <div className="flex items-baseline justify-between text-xs text-fg-muted">
          <span>
            {t('mobile.bill.tax')}: {formatPaise(Number(built.totals.taxPaise))}
          </span>
          <span data-testid="bill-save-state">
            {t(`mobile.bill.save.${editor.saveState}` as never)}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="tabular grow text-xl font-semibold" data-testid="bill-sticky-total">
            {formatPaise(Number(built.totals.totalPaise))}
          </span>
          <Button
            className="min-h-12 px-6 text-base"
            data-testid="bill-issue"
            disabled={busy || lines.length === 0}
            onClick={() => void issue()}
          >
            {busy ? t('mobile.bill.issuing') : t('mobile.bill.issue')}
          </Button>
        </div>
      </div>

      {sheet === 'party' && (
        <PartySheet
          type={draft.type}
          onClose={() => setSheet(null)}
          onPick={(p) => {
            editor.setDraft((d) => applyParty(d, p, { businessState }));
            setSheet(null);
          }}
        />
      )}
      {sheet === 'item' && (
        <ItemSheet
          type={draft.type}
          onClose={() => setSheet(null)}
          onPick={addItem}
          onText={addText}
        />
      )}
    </div>
  );
}
