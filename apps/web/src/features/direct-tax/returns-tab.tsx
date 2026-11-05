import { buildReturn, quarterOf, quartersOfFy, today, type TaxQuarter } from '@gst/domain';
import {
  Badge,
  Button,
  Card,
  EmptyState,
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
} from '@gst/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Field, pct } from './common';
import { useChallans, useDeductions } from './hooks';
import {
  annexureCsv,
  annexureXlsx,
  certificateCsv,
  certificateRows,
  challanCsv,
  fileStem,
} from './model';

import { CSV_MIME, XLSX_MIME, downloadBytes } from '@/features/reports/download';

export function ReturnsTab({ fy }: { fy: string }) {
  const { t } = useTranslation();
  const deductions = useDeductions(fy).data ?? [];
  const challans = useChallans(fy).data ?? [];
  const quarters = quartersOfFy(fy);
  const now = quarterOf(today(() => new Date()));
  const [quarter, setQuarter] = useState<TaxQuarter['quarter']>(now.fy === fy ? now.quarter : 'Q4');
  const [kind, setKind] = useState<'tds' | 'tcs'>('tds');
  const [certParty, setCertParty] = useState('');
  const q = quarters.find((x) => x.quarter === quarter) ?? quarters[0]!;
  const report = buildReturn(kind, q, deductions, challans);
  const people = (() => {
    const m = new Map<string, string>();
    for (const r of report.rows) {
      const d = deductions.find((x) => x.kind === kind && x.partyName === r.name);
      if (d) m.set(d.partyId, d.partyName);
    }
    return [...m.entries()];
  })();

  const csv = () => downloadBytes(`${fileStem(report)}.csv`, annexureCsv(report), CSV_MIME);
  const xlsx = () =>
    downloadBytes(`${fileStem(report)}.xlsx`, annexureXlsx(report) as BlobPart, XLSX_MIME);
  const challanFile = () =>
    downloadBytes(`${fileStem(report)}_challans.csv`, challanCsv(report), CSV_MIME);
  const cert = () => {
    if (!certParty) return;
    const rows = certificateRows(kind, q, certParty, deductions, challans);
    downloadBytes(
      `${kind === 'tds' ? '16A' : '27D'}_${q.fy}_${q.quarter}.csv`,
      certificateCsv(kind, rows),
      CSV_MIME,
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">{t('directTax.returns.heading')}</h2>
        <p className="text-sm text-fg-muted">{t('directTax.returns.hint')}</p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('directTax.returns.form')}>
            <Select value={kind} onValueChange={(v) => setKind(v === 'tcs' ? 'tcs' : 'tds')}>
              <SelectTrigger
                className="w-32"
                aria-label={t('directTax.returns.form')}
                data-testid="return-kind"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tds">{t('directTax.returns.kinds.tds')}</SelectItem>
                <SelectItem value="tcs">{t('directTax.returns.kinds.tcs')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('directTax.returns.quarter')}>
            <Select value={quarter} onValueChange={(v) => setQuarter(v as TaxQuarter['quarter'])}>
              <SelectTrigger
                className="w-44"
                aria-label={t('directTax.returns.quarter')}
                data-testid="return-quarter"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {quarters.map((x) => (
                  <SelectItem key={x.quarter} value={x.quarter}>
                    {t('directTax.returns.quarterOption', {
                      quarter: x.quarter,
                      from: x.from,
                      to: x.to,
                    })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <span className="pb-2 text-sm text-fg-muted">
            {t('directTax.returns.due', { date: report.dueDate })}
          </span>
        </div>

        <dl className="flex flex-wrap gap-6 text-sm" data-testid="return-totals">
          <div>
            <dt className="text-fg-muted">{t('directTax.returns.rows')}</dt>
            <dd className="font-medium">{report.totals.deductions}</dd>
          </div>
          <div>
            <dt className="text-fg-muted">{t('directTax.returns.totalTax')}</dt>
            <dd className="font-medium">
              <MoneyText paise={report.totals.taxPaise} />
            </dd>
          </div>
          <div>
            <dt className="text-fg-muted">{t('directTax.returns.deposited')}</dt>
            <dd className="font-medium">
              <MoneyText paise={report.totals.depositedPaise} />
            </dd>
          </div>
        </dl>

        <section aria-label={t('directTax.returns.problems')} data-testid="return-problems">
          <h3 className="text-sm font-semibold">{t('directTax.returns.problems')}</h3>
          {report.problems.length === 0 ? (
            <p className="text-sm text-fg-muted">{t('directTax.returns.noProblems')}</p>
          ) : (
            <ul className="mt-1 flex flex-col gap-1 text-sm">
              {report.problems.map((p, i) => (
                <li key={`${p.code}-${p.ref ?? i}`} className="flex items-start gap-2">
                  <Badge tone={p.severity === 'error' ? 'danger' : 'warning'}>
                    {t(`directTax.returns.severity.${p.severity}`)}
                  </Badge>
                  <span>{p.message}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="flex flex-wrap gap-2">
          <Button disabled={report.rows.length === 0} onClick={csv} data-testid="return-csv">
            {t('directTax.returns.downloadCsv')}
          </Button>
          <Button
            variant="outline"
            disabled={report.rows.length === 0}
            onClick={xlsx}
            data-testid="return-xlsx"
          >
            {t('directTax.returns.downloadXlsx')}
          </Button>
          <Button variant="outline" disabled={report.challans.length === 0} onClick={challanFile}>
            {t('directTax.returns.downloadChallan')}
          </Button>
        </div>
      </Card>

      <Card className="flex flex-col gap-3">
        {report.rows.length === 0 ? (
          <EmptyState title={t('directTax.returns.empty')} />
        ) : (
          <Table data-testid="return-rows">
            <TableHead>
              <TableRow>
                <TableHeaderCell>#</TableHeaderCell>
                <TableHeaderCell>{t('directTax.cols.party')}</TableHeaderCell>
                <TableHeaderCell>{t('directTax.cols.pan')}</TableHeaderCell>
                <TableHeaderCell>{t('directTax.cols.section')}</TableHeaderCell>
                <TableHeaderCell>{t('directTax.cols.date')}</TableHeaderCell>
                <TableHeaderCell className="text-right">{t('directTax.cols.base')}</TableHeaderCell>
                <TableHeaderCell className="text-right">{t('directTax.cols.rate')}</TableHeaderCell>
                <TableHeaderCell className="text-right">{t('directTax.cols.tax')}</TableHeaderCell>
                <TableHeaderCell>{t('directTax.cols.challan')}</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {report.rows.map((r) => (
                <TableRow key={`${r.serial}-${r.documentNumber}`}>
                  <TableCell>{r.serial}</TableCell>
                  <TableCell>{r.name}</TableCell>
                  <TableCell>{r.pan}</TableCell>
                  <TableCell>{r.code || r.section}</TableCell>
                  <TableCell>{r.date}</TableCell>
                  <TableCell className="text-right">
                    <MoneyText paise={r.basePaise} />
                  </TableCell>
                  <TableCell className="text-right">{pct(r.rateBp)}</TableCell>
                  <TableCell className="text-right">
                    <MoneyText paise={r.taxPaise} />
                  </TableCell>
                  <TableCell>{r.challan ? `${r.challan.bsr} / ${r.challan.serial}` : ''}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card className="flex flex-col gap-3" data-testid="certificates">
        <h3 className="text-base font-semibold">{t('directTax.returns.certificates')}</h3>
        <p className="text-sm text-fg-muted">{t('directTax.returns.certificatesHint')}</p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('directTax.returns.certificateFor')}>
            <Select value={certParty} onValueChange={setCertParty}>
              <SelectTrigger className="w-64" aria-label={t('directTax.returns.certificateFor')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {people.map(([id, name]) => (
                  <SelectItem key={id} value={id}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Button variant="outline" disabled={!certParty} onClick={cert}>
            {t('directTax.returns.certificateDownload')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
