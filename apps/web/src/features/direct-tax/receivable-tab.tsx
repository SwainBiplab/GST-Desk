import { DIRECT_TAX, receivableSummary, today } from '@gst/domain';
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

import { Field, fail, sectionLabel } from './common';
import { usePartyChoices, useReceivables, useTaxActions } from './hooks';

import { useConfirm } from '@/app/components/confirm';
import { dyn } from '@/lib/dyn-key';

const TONE = { expected: 'warning', certificate_received: 'info', claimed: 'success' } as const;

export function ReceivableTab({ fy }: { fy: string }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const actions = useTaxActions();
  const rows = useReceivables(fy).data ?? [];
  const summary = receivableSummary(rows)[0];
  const parties = usePartyChoices().data ?? [];
  const [partyId, setPartyId] = useState('');
  const [section, setSection] = useState('194C');
  const [date, setDate] = useState(today(() => new Date()));
  const [gross, setGross] = useState<bigint | null>(null);
  const [tds, setTds] = useState<bigint | null>(null);
  const [certNo, setCertNo] = useState('');
  const [certDate, setCertDate] = useState(today(() => new Date()));

  const add = async () => {
    try {
      await actions.addReceivable({
        partyId,
        section,
        date,
        grossPaise: gross ?? 0n,
        tdsPaise: tds ?? 0n,
      });
      setGross(null);
      setTds(null);
      toast.success(t('directTax.challan.saved'));
    } catch (e) {
      fail(e);
    }
  };
  const mark = async (id: string, status: 'expected' | 'certificate_received' | 'claimed') => {
    try {
      await actions.setReceivableStatus(
        id,
        status,
        certNo.trim() ? { no: certNo, date: certDate } : undefined,
      );
    } catch (e) {
      fail(e);
    }
  };
  const remove = async (id: string) => {
    if (
      !(await confirm({
        title: t('directTax.confirm.removeTitle'),
        description: t('directTax.confirm.removeBody'),
        confirmLabel: t('directTax.receivable.remove'),
      }))
    )
      return;
    try {
      await actions.removeReceivable(id);
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">{t('directTax.receivable.heading')}</h2>
        <p className="text-sm text-fg-muted">{t('directTax.receivable.hint')}</p>
        {summary ? (
          <dl className="flex flex-wrap gap-6 text-sm" data-testid="receivable-summary">
            <div>
              <dt className="text-fg-muted">{t('directTax.cols.deducted')}</dt>
              <dd className="font-medium">
                <MoneyText paise={summary.expectedPaise} />
              </dd>
            </div>
            <div>
              <dt className="text-fg-muted">{t('directTax.receivable.certificate_received')}</dt>
              <dd className="font-medium">
                <MoneyText paise={summary.certificatePaise} />
              </dd>
            </div>
            <div>
              <dt className="text-fg-muted">{t('directTax.receivable.toChase')}</dt>
              <dd className="font-medium">
                <MoneyText paise={summary.toChasePaise} />
              </dd>
            </div>
          </dl>
        ) : null}
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('directTax.receivable.certNo')}>
            <Input
              value={certNo}
              onChange={(e) => setCertNo(e.target.value)}
              data-testid="receivable-certno"
            />
          </Field>
          <Field label={t('directTax.receivable.certDate')}>
            <Input type="date" value={certDate} onChange={(e) => setCertDate(e.target.value)} />
          </Field>
        </div>
        {rows.length === 0 ? (
          <EmptyState title={t('directTax.receivable.none')} />
        ) : (
          <Table data-testid="receivable-table">
            <TableHead>
              <TableRow>
                <TableHeaderCell>{t('directTax.cols.party')}</TableHeaderCell>
                <TableHeaderCell>{t('directTax.cols.date')}</TableHeaderCell>
                <TableHeaderCell>{t('directTax.cols.section')}</TableHeaderCell>
                <TableHeaderCell className="text-right">
                  {t('directTax.cols.gross')}
                </TableHeaderCell>
                <TableHeaderCell className="text-right">
                  {t('directTax.cols.deducted')}
                </TableHeaderCell>
                <TableHeaderCell>{t('directTax.cols.status')}</TableHeaderCell>
                <TableHeaderCell>{t('directTax.cols.certificate')}</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.partyName}</TableCell>
                  <TableCell>{r.date}</TableCell>
                  <TableCell>{sectionLabel(t, r.section)}</TableCell>
                  <TableCell className="text-right">
                    <MoneyText paise={r.grossPaise} />
                  </TableCell>
                  <TableCell className="text-right">
                    <MoneyText paise={r.tdsPaise} />
                  </TableCell>
                  <TableCell>
                    <Badge tone={TONE[r.status]}>
                      {t(dyn(`directTax.receivable.${r.status}`))}
                    </Badge>
                  </TableCell>
                  <TableCell>{r.certificateNo}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {r.status === 'expected' ? (
                        <Button
                          variant="outline"
                          onClick={() => void mark(r.id, 'certificate_received')}
                          data-testid="receivable-received"
                        >
                          {t('directTax.receivable.markReceived')}
                        </Button>
                      ) : null}
                      {r.status === 'certificate_received' ? (
                        <Button variant="outline" onClick={() => void mark(r.id, 'claimed')}>
                          {t('directTax.receivable.markClaimed')}
                        </Button>
                      ) : null}
                      {r.status !== 'expected' ? (
                        <Button variant="ghost" onClick={() => void mark(r.id, 'expected')}>
                          {t('directTax.receivable.markExpected')}
                        </Button>
                      ) : null}
                      <Button variant="ghost" onClick={() => void remove(r.id)}>
                        {t('directTax.receivable.remove')}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card className="flex flex-col gap-3" data-testid="receivable-add">
        <h3 className="text-base font-semibold">{t('directTax.receivable.add')}</h3>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('directTax.receivable.party')}>
            <Select value={partyId} onValueChange={setPartyId}>
              <SelectTrigger className="w-56" aria-label={t('directTax.receivable.party')}>
                <SelectValue placeholder={t('directTax.deduct.partyPick')} />
              </SelectTrigger>
              <SelectContent>
                {parties.map((p) => (
                  <SelectItem key={String(p['id'])} value={String(p['id'])}>
                    {String(p['name'])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('directTax.receivable.section')}>
            <Select value={section} onValueChange={setSection}>
              <SelectTrigger className="w-64" aria-label={t('directTax.receivable.section')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DIRECT_TAX.tds.map((r) => (
                  <SelectItem key={r.section} value={r.section}>
                    {sectionLabel(t, r.section)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('directTax.cols.date')}>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label={t('directTax.receivable.gross')}>
            <MoneyInput value={gross} onValueChange={setGross} data-testid="receivable-gross" />
          </Field>
          <Field label={t('directTax.receivable.tds')}>
            <MoneyInput value={tds} onValueChange={setTds} data-testid="receivable-tds" />
          </Field>
          <Button disabled={!partyId} onClick={() => void add()} data-testid="receivable-save">
            {t('directTax.receivable.save')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
