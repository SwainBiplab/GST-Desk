import { depositDueDate, quarterOf, QUARTERS, type Quarter } from '@gst/domain';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Input,
  MoneyInput,
  MoneyText,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  toast,
} from '@gst/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Field, fail } from './common';
import { useChallans, useDeductions, useTaxActions } from './hooks';

import { useConfirm } from '@/app/components/confirm';

export function ChallanTab({ fy }: { fy: string }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const actions = useTaxActions();
  const challans = useChallans(fy);
  const deductions = useDeductions(fy).data ?? [];
  const [matching, setMatching] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const rows = (challans.data ?? []).map((c) => {
    const linked = deductions.filter((d) => d.challanId === c.id);
    const mapped = linked.reduce((a, d) => a + d.taxPaise, 0n);
    const earliest = linked.map((d) => d.date).sort()[0];
    const due = earliest ? depositDueDate(earliest) : null;
    return { c, linked, mapped, due, late: !!due && c.depositDate > due };
  });

  const startMatch = (id: string) => {
    setMatching(id);
    setPicked(new Set(deductions.filter((d) => d.challanId === id).map((d) => d.id)));
  };
  const saveMatch = async (id: string, kind: 'tds' | 'tcs') => {
    try {
      const before = deductions.filter((d) => d.challanId === id).map((d) => d.id);
      const drop = before.filter((x) => !picked.has(x));
      if (drop.length) await actions.mapToChallan(drop, null);
      const add = [...picked].filter((x) => deductions.find((d) => d.id === x)?.kind === kind);
      if (add.length) await actions.mapToChallan(add, id);
      setMatching(null);
    } catch (e) {
      fail(e);
    }
  };
  const remove = async (id: string) => {
    if (
      !(await confirm({
        title: t('directTax.confirm.removeChallanTitle'),
        description: t('directTax.confirm.removeChallanBody'),
        confirmLabel: t('directTax.challan.remove'),
      }))
    )
      return;
    try {
      await actions.removeChallan(id);
      toast.success(t('directTax.challan.removed'));
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">{t('directTax.challan.heading')}</h2>
        <p className="text-sm text-fg-muted">{t('directTax.challan.hint')}</p>
        {rows.length === 0 ? (
          <EmptyState title={t('directTax.challan.none')} />
        ) : (
          <Table data-testid="challan-table">
            <TableHead>
              <TableRow>
                <TableHeaderCell>{t('directTax.challan.depositDate')}</TableHeaderCell>
                <TableHeaderCell>{t('directTax.challan.kind')}</TableHeaderCell>
                <TableHeaderCell>{t('directTax.challan.quarter')}</TableHeaderCell>
                <TableHeaderCell>{t('directTax.challan.bsr')}</TableHeaderCell>
                <TableHeaderCell>{t('directTax.challan.serial')}</TableHeaderCell>
                <TableHeaderCell className="text-right">
                  {t('directTax.challan.tax')}
                </TableHeaderCell>
                <TableHeaderCell className="text-right">
                  {t('directTax.deduct.matched')}
                </TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map(({ c, linked, mapped, due, late }) => (
                <TableRow key={c.id}>
                  <TableCell>
                    {c.depositDate}
                    {late ? (
                      <Badge tone="danger" className="ml-2">
                        {t('directTax.challan.late')}
                      </Badge>
                    ) : null}
                    {due ? (
                      <div className="text-xs text-fg-muted">
                        {t('directTax.challan.due', { date: due })}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>{c.kind.toUpperCase()}</TableCell>
                  <TableCell>{quarterOf(c.depositDate).quarter}</TableCell>
                  <TableCell>{c.bsr}</TableCell>
                  <TableCell>{c.serial}</TableCell>
                  <TableCell className="text-right">
                    <MoneyText paise={c.taxPaise} />
                  </TableCell>
                  <TableCell className="text-right">
                    <MoneyText paise={mapped} />{' '}
                    <span className="text-xs text-fg-muted">
                      ({t('directTax.challan.matched', { count: linked.length })})
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button
                        variant="outline"
                        onClick={() => startMatch(c.id)}
                        data-testid="challan-match"
                      >
                        {t('directTax.challan.match')}
                      </Button>
                      <Button variant="ghost" onClick={() => void remove(c.id)}>
                        {t('directTax.challan.remove')}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {matching ? (
        <MatchPanel
          challanId={matching}
          kind={rows.find((r) => r.c.id === matching)?.c.kind ?? 'tds'}
          serial={rows.find((r) => r.c.id === matching)?.c.serial ?? ''}
          picked={picked}
          setPicked={setPicked}
          onSave={() =>
            void saveMatch(matching, rows.find((r) => r.c.id === matching)?.c.kind ?? 'tds')
          }
          onCancel={() => setMatching(null)}
          fy={fy}
        />
      ) : null}

      <AddChallan fy={fy} />
    </div>
  );
}

function MatchPanel(props: {
  challanId: string;
  kind: 'tds' | 'tcs';
  serial: string;
  picked: Set<string>;
  setPicked: (s: Set<string>) => void;
  onSave: () => void;
  onCancel: () => void;
  fy: string;
}) {
  const { t } = useTranslation();
  const all = useDeductions(props.fy).data ?? [];
  const candidates = all.filter(
    (d) => d.kind === props.kind && (d.challanId === null || d.challanId === props.challanId),
  );
  const toggle = (id: string, on: boolean) => {
    const next = new Set(props.picked);
    if (on) next.add(id);
    else next.delete(id);
    props.setPicked(next);
  };
  const total = candidates
    .filter((d) => props.picked.has(d.id))
    .reduce((a, d) => a + d.taxPaise, 0n);
  return (
    <Card className="flex flex-col gap-3" data-testid="match-panel">
      <h3 className="text-base font-semibold">
        {t('directTax.challan.matchTitle', { serial: props.serial })}
      </h3>
      <p className="text-sm text-fg-muted">{t('directTax.challan.matchHint')}</p>
      <ul className="flex flex-col gap-1">
        {candidates.map((d) => (
          <li key={d.id}>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={props.picked.has(d.id)}
                onCheckedChange={(v) => toggle(d.id, v === true)}
                aria-label={`${d.partyName} ${d.date}`}
              />
              <span>{d.date}</span>
              <span>{d.partyName}</span>
              <MoneyText paise={d.taxPaise} />
            </label>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <span className="text-sm">
          {t('directTax.deduct.total')}: <MoneyText paise={total} />
        </span>
        <Button className="ml-auto" onClick={props.onSave} data-testid="match-save">
          {t('directTax.challan.matchSave')}
        </Button>
        <Button variant="ghost" onClick={props.onCancel}>
          {t('directTax.cancel')}
        </Button>
      </div>
    </Card>
  );
}

function AddChallan({ fy }: { fy: string }) {
  const { t } = useTranslation();
  const actions = useTaxActions();
  const [kind, setKind] = useState<'tds' | 'tcs'>('tds');
  const [quarter, setQuarter] = useState<Quarter>('Q1');
  const [bsr, setBsr] = useState('');
  const [serial, setSerial] = useState('');
  const [date, setDate] = useState('');
  const [tax, setTax] = useState<bigint | null>(null);
  const [interest, setInterest] = useState<bigint | null>(null);
  const [fee, setFee] = useState<bigint | null>(null);

  const save = async () => {
    try {
      await actions.addChallan({
        kind,
        fy,
        quarter,
        bsr,
        depositDate: date,
        serial,
        taxPaise: tax ?? 0n,
        interestPaise: interest ?? 0n,
        feePaise: fee ?? 0n,
      });
      toast.success(t('directTax.challan.saved'));
      setBsr('');
      setSerial('');
      setTax(null);
      setInterest(null);
      setFee(null);
    } catch (e) {
      fail(e);
    }
  };
  return (
    <Card className="flex flex-col gap-3" data-testid="challan-add">
      <h3 className="text-base font-semibold">{t('directTax.challan.add')}</h3>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('directTax.challan.kind')}>
          <Select value={kind} onValueChange={(v) => setKind(v === 'tcs' ? 'tcs' : 'tds')}>
            <SelectTrigger className="w-28" aria-label={t('directTax.challan.kind')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tds">{t('directTax.tabs.tds')}</SelectItem>
              <SelectItem value="tcs">{t('directTax.tabs.tcs')}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label={t('directTax.challan.quarter')}>
          <Select value={quarter} onValueChange={(v) => setQuarter(v as Quarter)}>
            <SelectTrigger className="w-24" aria-label={t('directTax.challan.quarter')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {QUARTERS.map((q) => (
                <SelectItem key={q} value={q}>
                  {q}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t('directTax.challan.bsr')}>
          <Input
            value={bsr}
            inputMode="numeric"
            maxLength={7}
            onChange={(e) => setBsr(e.target.value)}
            data-testid="challan-bsr"
          />
        </Field>
        <Field label={t('directTax.challan.serial')}>
          <Input
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
            data-testid="challan-serial"
          />
        </Field>
        <Field label={t('directTax.challan.depositDate')}>
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            data-testid="challan-date"
          />
        </Field>
        <Field label={t('directTax.challan.tax')}>
          <MoneyInput value={tax} onValueChange={setTax} data-testid="challan-tax" />
        </Field>
        <Field label={t('directTax.challan.interest')}>
          <MoneyInput value={interest} onValueChange={setInterest} />
        </Field>
        <Field label={t('directTax.challan.fee')}>
          <MoneyInput value={fee} onValueChange={setFee} />
        </Field>
        <Button onClick={() => void save()} data-testid="challan-save">
          {t('directTax.challan.save')}
        </Button>
      </div>
    </Card>
  );
}
