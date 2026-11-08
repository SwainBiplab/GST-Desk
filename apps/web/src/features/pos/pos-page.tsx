import {
  ItemRepo,
  PartyRepo,
  PosRepo,
  SerialRepo,
  type Counter,
  type HeldBill,
  type Row,
  type ShiftReport,
} from '@gst/db';
import {
  WedgeParser,
  buildDocument,
  parseQtyMicros,
  today,
  type DraftLine,
  type Tender,
  type ZReport,
} from '@gst/domain';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  formatPaise,
  toast,
} from '@gst/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CustomerDisplay } from './customer-display';
import {
  CashDialog,
  CloseShiftDialog,
  focusOnMount,
  OpenShiftCard,
  PayDialog,
  PosSettingsDialog,
  RecallDialog,
  ReturnDialog,
  ZReportView,
} from './dialogs';
import {
  connectScale,
  kickDrawer,
  openDisplayWindow,
  postDisplay,
  printHtml,
  printReceipt,
  scaleSupported,
} from './hardware';
import {
  addToCart,
  cartDraft,
  parsePercentBp,
  qtyLabel,
  removeLine,
  resolveCode,
  setLineDiscount,
  setLineQty,
  toWedgeConfig,
  trackingOf,
  type CartContext,
} from './model';
import {
  savePosSettings,
  useCounters,
  useHeld,
  useItems,
  usePosSettings,
  useQuickItems,
  useReceiptMaker,
  useShift,
} from './use-pos';

import { useAppDb, useLiveQuery } from '@/app/db';
import { useLocationInfo } from '@/app/hooks';
import type { Shell } from '@/app/store';
import { useFeatureFlags } from '@/features/business/hooks';
import { useDefaultUpi } from '@/features/parties/hooks';
import { useCan } from '@/features/team/permissions';
import { dyn } from '@/lib/dyn-key';
import { barcodeSupported, scanBarcode } from '@/platform/barcode';

/** The unit a scale reads in: a symbol, the same in every language. */
const UNIT_KG = 'kg';
const money = (p: bigint | number) => formatPaise(Number(p));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const storeKey = (businessId: string) => `pos.counter.${businessId}`;

type DialogName =
  'pay' | 'recall' | 'return' | 'cash' | 'xreport' | 'settings' | 'customer' | 'counter' | null;

/** The counter: scan, pay, hold, return, close. Shop mode's `pos` page; `?display=1` is the customer's screen. */
export function PosPage({ shell }: { shell: Shell }) {
  const { search } = useLocationInfo();
  void shell;
  return String(search['display']) === '1' ? <CustomerDisplay /> : <Counter />;
}

function Counter() {
  const { t } = useTranslation();
  const { database, ctx, business } = useAppDb();
  const flags = useFeatureFlags();
  const canApprove = useCan('sales', 'approve');
  const settings = usePosSettings();
  const counters = useCounters();
  const { items, index } = useItems();
  const quick = useQuickItems(items);
  const upiId = useDefaultUpi();

  const businessId = String(business?.['id'] ?? '');
  const [picked, setPicked] = useState<string | null>(() => {
    try {
      return localStorage.getItem(storeKey(businessId));
    } catch {
      return null;
    }
  });
  const list = counters.data;
  const counter: Counter | null = list
    ? (list.find((c) => c.id === picked) ?? list[0] ?? null)
    : null;
  const shiftQuery = useShift(counter?.id ?? null);
  const shift = shiftQuery.data ?? null;
  const held = useHeld(counter?.id ?? null).data ?? [];
  const makeReceipt = useReceiptMaker(counter?.documentType ?? 'tax_invoice');

  const [cart, setCart] = useState<DraftLine[]>([]);
  const [party, setParty] = useState<Row | null>(null);
  const [dialog, setDialog] = useState<DialogName>(null);
  const [closing, setClosing] = useState<NonNullable<typeof shift> | null>(null);
  const [returnCode, setReturnCode] = useState('');
  const [code, setCode] = useState('');
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [scanMs, setScanMs] = useState<number | null>(null);
  const [lastDocId, setLastDocId] = useState<string | null>(null);
  const [searchHits, setSearchHits] = useState<Row[]>([]);
  const [weight, setWeight] = useState<{ kg: bigint; stable: boolean } | null>(null);
  const stopScale = useRef<(() => Promise<void>) | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);

  const day = today(() => new Date());
  const cartCtx: CartContext = useMemo(
    () => ({
      businessState: String(business?.['state_code'] ?? ''),
      composition: business?.['scheme'] === 'composition',
      party,
      date: day,
    }),
    [business, party, day],
  );
  const built = useMemo(
    () => (cart.length === 0 ? null : buildDocument(cartDraft(cart, cartCtx))),
    [cart, cartCtx],
  );
  const total = built ? BigInt(built.money.total_paise) : 0n;
  const lineTotal = useMemo(
    () => new Map((built?.lines ?? []).map((l) => [l.key, l.result.totalPaise])),
    [built],
  );

  const parser = useMemo(() => new WedgeParser(toWedgeConfig(settings)), [settings]);
  const focusScan = useCallback(() => requestAnimationFrame(() => scanRef.current?.focus()), []);
  useEffect(() => {
    if (!dialog && !closing) focusScan();
  }, [dialog, closing, focusScan, shift]);

  // what the customer sees on the second screen
  useEffect(() => {
    postDisplay({
      business: String(business?.['legal_name'] ?? ''),
      lines: (built?.lines ?? []).map((l) => {
        const line = cart.find((x) => x.key === l.key);
        return {
          name: line?.description ?? '',
          qty: line ? qtyLabel(line.qtyMicros) : '',
          amount: money(l.result.totalPaise),
        };
      }),
      total: money(total),
    });
  }, [built, cart, total, business]);

  // a scanner with no ending key is read when it goes quiet
  useEffect(() => {
    if (settings.wedgeSuffix !== 'none') return;
    const timer = setInterval(() => {
      const r = parser.flush(performance.now());
      if (r) {
        setCode('');
        handleCode(r.text, r.kind);
      }
    }, 40);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parser, settings.wedgeSuffix, index, cart]);

  const stopWeighing = useCallback(async () => {
    await stopScale.current?.();
    stopScale.current = null;
    setWeight(null);
  }, []);
  useEffect(
    () => () => {
      void stopScale.current?.();
    },
    [],
  );

  function say(kind: 'ok' | 'error', text: string, t0?: number) {
    setNote({ kind, text });
    if (t0 !== undefined)
      requestAnimationFrame(() => setScanMs(Math.round(performance.now() - t0)));
  }

  function add(item: Row, o: { qtyMicros?: bigint; serial?: string } = {}, t0?: number) {
    const r = addToCart(cart, item, o);
    if (r.duplicateSerial) {
      say('error', t('pos.scan.duplicateSerial', { serial: o.serial ?? '' }));
      return;
    }
    setCart(r.cart);
    setSearchHits([]);
    say('ok', `${String(item['name'])}`, t0);
  }

  function handleCode(raw: string, kind: 'scan' | 'typed', t0 = performance.now()) {
    const text = raw.trim();
    if (!text) {
      // Enter on an empty box goes to payment when there is something to pay
      if (cart.length > 0 && shift) setDialog('pay');
      return;
    }
    // the invoice's QR (GSTIN|number|date|total) starts a return
    if (text.includes('|')) {
      setReturnCode(text);
      setDialog('return');
      return;
    }
    // "3*code" sells three
    const mult = /^(\d+(?:\.\d+)?)\*(.+)$/.exec(text);
    const qtyMicros = mult ? BigInt(parseQtyMicros(mult[1]!) ?? 1_000_000) : undefined;
    const lookup = mult ? mult[2]!.trim() : text;
    const hit = index ? resolveCode(index, lookup) : null;
    if (hit) {
      add(hit, qtyMicros !== undefined ? { qtyMicros } : {}, t0);
      return;
    }
    void (async () => {
      if (!database || !ctx) return;
      // a serial number names its item
      const serials = await new SerialRepo(database).find(ctx, lookup);
      const inStock = serials.find((s) => s.status === 'in_stock');
      if (inStock) {
        const item = items?.find((i) => String(i['id']) === inStock.itemId);
        if (item && trackingOf(item) === 'serial') {
          add(item, { serial: inStock.serialNo }, t0);
          return;
        }
      }
      if (serials.length > 0) {
        say('error', t('pos.scan.serialOut', { serial: lookup }));
        return;
      }
      if (kind === 'typed') {
        const hits = await new ItemRepo(database).search(ctx, lookup, 8);
        setSearchHits(hits.filter((h) => h['is_active'] !== false));
        if (hits.length === 0) say('error', t('pos.scan.notFound', { code: lookup }));
        else setNote(null);
        return;
      }
      say('error', t('pos.scan.notFound', { code: lookup }));
    })();
  }

  const onScanKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const t0 = performance.now();
    const ending = e.key === 'Enter' || (settings.wedgeSuffix === 'Tab' && e.key === 'Tab');
    if (ending) {
      e.preventDefault();
      const r = parser.push(e.key, t0);
      const text = r?.text ?? code;
      const kind = r?.kind ?? 'typed';
      parser.reset();
      setCode('');
      handleCode(text, kind, t0);
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) parser.push(e.key, t0);
    if (e.key === 'Escape') {
      parser.reset();
      setCode('');
      setSearchHits([]);
    }
  };

  // function keys, so a hand can stay on the scanner
  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      if (dialog || closing || !shift) return;
      const go = (d: DialogName) => {
        e.preventDefault();
        setDialog(d);
      };
      if (e.key === 'F2' && cart.length > 0) go('pay');
      else if (e.key === 'F3' && cart.length > 0) {
        e.preventDefault();
        void holdBill();
      } else if (e.key === 'F4') go('recall');
      else if (e.key === 'F6') {
        setReturnCode('');
        go('return');
      } else if (e.key === 'F8') go('cash');
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog, closing, shift, cart, party]);

  /* ------------------------------------------------------------------ actions */

  const pay = async (tenders: Tender[]) => {
    if (!database || !ctx || !shift || !counter) return;
    const r = await new PosRepo(database).sell(ctx, {
      shiftId: shift.id,
      lines: cart,
      partyId: party ? String(party['id']) : null,
      tenders,
      date: day,
      inventoryEnabled: flags.inventory,
    });
    const documentId = String(r.document['id']);
    setLastDocId(documentId);
    const paid = tenders.reduce((s, x) => s + x.amountPaise, 0n);
    postDisplay({
      business: String(business?.['legal_name'] ?? ''),
      lines: [],
      total: money(total),
      paid: { paid: money(paid), change: money(r.settlement.changePaise) },
    });
    const cash = r.settlement.applied.some((a) => a.mode === 'cash');
    setCart([]);
    setParty(null);
    setDialog(null);
    say(
      'ok',
      r.settlement.changePaise > 0n
        ? t('pos.pay.doneChange', {
            number: String(r.document['number']),
            change: money(r.settlement.changePaise),
          })
        : t('pos.pay.done', { number: String(r.document['number']) }),
    );
    const made = await makeReceipt(documentId);
    if (made) {
      const out = await printReceipt(made.model, made.spec, {
        drawer: cash && settings.drawerKick,
        billQr: settings.billQr,
      });
      if (out === 'failed') toast.error(t('pos.print.failed'));
    } else if (cash && settings.drawerKick) void kickDrawer();
  };

  async function holdBill() {
    if (!database || !ctx || !counter || cart.length === 0) return;
    try {
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      await new PosRepo(database).hold(ctx, {
        counterId: counter.id,
        lines: cart,
        partyId: party ? String(party['id']) : null,
        label: `${party ? String(party['name']) : t('pos.walkIn')} ${time}`,
        totalPaise: total,
      });
      setCart([]);
      setParty(null);
      say('ok', t('pos.hold.done'));
    } catch (e) {
      say('error', errText(e));
    }
  }

  const recall = async (h: HeldBill) => {
    if (!database || !ctx) return;
    try {
      // what is on the screen now is put aside first, so nothing is lost
      if (cart.length > 0) await holdBill();
      const back = await new PosRepo(database).recall(ctx, h.id);
      setCart(back.lines);
      setParty(back.partyId ? await new PartyRepo(database).get(ctx, back.partyId) : null);
      setDialog(null);
    } catch (e) {
      toast.error(errText(e));
    }
  };

  const reprint = async (documentId: string | null) => {
    if (!documentId) return;
    const made = await makeReceipt(documentId);
    if (!made) return toast.error(t('pos.print.failed'));
    const out = await printReceipt(made.model, made.spec, {
      drawer: false,
      billQr: settings.billQr,
    });
    if (out === 'failed') toast.error(t('pos.print.failed'));
  };

  const printZ = (report: ShiftReport, counted: bigint | null) => {
    printHtml(zHtml(report, String(business?.['legal_name'] ?? ''), counted, t));
  };

  const addCounter = async (name: string) => {
    if (!database || !ctx) return;
    try {
      const c = await new PosRepo(database).addCounter(ctx, { name });
      choose(c.id);
      setDialog(null);
    } catch (e) {
      toast.error(errText(e));
    }
  };
  const choose = (id: string) => {
    setPicked(id);
    try {
      localStorage.setItem(storeKey(businessId), id);
    } catch {
      // not remembered: the first counter is the one shown next time
    }
  };

  const toggleScale = async () => {
    if (stopScale.current) return stopWeighing();
    const stop = await connectScale((kg, stable) => setWeight({ kg: BigInt(kg), stable }));
    if (!stop) return toast.error(t('pos.scale.failed'));
    stopScale.current = stop;
  };
  const useWeight = () => {
    const last = cart[cart.length - 1];
    if (!last || !weight) return;
    setCart(setLineQty(cart, last.key, weight.kg));
  };
  const camera = async () => {
    const r = await scanBarcode();
    if (r.ok) handleCode(r.code, 'scan');
    else if (r.reason === 'unsupported') toast.error(t('pos.scan.noCamera'));
  };

  /* ------------------------------------------------------------------ screens */

  if (!ctx || !business || counters.isLoading || !list) return null;

  if (list.length === 0) return <CounterForm first onAdd={addCounter} />;
  if (!counter) return null;

  const closeDialog = closing && (
    <CloseShiftDialog
      shift={closing}
      onPrint={printZ}
      onClosed={() => undefined}
      onClose={() => {
        setClosing(null);
        setCart([]);
      }}
    />
  );

  if (shiftQuery.isLoading) return null;
  if (!shift) {
    return (
      <>
        <OpenShiftCard
          counter={counter}
          onOpen={async (floatPaise) => {
            try {
              await new PosRepo(database!).openShift(ctx, { counterId: counter.id, floatPaise });
            } catch (e) {
              toast.error(errText(e));
            }
          }}
        />
        {closeDialog}
      </>
    );
  }

  return (
    <>
      <div
        className="flex h-full min-h-[34rem] flex-col gap-3 p-3"
        data-testid="pos"
        data-counter={counter.name}
      >
        <header className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">{t('pos.title')}</h1>
          {list.length > 1 ? (
            <select
              className="h-9 rounded-md border border-border bg-bg px-2 text-sm"
              aria-label={t('pos.counter')}
              data-testid="pos-counter"
              value={counter.id}
              onChange={(e) => choose(e.target.value)}
            >
              {list.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : (
            <Badge data-testid="pos-counter-name">{counter.name}</Badge>
          )}
          <span className="text-xs text-fg-muted">
            {t('pos.shift.cashier', { name: shift.cashier })}
          </span>
          <div className="ml-auto flex flex-wrap gap-1">
            {barcodeSupported() && (
              <Button variant="outline" data-testid="pos-camera" onClick={() => void camera()}>
                {t('pos.camera')}
              </Button>
            )}
            {scaleSupported() && (
              <Button variant="outline" data-testid="pos-scale" onClick={() => void toggleScale()}>
                {stopScale.current ? t('pos.scale.stop') : t('pos.scale.connect')}
              </Button>
            )}
            <Button
              variant="outline"
              data-testid="pos-display-open"
              onClick={() => !openDisplayWindow() && toast.error(t('pos.display.blocked'))}
            >
              {t('pos.display.open')}
            </Button>
            <Button
              variant="ghost"
              data-testid="pos-add-counter"
              onClick={() => setDialog('counter')}
            >
              {t('pos.addCounter')}
            </Button>
            <Button
              variant="ghost"
              data-testid="pos-settings-open"
              onClick={() => setDialog('settings')}
            >
              {t('pos.settings.open')}
            </Button>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <section className="flex min-h-0 flex-col gap-2">
            <div className="relative">
              <Input
                ref={scanRef}
                autoComplete="off"
                className="h-12 text-lg"
                placeholder={t('pos.scan.placeholder')}
                aria-label={t('pos.scan.label')}
                data-testid="pos-scan"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={onScanKey}
              />
              {searchHits.length > 0 && (
                <ul
                  className="absolute z-20 mt-1 w-full rounded-md border border-border bg-bg p-1 shadow-md"
                  data-testid="pos-hits"
                >
                  {searchHits.map((h) => (
                    <li key={String(h['id'])}>
                      <button
                        type="button"
                        data-testid="pos-hit"
                        className="flex w-full justify-between gap-2 rounded px-2 py-1 text-left hover:bg-surface-1"
                        onClick={() => {
                          add(h);
                          setCode('');
                          focusScan();
                        }}
                      >
                        <span className="truncate">{String(h['name'])}</span>
                        <span className="tabular text-fg-muted">
                          {money(Number(h['sale_rate_paise'] ?? 0))}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p
              role="status"
              className={`min-h-6 text-sm ${note?.kind === 'error' ? 'text-danger' : 'text-fg-muted'}`}
              data-testid="pos-note"
              data-kind={note?.kind ?? ''}
              {...(scanMs !== null ? { 'data-scan-ms': scanMs } : {})}
            >
              {note?.text ?? ''}
            </p>

            <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
              <table className="w-full text-sm" data-testid="pos-cart">
                <thead className="sticky top-0 bg-surface-1 text-left text-xs uppercase text-fg-muted">
                  <tr>
                    <th className="p-2 font-medium">{t('pos.cart.item')}</th>
                    <th className="p-2 text-right font-medium">{t('pos.cart.rate')}</th>
                    <th className="p-2 text-center font-medium">{t('pos.cart.qty')}</th>
                    <th className="p-2 text-right font-medium">{t('pos.cart.discount')}</th>
                    <th className="p-2 text-right font-medium">{t('pos.cart.amount')}</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {cart.map((l) => (
                    <tr key={l.key} className="border-t border-border" data-testid="pos-line">
                      <td className="p-2">
                        <span data-testid="pos-line-name">{l.description}</span>
                        {l.serials.length > 0 && (
                          <span className="block text-xs text-fg-muted">
                            {l.serials.join(', ')}
                          </span>
                        )}
                      </td>
                      <td className="tabular p-2 text-right">{money(l.ratePaise)}</td>
                      <td className="p-2">
                        <div className="flex items-center justify-center gap-1">
                          <Button
                            variant="outline"
                            aria-label={t('pos.cart.less')}
                            data-testid="pos-qty-less"
                            onClick={() =>
                              setCart(setLineQty(cart, l.key, l.qtyMicros - 1_000_000n))
                            }
                          >
                            −
                          </Button>
                          <Input
                            key={`${l.key}:${l.qtyMicros}`}
                            className="w-16 text-center tabular"
                            inputMode="decimal"
                            aria-label={t('pos.cart.qty')}
                            data-testid="pos-qty"
                            defaultValue={qtyLabel(l.qtyMicros)}
                            onBlur={(e) => {
                              const q = parseQtyMicros(e.target.value);
                              if (q !== null && q !== undefined && BigInt(q) !== l.qtyMicros)
                                setCart(setLineQty(cart, l.key, BigInt(q)));
                            }}
                            onKeyDown={(e) =>
                              e.key === 'Enter' && (e.target as HTMLInputElement).blur()
                            }
                          />
                          <Button
                            variant="outline"
                            aria-label={t('pos.cart.more')}
                            data-testid="pos-qty-more"
                            onClick={() =>
                              setCart(setLineQty(cart, l.key, l.qtyMicros + 1_000_000n))
                            }
                          >
                            +
                          </Button>
                        </div>
                      </td>
                      <td className="p-2 text-right">
                        <Input
                          key={`${l.key}:d${l.discountValue}`}
                          className="ml-auto w-16 text-right tabular"
                          inputMode="decimal"
                          placeholder="0"
                          aria-label={t('pos.cart.discount')}
                          data-testid="pos-discount"
                          defaultValue={
                            l.discountValue > 0n ? String(Number(l.discountValue) / 100) : ''
                          }
                          onBlur={(e) => {
                            const bp = parsePercentBp(e.target.value);
                            if (bp === null) return say('error', t('pos.cart.discountBad'));
                            if (BigInt(bp) === l.discountValue) return;
                            const r = setLineDiscount(cart, l.key, bp, {
                              canApprove,
                              maxBp: settings.maxDiscountBp,
                            });
                            if (!r.allowed) {
                              e.target.value =
                                l.discountValue > 0n ? String(Number(l.discountValue) / 100) : '';
                              return say(
                                'error',
                                t('pos.cart.discountDenied', { max: settings.maxDiscountBp / 100 }),
                              );
                            }
                            setCart(r.cart);
                          }}
                          onKeyDown={(e) =>
                            e.key === 'Enter' && (e.target as HTMLInputElement).blur()
                          }
                        />
                      </td>
                      <td
                        className="tabular p-2 text-right font-medium"
                        data-testid="pos-line-total"
                      >
                        {money(lineTotal.get(l.key) ?? 0n)}
                      </td>
                      <td className="p-2 text-right">
                        <Button
                          variant="ghost"
                          aria-label={t('pos.cart.remove')}
                          data-testid="pos-remove"
                          onClick={() => setCart(removeLine(cart, l.key))}
                        >
                          ×
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {cart.length === 0 && (
                    <tr>
                      <td className="p-6 text-center text-fg-muted" colSpan={6}>
                        {t('pos.cart.empty')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {quick.length > 0 && (
              <div className="flex flex-wrap gap-1" data-testid="pos-quick">
                {quick.map((q) => (
                  <Button
                    key={String(q['id'])}
                    variant="outline"
                    data-testid="pos-quick-key"
                    title={String(q['name'])}
                    onClick={() => {
                      add(q);
                      focusScan();
                    }}
                  >
                    <span className="max-w-32 truncate">{String(q['name'])}</span>
                  </Button>
                ))}
              </div>
            )}
          </section>

          <aside className="flex flex-col gap-2" aria-label={t('pos.total')}>
            <div className="rounded-lg border border-border p-4">
              <div className="text-sm text-fg-muted">{t('pos.total')}</div>
              <div className="text-5xl font-semibold tabular" data-testid="pos-total">
                {money(total)}
              </div>
              <div className="pt-1 text-xs text-fg-muted" data-testid="pos-items-count">
                {t('pos.items', { count: cart.length })}
              </div>
            </div>
            {weight && (
              <div
                className="flex items-center gap-2 rounded-md border border-border p-2 text-sm"
                data-testid="pos-weight"
              >
                <span className="tabular">
                  {qtyLabel(weight.kg)} {UNIT_KG}
                </span>
                {!weight.stable && <Badge>{t('pos.scale.unstable')}</Badge>}
                <Button
                  variant="outline"
                  className="ml-auto"
                  disabled={!weight.stable || cart.length === 0}
                  onClick={useWeight}
                >
                  {t('pos.scale.use')}
                </Button>
              </div>
            )}
            <Button
              variant="outline"
              className="justify-between"
              data-testid="pos-customer"
              onClick={() => setDialog('customer')}
            >
              <span>{t('pos.customer')}</span>
              <span className="truncate text-fg-muted">
                {party ? String(party['name']) : t('pos.walkIn')}
              </span>
            </Button>
            <Button
              className="h-14 text-lg"
              data-testid="pos-pay-open"
              disabled={cart.length === 0}
              onClick={() => setDialog('pay')}
            >
              {t('pos.pay.open')} <kbd className="ml-2 text-xs opacity-70">F2</kbd>
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                data-testid="pos-hold"
                disabled={cart.length === 0}
                onClick={() => void holdBill()}
              >
                {t('pos.hold.open')} <kbd className="ml-1 text-xs opacity-70">F3</kbd>
              </Button>
              <Button
                variant="outline"
                data-testid="pos-recall-open"
                onClick={() => setDialog('recall')}
              >
                {t('pos.recall.open')}{' '}
                {held.length > 0 && (
                  <Badge className="ml-1" data-testid="pos-held-count">
                    {held.length}
                  </Badge>
                )}
              </Button>
              <Button
                variant="outline"
                data-testid="pos-return-open"
                onClick={() => {
                  setReturnCode('');
                  setDialog('return');
                }}
              >
                {t('pos.return.open')} <kbd className="ml-1 text-xs opacity-70">F6</kbd>
              </Button>
              <Button
                variant="outline"
                data-testid="pos-cash-open"
                onClick={() => setDialog('cash')}
              >
                {t('pos.cash.open')} <kbd className="ml-1 text-xs opacity-70">F8</kbd>
              </Button>
              <Button
                variant="outline"
                data-testid="pos-reprint"
                disabled={!lastDocId}
                onClick={() => void reprint(lastDocId)}
              >
                {t('pos.print.last')}
              </Button>
              <Button
                variant="outline"
                data-testid="pos-drawer"
                onClick={() =>
                  void kickDrawer().then((ok) => !ok && toast.error(t('pos.drawer.none')))
                }
              >
                {t('pos.drawer.open')}
              </Button>
              <Button
                variant="outline"
                data-testid="pos-xreport-open"
                onClick={() => setDialog('xreport')}
              >
                {t('pos.xreport.open')}
              </Button>
              <Button
                variant="outline"
                data-testid="pos-close-open"
                onClick={() => setClosing(shift)}
              >
                {t('pos.close.open')}
              </Button>
            </div>
          </aside>
        </div>

        {dialog === 'pay' && (
          <PayDialog
            totalPaise={total}
            upiId={upiId}
            payee={String(business['legal_name'] ?? '')}
            onPay={pay}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog === 'recall' && (
          <RecallDialog
            held={held}
            onRecall={(h) => void recall(h)}
            onDrop={(h) => database && ctx && void new PosRepo(database).dropHeld(ctx, h.id)}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog === 'return' && (
          <ReturnDialog
            counter={counter}
            shift={shift}
            inventoryEnabled={flags.inventory}
            today={day}
            initialCode={returnCode}
            onDone={(id) => {
              setDialog(null);
              void reprint(id);
            }}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog === 'cash' && <CashDialog shift={shift} onClose={() => setDialog(null)} />}
        {dialog === 'xreport' && (
          <XReport shiftId={shift.id} onClose={() => setDialog(null)} onPrint={printZ} />
        )}
        {dialog === 'settings' && (
          <PosSettingsDialog
            settings={settings}
            onSave={async (s) => {
              if (database && ctx) await savePosSettings(database, ctx, s);
              toast.success(t('pos.settings.saved'));
            }}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog === 'customer' && (
          <CustomerDialog
            onPick={(p) => {
              setParty(p);
              setDialog(null);
            }}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog === 'counter' && (
          <CounterDialog onAdd={addCounter} onClose={() => setDialog(null)} />
        )}
      </div>
      {closeDialog}
    </>
  );
}

/* ------------------------------------------------------------------ small dialogs */

function CounterForm({
  first,
  onAdd,
}: {
  first?: boolean;
  onAdd: (name: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(first ? 'Counter 1' : '');
  return (
    <form
      className="mx-auto mt-10 flex max-w-sm flex-col gap-3 rounded-lg border border-border p-5"
      data-testid="pos-counter-setup"
      onSubmit={(e) => {
        e.preventDefault();
        void onAdd(name);
      }}
    >
      <h2 className="text-lg font-semibold">{t('pos.setup.title')}</h2>
      <p className="text-sm text-fg-muted">{t('pos.setup.help')}</p>
      <Input
        ref={focusOnMount}
        aria-label={t('pos.setup.name')}
        data-testid="pos-counter-name-input"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Button type="submit" data-testid="pos-counter-create" disabled={name.trim() === ''}>
        {t('pos.setup.create')}
      </Button>
    </form>
  );
}

function CounterDialog({
  onAdd,
  onClose,
}: {
  onAdd: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogTitle>{t('pos.addCounter')}</DialogTitle>
        <DialogDescription>{t('pos.setup.help')}</DialogDescription>
        <CounterForm onAdd={onAdd} />
      </DialogContent>
    </Dialog>
  );
}

function CustomerDialog({
  onPick,
  onClose,
}: {
  onPick: (p: Row | null) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const found = useLiveQuery<Row[]>({
    tables: ['parties'],
    key: ['pos-party-search', q.trim()],
    enabled: q.trim().length > 0,
    fn: (d, c) => new PartyRepo(d).search(c, q.trim(), 8),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" data-testid="pos-customer-dialog">
        <DialogTitle>{t('pos.customer')}</DialogTitle>
        <DialogDescription>{t('pos.customerHelp')}</DialogDescription>
        <Input
          placeholder={t('pos.customerSearch')}
          aria-label={t('pos.customerSearch')}
          data-testid="pos-customer-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <ul className="flex flex-col gap-1">
          {(found.data ?? []).map((p) => (
            <li key={String(p['id'])}>
              <button
                type="button"
                data-testid="pos-customer-result"
                className="w-full rounded px-2 py-1 text-left hover:bg-surface-1"
                onClick={() => onPick(p)}
              >
                {String(p['name'])}{' '}
                <span className="text-fg-muted">{String(p['phone'] ?? '')}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="flex justify-end">
          <Button variant="outline" data-testid="pos-walkin" onClick={() => onPick(null)}>
            {t('pos.walkIn')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The shift so far: the same figures the Z report will carry, without closing. */
function XReport({
  shiftId,
  onClose,
  onPrint,
}: {
  shiftId: string;
  onClose: () => void;
  onPrint: (r: ShiftReport, counted: bigint | null) => void;
}) {
  const { t } = useTranslation();
  const report = useLiveQuery<ShiftReport>({
    tables: ['pos_bills', 'pos_cash_movements', 'documents'],
    key: ['pos-xreport', shiftId],
    fn: (d, c) => new PosRepo(d).shiftReport(c, shiftId),
  }).data;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" data-testid="pos-xreport">
        <DialogTitle>{t('pos.xreport.title')}</DialogTitle>
        <DialogDescription>{t('pos.xreport.help')}</DialogDescription>
        {report && <ZReportView z={report.z} />}
        <div className="flex justify-end gap-2">
          {report && (
            <Button variant="outline" onClick={() => onPrint(report, null)}>
              {t('pos.close.print')}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            {t('pos.close.done')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The Z report as a printable page. */
function zHtml(
  report: ShiftReport,
  business: string,
  counted: bigint | null,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  const z: ZReport = report.z;
  const row = (label: string, p: bigint) =>
    `<tr><td>${esc(label)}</td><td style="text-align:right">${money(p)}</td></tr>`;
  const modes = (['cash', 'upi', 'card', 'other'] as const)
    .filter((m) => z.byMode[m] !== 0n)
    .map((m) => row(t(dyn(`pos.pay.mode.${m}`)), z.byMode[m]))
    .join('');
  return `<div style="font:12px/1.4 monospace;width:80mm">
<h3 style="margin:0">${esc(business)}</h3>
<div>${esc(t('pos.z.title'))}: ${esc(report.counter?.name ?? '')} · ${esc(report.shift.cashier)}</div>
<div>${new Date(report.shift.openedAt).toLocaleString()}${report.shift.closedAt ? ` → ${new Date(report.shift.closedAt).toLocaleString()}` : ''}</div>
<hr/><table style="width:100%">
<tr><td>${esc(t('pos.z.sales'))}</td><td style="text-align:right">${z.salesCount}</td></tr>${row(t('pos.z.salesValue'), z.salesPaise)}
<tr><td>${esc(t('pos.z.returns'))}</td><td style="text-align:right">${z.returnsCount}</td></tr>${row(t('pos.z.returnsValue'), z.returnsPaise)}
${row(t('pos.z.net'), z.netPaise)}${modes}${row(t('pos.z.taxable'), z.tax.taxablePaise)}
${z.tax.cgstPaise ? row('CGST', z.tax.cgstPaise) : ''}${z.tax.sgstPaise ? row('SGST', z.tax.sgstPaise) : ''}${z.tax.igstPaise ? row('IGST', z.tax.igstPaise) : ''}
${row(t('pos.z.float'), z.drawer.floatPaise)}${row(t('pos.z.cashSales'), z.drawer.cashSalesPaise)}${row(t('pos.z.cashRefunds'), z.drawer.cashRefundsPaise)}
${row(t('pos.z.cashIn'), z.drawer.cashInPaise)}${row(t('pos.z.cashOut'), z.drawer.cashOutPaise)}${row(t('pos.z.expected'), z.drawer.expectedPaise)}
${counted !== null ? row(t('pos.close.counted'), counted) + row(t('pos.close.variance'), counted - z.drawer.expectedPaise) : ''}
</table></div>`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
