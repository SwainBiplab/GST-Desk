import {
  BusinessAccountRepo,
  PaymentFlowRepo,
  SettingsRepo,
  type DocPosition,
  type Direction,
  type PayMode,
  type PaymentListRow,
  type Row,
} from '@gst/db';
import {
  WRITE_OFF_MAX_PAISE,
  autoAllocate,
  parseAmountPaise,
  today,
  toDecimalString,
  validateAllocations,
  type AllocationRequest,
} from '@gst/domain';
import {
  Button,
  Checkbox,
  Input,
  MoneyText,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  formatPaise,
  toast,
} from '@gst/ui';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAppDb, useLiveQuery } from '@/app/db';
import { PartyPicker } from '@/features/documents/party-picker';
import { Field } from '@/features/onboarding/field';
import { useParty } from '@/features/parties/hooks';
import { track } from '@/features/telemetry/telemetry';

const MODES: PayMode[] = ['cash', 'upi', 'card', 'bank', 'cheque', 'other', 'adjustment'];
const todayIso = () => today(() => new Date());
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface PaymentFormProps {
  direction: Direction;
  /** Start with this party chosen. */
  partyId?: string | null;
  /** Start with this amount (paise). */
  amountPaise?: bigint | null;
  /** Editing a recorded payment: party and direction are fixed. */
  editing?: PaymentListRow | null;
  onDone: (paymentId: string) => void;
  onCancel?: () => void;
}

interface Cell {
  text: string;
  writeOff: boolean;
}

/**
 * Receive or make a payment. Choosing a party shows what is owed, oldest first; the amount is
 * allocated automatically and can be changed by hand. Whatever is left becomes party credit. For a
 * receipt the section 206C(1H) TCS (if any) is shown and kept apart from what settles the customer.
 */
export function PaymentForm({
  direction,
  partyId: initialParty = null,
  amountPaise: initialAmount = null,
  editing = null,
  onDone,
  onCancel,
}: PaymentFormProps) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const received = direction === 'received';

  const [partyId, setPartyId] = useState<string | null>(editing?.partyId ?? initialParty);
  const [partyName, setPartyName] = useState(editing?.partyName ?? '');
  const [date, setDate] = useState(editing?.date ?? todayIso());
  const [mode, setMode] = useState<PayMode>((editing?.mode as PayMode) ?? 'cash');
  const [accountId, setAccountId] = useState<string | null | undefined>(undefined);
  const [reference, setReference] = useState(editing?.reference ?? '');
  const [chequeDate, setChequeDate] = useState('');
  const [notes, setNotes] = useState('');
  // null until the user types: then the box shows the suggestion (one open document: what it owes)
  const [amountText, setAmountText] = useState<string | null>(
    editing
      ? toDecimalString(editing.amountPaise)
      : initialAmount
        ? toDecimalString(initialAmount)
        : null,
  );
  // null = follow auto-allocation; otherwise the user's own cells
  const [manual, setManual] = useState<Record<string, Cell> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // the name of a party chosen by the page that opened the form
  const prefilled = useParty(initialParty);
  const nameShown =
    partyName || (partyId === initialParty ? String(prefilled.data?.['name'] ?? '') : '');

  const positions = useLiveQuery({
    tables: ['documents', 'payments', 'payment_allocations'],
    key: ['pay-positions', partyId, direction, editing?.id ?? null],
    enabled: !!partyId,
    fn: async (d, c) => {
      const repo = new PaymentFlowRepo(d);
      const { documents } = await repo.positions(c, todayIso(), partyId!);
      const own = new Map<string, bigint>();
      if (editing)
        for (const a of await repo.allocationsFor(c, editing.id))
          if (a['kind'] !== 'credit_applied')
            own.set(
              a['document_id'],
              (own.get(a['document_id']) ?? 0n) + BigInt(Number(a['amount_paise'])),
            );
      const sources = await repo.creditSources(c, partyId!, direction, todayIso());
      return {
        own,
        credit: sources.reduce((n, s) => n + s.remainingPaise, 0n),
        documents: documents
          .filter((x) =>
            (received
              ? ['tax_invoice', 'bill_of_supply', 'debit_note']
              : ['purchase_bill', 'expense']
            ).includes(x.type),
          )
          .map((x) => ({ ...x, balancePaise: x.balancePaise + (own.get(x.id) ?? 0n) }))
          .filter((x) => x.balancePaise > 0n),
      };
    },
  });
  const docs: DocPosition[] = useMemo(() => positions.data?.documents ?? [], [positions.data]);

  const accounts = useLiveQuery<Row[]>({
    tables: ['business_accounts'],
    key: ['pay-accounts'],
    fn: (d, c) => new BusinessAccountRepo(d).listAccounts(c),
  });
  const wording = useLiveQuery<string | undefined>({
    tables: ['settings'],
    key: ['pay-wording'],
    fn: (d, c) => new SettingsRepo(d).getValue<string>(c, 'payments.wording'),
  });
  const kind = t(wording.data === 'advance' ? 'pay.advance' : 'pay.credit');

  const accountList = accounts.data ?? [];
  const defaultAccount = accountList.find((a) => a['is_default'])?.['id'] ?? null;
  const account = accountId === undefined ? defaultAccount : accountId;

  const single = docs.length === 1 ? docs[0]! : null;
  const shown = amountText ?? (single && !editing ? toDecimalString(single.balancePaise) : '');
  const parsed = shown.trim() === '' ? null : (parseAmountPaise(shown) ?? null);
  const amount = parsed === null ? 0n : BigInt(parsed);

  // TCS on a receipt: on the consideration, which is the amount less the TCS itself (two passes settle it)
  const tcsQuery = useLiveQuery<{ tcsPaise: bigint; note: string }>({
    tables: ['payments'],
    key: ['pay-tcs', partyId, date, amount.toString(), editing?.id ?? null],
    enabled: received && !!partyId && amount > 0n && mode !== 'adjustment',
    fn: async (d, c) => {
      const repo = new PaymentFlowRepo(d);
      const first = await repo.tcsFor(c, partyId!, date, amount, 10, editing?.id);
      if (first.tcsPaise === 0n) return first;
      return repo.tcsFor(c, partyId!, date, amount - first.tcsPaise, 10, editing?.id);
    },
  });
  const tcs =
    received && amount > 0n && mode !== 'adjustment' ? (tcsQuery.data?.tcsPaise ?? 0n) : 0n;
  const consideration = amount - tcs;

  const auto = useMemo(
    () => autoAllocate(docs, consideration > 0n ? consideration : 0n),
    [docs, consideration],
  );

  // the allocation in force: the user's own cells, or the automatic one
  const cells: Record<string, Cell> = useMemo(() => {
    if (manual) return manual;
    return Object.fromEntries(
      auto.allocations.map((a) => [
        a.documentId,
        { text: toDecimalString(a.amountPaise), writeOff: false },
      ]),
    );
  }, [manual, auto]);

  const requests: AllocationRequest[] = [];
  const rowState = docs.map((d) => {
    const cell = cells[d.id];
    const p = cell && cell.text.trim() !== '' ? (parseAmountPaise(cell.text) ?? null) : 0;
    const amt = p === null ? 0n : BigInt(p);
    const left = d.balancePaise - amt;
    const canWriteOff = left > 0n && left <= WRITE_OFF_MAX_PAISE && amt > 0n;
    const writeOff = canWriteOff && !!cell?.writeOff ? left : 0n;
    if (amt > 0n)
      requests.push({
        documentId: d.id,
        amountPaise: amt,
        ...(writeOff > 0n ? { writeOffPaise: writeOff } : {}),
      });
    return { doc: d, amt, bad: p === null, canWriteOff, left, writeOff };
  });
  const used = requests.reduce((n, r) => n + r.amountPaise, 0n);
  const remainder = consideration - used;

  const problems: string[] = [];
  if (partyId) {
    if (rowState.some((r) => r.bad)) problems.push(t('pay.badAmount'));
    problems.push(
      ...validateAllocations({
        considerationPaise: consideration,
        allocations: requests,
        balances: new Map(docs.map((d) => [d.id, d.balancePaise])),
      }),
    );
  }

  const editCell = (docId: string, patch: Partial<Cell>) =>
    setManual({ ...cells, [docId]: { text: cells[docId]?.text ?? '', writeOff: false, ...patch } });

  const submit = async () => {
    if (!database || !ctx || !partyId) return;
    setBusy(true);
    setError(null);
    try {
      const repo = new PaymentFlowRepo(database);
      const input = {
        direction,
        partyId,
        date,
        mode,
        amountPaise: amount,
        ...(tcs > 0n ? { tcsPaise: tcs } : {}),
        accountId: mode === 'cash' || mode === 'adjustment' ? null : account,
        reference: reference || null,
        chequeDate: mode === 'cheque' ? chequeDate || null : null,
        notes: notes || null,
        allocations: requests,
      };
      const r = editing
        ? await repo.edit(ctx, editing.id, editing.version, input)
        : await repo.record(ctx, input);
      const id = r.payment['id'] as string;
      if (!editing) track('payment_recorded');
      if (editing) toast.success(t('pay.saveEdit'));
      else
        toast.success(
          t(received ? 'pay.recorded' : 'pay.recordedMade', {
            amount: formatPaise(amount),
            party: nameShown,
          }),
          {
            duration: 30_000,
            action: {
              label: t('pay.undo'),
              onClick: () =>
                void repo
                  .remove(ctx, id)
                  .then(() => toast.success(t('pay.undone')))
                  .catch((e: unknown) => toast.error(errText(e))),
            },
          },
        );
      onDone(id);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const canSave = !!partyId && amount > 0n && problems.length === 0 && !busy;

  return (
    <form
      className="flex flex-col gap-4"
      data-testid="pay-form"
      data-direction={direction}
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) void submit();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('pay.party')}>
          {() => (
            <PartyPicker
              type={received ? 'tax_invoice' : 'purchase_bill'}
              name={nameShown}
              disabled={!!editing}
              onPick={(p) => {
                setPartyId(p ? String(p['id']) : null);
                setPartyName(p ? String(p['name']) : '');
                setManual(null);
                setAmountText(null);
              }}
            />
          )}
        </Field>
        <Field label={t('pay.amount')}>
          {(c) => (
            <Input
              {...c}
              inputMode="decimal"
              data-testid="pay-amount"
              value={shown}
              onChange={(e) => {
                setAmountText(e.target.value);
                setManual(null);
              }}
            />
          )}
        </Field>
        <Field label={t('pay.date')}>
          {(c) => (
            <Input
              {...c}
              type="date"
              data-testid="pay-date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          )}
        </Field>
        <Field label={t('pay.mode')}>
          {(c) => (
            <Select value={mode} onValueChange={(v) => setMode(v as PayMode)}>
              <SelectTrigger {...c} data-testid="pay-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODES.map((m) => (
                  <SelectItem key={m} value={m}>
                    {t(`pay.modes.${m}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
        {mode !== 'cash' && mode !== 'adjustment' && accountList.length > 0 && (
          <Field label={received ? t('pay.account') : t('pay.accountFrom')}>
            {(c) => (
              <Select
                value={account ?? 'none'}
                onValueChange={(v) => setAccountId(v === 'none' ? null : v)}
              >
                <SelectTrigger {...c} data-testid="pay-account">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('pay.noAccount')}</SelectItem>
                  {accountList.map((a) => (
                    <SelectItem key={a['id']} value={a['id']}>
                      {a['name']}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
        )}
        <Field label={mode === 'cheque' ? t('pay.chequeNo') : t('pay.reference')}>
          {(c) => (
            <Input
              {...c}
              data-testid="pay-reference"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          )}
        </Field>
        {mode === 'cheque' && (
          <Field label={t('pay.chequeDate')}>
            {(c) => (
              <Input
                {...c}
                type="date"
                data-testid="pay-cheque-date"
                value={chequeDate}
                onChange={(e) => setChequeDate(e.target.value)}
              />
            )}
          </Field>
        )}
      </div>

      {partyId && (
        <section
          aria-label={t('pay.allocate')}
          className="flex flex-col gap-2"
          data-testid="pay-allocation"
        >
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{t('pay.allocate')}</h3>
            {positions.data && positions.data.credit > 0n && (
              <span className="text-xs text-fg-muted" data-testid="pay-credit-available">
                {t('pay.creditAvailable', { amount: formatPaise(positions.data.credit) })}
              </span>
            )}
            <Button
              type="button"
              variant="ghost"
              className="ml-auto"
              data-testid="pay-auto"
              disabled={manual === null}
              onClick={() => setManual(null)}
            >
              {t('pay.autoAllocate')}
            </Button>
          </div>
          {docs.length === 0 ? (
            <p className="text-sm text-fg-muted" data-testid="pay-no-open">
              {t('pay.noOpen', { kind })}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-fg-muted">
                <tr>
                  <th className="py-1 pr-2 font-medium">{t('pay.doc')}</th>
                  <th className="pr-2 font-medium">{t('pay.due')}</th>
                  <th className="pr-2 text-right font-medium">{t('pay.owed')}</th>
                  <th className="w-36 text-right font-medium">{t('pay.settle')}</th>
                </tr>
              </thead>
              <tbody>
                {rowState.map((r) => (
                  <tr
                    key={r.doc.id}
                    className="border-t border-border align-top"
                    data-testid="alloc-row"
                    data-number={r.doc.number ?? ''}
                  >
                    <td className="py-1 pr-2">{r.doc.number ?? r.doc.type}</td>
                    <td className="pr-2 text-fg-muted">{r.doc.dueDate ?? r.doc.date}</td>
                    <td className="pr-2 text-right">
                      <MoneyText paise={r.doc.balancePaise} />
                    </td>
                    <td className="text-right">
                      <Input
                        inputMode="decimal"
                        className="text-right"
                        aria-label={`${t('pay.settle')} ${r.doc.number ?? ''}`}
                        data-testid="alloc-amount"
                        aria-invalid={r.bad}
                        value={cells[r.doc.id]?.text ?? ''}
                        onChange={(e) => editCell(r.doc.id, { text: e.target.value })}
                      />
                      {r.canWriteOff && (
                        <label
                          className="mt-1 flex items-center justify-end gap-1 text-xs text-fg-muted"
                          title={t('pay.writeOffHelp')}
                        >
                          <Checkbox
                            data-testid="alloc-writeoff"
                            checked={r.writeOff > 0n}
                            onCheckedChange={(v) =>
                              editCell(r.doc.id, {
                                writeOff: v === true,
                                text: cells[r.doc.id]?.text ?? '',
                              })
                            }
                          />
                          {t('pay.writeOff', { amount: formatPaise(r.left) })}
                        </label>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {tcs > 0n && (
            <p className="rounded-md border border-border p-2 text-sm" data-testid="pay-tcs">
              {t('pay.tcs')}: <MoneyText paise={tcs} />. {t('pay.tcsNote')}
            </p>
          )}
          {amount > 0n && remainder > 0n && (
            <p className="text-sm font-medium" data-testid="pay-remainder">
              {t('pay.remainder', { amount: formatPaise(remainder), kind })}
            </p>
          )}
        </section>
      )}

      <Field label={t('pay.notes')}>
        {(c) => (
          <Textarea
            {...c}
            rows={2}
            data-testid="pay-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        )}
      </Field>

      {(problems.length > 0 || error) && (
        <ul role="alert" className="text-sm text-danger" data-testid="pay-error">
          {error && <li>{error}</li>}
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('lock.cancel')}
          </Button>
        )}
        <Button type="submit" data-testid="pay-save" disabled={!canSave}>
          {busy ? t('pay.saving') : editing ? t('pay.saveEdit') : t('pay.save')}
        </Button>
      </div>
    </form>
  );
}
