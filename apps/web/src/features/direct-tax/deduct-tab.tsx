import type { Proposal } from '@gst/db';
import { DIRECT_TAX, type Deduction, tcsRule, today } from '@gst/domain';
import {
  Badge,
  Button,
  Card,
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

import { Field, fail, pct, ruleText, sectionLabel, natureLabel } from './common';
import { useDeductions, usePartyChoices, useProposals, useTaxActions } from './hooks';

import { useConfirm } from '@/app/components/confirm';

/** The TDS tab (kind `tds`) and the TCS tab (kind `tcs`): what to record, what is recorded, and a form by hand. */
export function DeductTab({ fy, kind }: { fy: string; kind: 'tds' | 'tcs' }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const actions = useTaxActions();
  const proposals = useProposals(fy, kind);
  const all = useDeductions(fy);
  const recorded = (all.data ?? []).filter((d) => d.kind === kind);
  const suggested = proposals.data ?? [];
  const [busy, setBusy] = useState(false);

  const accept = async (p: Proposal) => {
    try {
      await actions.record(p);
      toast.success(t('directTax.deduct.recorded'));
    } catch (e) {
      fail(e);
    }
  };
  const acceptAll = async () => {
    setBusy(true);
    try {
      for (const p of suggested) await actions.record(p);
      toast.success(t('directTax.deduct.recorded'));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    if (
      !(await confirm({
        title: t('directTax.confirm.removeTitle'),
        description: t('directTax.confirm.removeBody'),
        confirmLabel: t('directTax.deduct.remove'),
      }))
    )
      return;
    try {
      await actions.remove(id);
      toast.success(t('directTax.deduct.removed'));
    } catch (e) {
      fail(e);
    }
  };

  const total = recorded.reduce((a, d) => a + d.taxPaise, 0n);
  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">
            {t(kind === 'tds' ? 'directTax.deduct.suggestedTds' : 'directTax.deduct.suggestedTcs')}
          </h2>
          {suggested.length > 1 ? (
            <Button
              className="ml-auto"
              disabled={busy}
              onClick={() => void acceptAll()}
              data-testid={`${kind}-accept-all`}
            >
              {t('directTax.deduct.acceptAll')}
            </Button>
          ) : null}
        </div>
        <p className="text-sm text-fg-muted">
          {t(
            kind === 'tds' ? 'directTax.deduct.suggestedHint' : 'directTax.deduct.suggestedHintTcs',
          )}
        </p>
        {suggested.length === 0 ? (
          <EmptyState
            title={t(kind === 'tds' ? 'directTax.deduct.none' : 'directTax.deduct.noneTcs')}
          />
        ) : (
          <Table data-testid={`${kind}-suggested`}>
            <TableHead>
              <TableRow>
                <TableHeaderCell>{t('directTax.cols.party')}</TableHeaderCell>
                <TableHeaderCell>{t('directTax.cols.document')}</TableHeaderCell>
                <TableHeaderCell>{t('directTax.cols.date')}</TableHeaderCell>
                <TableHeaderCell>{t('directTax.cols.section')}</TableHeaderCell>
                <TableHeaderCell className="text-right">{t('directTax.cols.base')}</TableHeaderCell>
                <TableHeaderCell className="text-right">{t('directTax.cols.rate')}</TableHeaderCell>
                <TableHeaderCell className="text-right">{t('directTax.cols.tax')}</TableHeaderCell>
                <TableHeaderCell>{t('directTax.cols.why')}</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {suggested.map((p) => (
                <TableRow key={p.documentId}>
                  <TableCell>{p.partyName}</TableCell>
                  <TableCell>{p.documentNumber}</TableCell>
                  <TableCell>{p.date}</TableCell>
                  <TableCell>{ruleText(t, p)}</TableCell>
                  <TableCell className="text-right">
                    <MoneyText paise={p.basePaise} />
                  </TableCell>
                  <TableCell className="text-right">{pct(p.rateBp)}</TableCell>
                  <TableCell className="text-right">
                    <MoneyText paise={p.taxPaise} />
                  </TableCell>
                  <TableCell className="text-sm">
                    <span className="flex flex-wrap gap-1">
                      {p.noPan ? <Badge tone="warning">{t('directTax.deduct.noPan')}</Badge> : null}
                      {p.lowerCert ? (
                        <Badge tone="info">{t('directTax.deduct.lowerCert')}</Badge>
                      ) : null}
                      <span className="text-fg-muted">{p.why}</span>
                    </span>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      onClick={() => void accept(p)}
                      data-testid="accept-row"
                    >
                      {t('directTax.deduct.accept')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">
          {t(kind === 'tds' ? 'directTax.deduct.recordedTds' : 'directTax.deduct.recordedTcs')}
        </h2>
        {recorded.length === 0 ? (
          <EmptyState title={t('directTax.deduct.recordedNone')} />
        ) : (
          <Table data-testid={`${kind}-recorded`}>
            <TableHead>
              <TableRow>
                <TableHeaderCell>{t('directTax.cols.party')}</TableHeaderCell>
                <TableHeaderCell>{t('directTax.cols.document')}</TableHeaderCell>
                <TableHeaderCell>{t('directTax.cols.date')}</TableHeaderCell>
                <TableHeaderCell>{t('directTax.cols.section')}</TableHeaderCell>
                <TableHeaderCell className="text-right">{t('directTax.cols.base')}</TableHeaderCell>
                <TableHeaderCell className="text-right">{t('directTax.cols.rate')}</TableHeaderCell>
                <TableHeaderCell className="text-right">{t('directTax.cols.tax')}</TableHeaderCell>
                <TableHeaderCell>{t('directTax.cols.challan')}</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {recorded.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>{d.partyName}</TableCell>
                  <TableCell>{d.documentNumber}</TableCell>
                  <TableCell>{d.date}</TableCell>
                  <TableCell>{ruleText(t, d)}</TableCell>
                  <TableCell className="text-right">
                    <MoneyText paise={d.basePaise} />
                  </TableCell>
                  <TableCell className="text-right">{pct(d.rateBp)}</TableCell>
                  <TableCell className="text-right">
                    <MoneyText paise={d.taxPaise} />
                  </TableCell>
                  <TableCell>
                    <Badge tone={d.challanId ? 'success' : 'neutral'}>
                      {t(d.challanId ? 'directTax.deduct.matched' : 'directTax.deduct.unmatched')}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" onClick={() => void remove(d.id)}>
                      {t('directTax.deduct.remove')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell className="font-medium">{t('directTax.deduct.total')}</TableCell>
                <TableCell colSpan={5} />
                <TableCell className="text-right font-medium">
                  <MoneyText paise={total} />
                </TableCell>
                <TableCell colSpan={2} />
              </TableRow>
            </TableBody>
          </Table>
        )}
      </Card>

      <ManualForm kind={kind} />
    </div>
  );
}

function ManualForm({ kind }: { kind: 'tds' | 'tcs' }) {
  const { t } = useTranslation();
  const actions = useTaxActions();
  const parties = usePartyChoices();
  const [partyId, setPartyId] = useState('');
  const rules =
    kind === 'tds' ? DIRECT_TAX.tds.map((r) => r.section) : DIRECT_TAX.tcs.map((r) => r.nature);
  const [rule, setRule] = useState(rules[0] ?? '');
  const [date, setDate] = useState(today(() => new Date()));
  const [amount, setAmount] = useState<bigint | null>(null);
  const [result, setResult] = useState<Deduction | null>(null);

  const ready =
    partyId !== '' && amount !== null && amount > 0n && /^\d{4}-\d{2}-\d{2}$/.test(date);
  const work = async () => {
    if (!ready) return;
    try {
      setResult(await actions.preview({ kind, partyId, rule, date, basePaise: amount! }));
    } catch (e) {
      fail(e);
    }
  };
  const save = async () => {
    if (!result?.applies) return;
    try {
      await actions.record({
        kind,
        partyId,
        section: kind === 'tds' ? rule : (tcsRule(rule)?.section ?? '206C(1)'),
        nature: kind === 'tcs' ? rule : null,
        date,
        basePaise: result.basePaise,
        rateBp: result.rateBp,
        taxPaise: result.taxPaise,
        noPan: result.noPan,
        lowerCert: result.lowerCert,
      });
      toast.success(t('directTax.deduct.recorded'));
      setResult(null);
      setAmount(null);
    } catch (e) {
      fail(e);
    }
  };

  return (
    <Card className="flex flex-col gap-3" data-testid={`${kind}-manual`}>
      <h2 className="text-base font-semibold">{t('directTax.deduct.manual')}</h2>
      <p className="text-sm text-fg-muted">{t('directTax.deduct.manualHint')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('directTax.cols.party')}>
          <Select
            value={partyId}
            onValueChange={(v) => {
              setPartyId(v);
              setResult(null);
            }}
          >
            <SelectTrigger className="w-56" aria-label={t('directTax.cols.party')}>
              <SelectValue placeholder={t('directTax.deduct.partyPick')} />
            </SelectTrigger>
            <SelectContent>
              {(parties.data ?? []).map((p) => (
                <SelectItem key={String(p['id'])} value={String(p['id'])}>
                  {String(p['name'])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t(kind === 'tds' ? 'directTax.deduct.rule' : 'directTax.deduct.ruleTcs')}>
          <Select
            value={rule}
            onValueChange={(v) => {
              setRule(v);
              setResult(null);
            }}
          >
            <SelectTrigger
              className="w-72"
              aria-label={t(kind === 'tds' ? 'directTax.deduct.rule' : 'directTax.deduct.ruleTcs')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {rules.map((r) => (
                <SelectItem key={r} value={r}>
                  {kind === 'tds' ? sectionLabel(t, r) : natureLabel(t, r)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t('directTax.cols.date')}>
          <Input
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setResult(null);
            }}
          />
        </Field>
        <Field label={t('directTax.deduct.amount')} className="min-w-64">
          <MoneyInput
            value={amount}
            onValueChange={(v) => {
              setAmount(v);
              setResult(null);
            }}
            data-testid={`${kind}-manual-amount`}
          />
        </Field>
        <Button
          variant="outline"
          disabled={!ready}
          onClick={() => void work()}
          data-testid={`${kind}-manual-work`}
        >
          {t('directTax.deduct.work')}
        </Button>
      </div>
      {result ? (
        <div
          className="flex flex-wrap items-center gap-3 text-sm"
          role="status"
          data-testid={`${kind}-manual-result`}
        >
          {result.applies ? (
            <>
              <span>
                {t('directTax.deduct.result')}: <MoneyText paise={result.taxPaise} /> (
                {pct(result.rateBp)} {t('directTax.cols.base').toLowerCase()}{' '}
                <MoneyText paise={result.basePaise} />)
              </span>
              <Button onClick={() => void save()}>{t('directTax.deduct.save')}</Button>
            </>
          ) : (
            <span>{t('directTax.deduct.resultNone', { why: result.why })}</span>
          )}
        </div>
      ) : null}
    </Card>
  );
}
