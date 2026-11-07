import type { BookImportPlan, BookImportResult } from '@gst/db';
import { toDecimalString } from '@gst/domain';
import { DOCUMENT_TEMPLATE, type ImportBundle, type ImportSource } from '@gst/interop';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  RadioGroup,
  RadioGroupItem,
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

import { useMigrateActions, useMigrationLog } from './hooks';
import { MappingEditor } from './mapping-editor';
import {
  FIELDS_OF,
  bundleFromSheets,
  detectFor,
  guessSheets,
  issuesCsv,
  missingFields,
  type Role,
  type SheetState,
} from './model';
import { readSheetsFile, readTallyFile } from './read-file';

import { useAppNavigate } from '@/app/hooks';
import type { Shell } from '@/app/store';
import { CSV_MIME, downloadBytes } from '@/features/reports/download';
import { dyn } from '@/lib/dyn-key';

type Step = 'source' | 'file' | 'map' | 'review' | 'done';
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const NO_SHEET = '__none__';
const MAX_ROWS = 300;
/** Largest files accepted: a Tally export of this size holds well over a million vouchers. */
const MAX_TALLY_MB = 300;
const MAX_SHEET_MB = 50;
const money = (p: bigint | null): string => (p === null ? '' : toDecimalString(p, 2));

/** Bring data in: pick where it comes from, pick the file, set up the columns, look at a dry run, import. */
export function ImportFlow({ shell }: { shell: Shell }) {
  const { t } = useTranslation();
  const actions = useMigrateActions();
  const go = useAppNavigate();
  const log = useMigrationLog().data ?? [];
  const [step, setStep] = useState<Step>('source');
  const [source, setSource] = useState<ImportSource>('tally');
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [sheets, setSheets] = useState<SheetState[]>([]);
  const [bundle, setBundle] = useState<ImportBundle | null>(null);
  const [plan, setPlan] = useState<BookImportPlan | null>(null);
  const [result, setResult] = useState<BookImportResult | null>(null);

  const reset = () => {
    setStep('source');
    setSheets([]);
    setBundle(null);
    setPlan(null);
    setResult(null);
    setFileName('');
    setProgress(0);
  };

  const review = async (b: ImportBundle) => {
    setBusy(true);
    try {
      setBundle(b);
      setPlan(await actions.plan(b));
      setStep('review');
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    setBusy(true);
    setProgress(0);
    // bounded on purpose: the Tally reader streams, but a plan over a file this size would still take minutes
    const limitMb = source === 'tally' ? MAX_TALLY_MB : MAX_SHEET_MB;
    if (file.size > limitMb * 1024 * 1024) {
      toast.error(t('migrate.file.tooBig', { name: file.name, limit: `${limitMb} MB` }));
      setBusy(false);
      return;
    }
    try {
      if (source === 'tally') {
        const b = await readTallyFile(file, setProgress);
        await review(b);
        return;
      }
      const prepared = await readSheetsFile(file);
      if (prepared.length === 0) {
        toast.error(t('migrate.file.empty'));
        return;
      }
      setSheets(guessSheets(prepared));
      setStep('map');
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const patchSheet = (id: string, patch: Partial<SheetState>) =>
    setSheets((all) => all.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const setRole = (s: SheetState, role: Role) =>
    patchSheet(s.id, { role, mapping: detectFor(role, s.headers), linesFrom: '' });

  const blocked = sheets.filter((s) => missingFields(s.role, s.mapping).length > 0);
  const usable = sheets.some((s) => s.role !== 'skip');

  const doImport = async () => {
    if (!bundle) return;
    setBusy(true);
    try {
      setResult(await actions.apply(bundle, fileName));
      setStep('done');
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const importable = plan ? plan.documents.filter((d) => d.action === 'import').length : 0;
  const nothing =
    !!plan &&
    importable === 0 &&
    plan.parties.create + plan.items.create === 0 &&
    plan.payments.every((p) => p.action === 'skip');

  return (
    <div className="flex flex-col gap-4" data-testid="import-flow" data-step={step}>
      {step === 'source' && (
        <Card className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">{t('migrate.source.heading')}</h2>
          <RadioGroup
            value={source}
            onValueChange={(v) => setSource(v as ImportSource)}
            aria-label={t('migrate.source.heading')}
            className="flex flex-col gap-2"
          >
            {(['tally', 'vyapar', 'excel'] as const).map((s) => (
              <label
                key={s}
                htmlFor={`source-${s}`}
                className="flex items-start gap-3 rounded-lg border border-border p-3"
              >
                <RadioGroupItem id={`source-${s}`} value={s} data-testid={`source-${s}`} />
                <span>
                  <span className="block font-medium">{t(dyn(`migrate.source.${s}.title`))}</span>
                  <span className="block text-sm text-fg-muted">
                    {t(dyn(`migrate.source.${s}.help`))}
                  </span>
                </span>
              </label>
            ))}
          </RadioGroup>
          <div>
            <Button onClick={() => setStep('file')} data-testid="source-next">
              {t('migrate.next')}
            </Button>
          </div>
        </Card>
      )}

      {step === 'file' && (
        <Card className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">
            {t(source === 'tally' ? 'migrate.file.tally' : 'migrate.file.sheets')}
          </h2>
          <p className="text-sm text-fg-muted">
            {t(source === 'tally' ? 'migrate.file.tallyHelp' : 'migrate.file.sheetsHelp')}
          </p>
          <input
            type="file"
            data-testid="migrate-file"
            accept={source === 'tally' ? '.xml,text/xml' : '.xlsx,.csv,.txt'}
            aria-label={t(source === 'tally' ? 'migrate.file.tally' : 'migrate.file.sheets')}
            disabled={busy}
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
          {busy ? (
            <div role="status" className="text-sm">
              {t('migrate.file.reading', { name: fileName })}
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress * 100)}
                className="mt-1 h-2 w-64 overflow-hidden rounded bg-surface-2"
              >
                <div
                  className="h-full bg-accent"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>
            </div>
          ) : null}
          {source !== 'tally' ? (
            <div>
              <Button
                variant="outline"
                onClick={() => downloadBytes('documents-template.csv', DOCUMENT_TEMPLATE, CSV_MIME)}
              >
                {t('migrate.file.template')}
              </Button>
            </div>
          ) : null}
          <div>
            <Button variant="ghost" onClick={() => setStep('source')} disabled={busy}>
              {t('migrate.back')}
            </Button>
          </div>
        </Card>
      )}

      {step === 'map' && (
        <div className="flex flex-col gap-4" data-testid="map-step">
          <p className="text-sm text-fg-muted">{t('migrate.map.hint')}</p>
          {sheets.map((s) => (
            <Card key={s.id} className="flex flex-col gap-3" data-testid="sheet-card">
              <div className="flex flex-wrap items-end gap-3">
                <h3 className="text-base font-semibold">
                  {t('migrate.map.sheet', { label: s.label })}
                </h3>
                <span className="text-sm text-fg-muted">
                  {t('migrate.map.rows', { count: s.rows.length })}
                </span>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-fg-muted">{t('migrate.map.role')}</span>
                  <Select value={s.role} onValueChange={(v) => setRole(s, v as Role)}>
                    <SelectTrigger
                      className="w-64"
                      aria-label={t('migrate.map.role')}
                      data-testid="sheet-role"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(['parties', 'items', 'sales', 'purchases', 'skip'] as const).map((r) => (
                        <SelectItem key={r} value={r}>
                          {t(dyn(`migrate.map.roles.${r}`))}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                {(s.role === 'sales' || s.role === 'purchases') && sheets.length > 1 ? (
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-fg-muted">{t('migrate.map.linesFrom')}</span>
                    <Select
                      value={s.linesFrom || NO_SHEET}
                      onValueChange={(v) =>
                        patchSheet(s.id, { linesFrom: v === NO_SHEET ? '' : v })
                      }
                    >
                      <SelectTrigger className="w-56" aria-label={t('migrate.map.linesFrom')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_SHEET}>{t('migrate.map.sameSheet')}</SelectItem>
                        {sheets
                          .filter((o) => o.id !== s.id)
                          .map((o) => (
                            <SelectItem key={o.id} value={o.id}>
                              {t('migrate.map.sheet', { label: o.label })}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </label>
                ) : null}
              </div>
              {s.role !== 'skip' && !s.linesFrom ? (
                <>
                  <MappingEditor
                    fields={FIELDS_OF[s.role]}
                    headers={s.headers}
                    mapping={s.mapping}
                    onChange={(mapping) => patchSheet(s.id, { mapping })}
                    testId="mapping-editor"
                  />
                  {missingFields(s.role, s.mapping).length > 0 ? (
                    <p role="alert" className="text-sm text-danger">
                      {t('migrate.map.missing', {
                        fields: missingFields(s.role, s.mapping)
                          .map((k) => t(dyn(`migrate.fields.${k}`)))
                          .join(', '),
                      })}
                    </p>
                  ) : null}
                </>
              ) : null}
              {s.role !== 'skip' ? (
                <div className="overflow-auto">
                  <Table>
                    <TableHead>
                      <TableRow>
                        {s.headers.map((h, i) => (
                          <TableHeaderCell key={`${i}-${h}`}>{h}</TableHeaderCell>
                        ))}
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {s.rows.slice(0, 3).map((r, ri) => (
                        <TableRow key={ri}>
                          {s.headers.map((_, i) => (
                            <TableCell key={i}>{r[i] ?? ''}</TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : null}
            </Card>
          ))}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setStep('file')} disabled={busy}>
              {t('migrate.back')}
            </Button>
            <Button
              disabled={busy || !usable || blocked.length > 0}
              onClick={() =>
                void review(bundleFromSheets(source === 'vyapar' ? 'vyapar' : 'excel', sheets))
              }
              data-testid="map-next"
            >
              {t('migrate.map.continue')}
            </Button>
          </div>
        </div>
      )}

      {step === 'review' && plan && bundle && (
        <div className="flex flex-col gap-4" data-testid="review-step">
          <Card className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">{t('migrate.review.heading')}</h2>
            <p className="text-sm text-fg-muted">{t('migrate.review.hint')}</p>
            <dl className="flex flex-wrap gap-6 text-sm" data-testid="review-counts">
              <Count
                label={t('migrate.review.parties')}
                value={t('migrate.review.newOld', {
                  create: plan.parties.create,
                  matched: plan.parties.matched,
                })}
              />
              <Count
                label={t('migrate.review.items')}
                value={t('migrate.review.newOld', {
                  create: plan.items.create,
                  matched: plan.items.matched,
                })}
              />
              <Count
                label={t('migrate.review.documents')}
                value={t('migrate.review.importSkip', {
                  count: importable,
                  skipped: plan.documents.length - importable,
                })}
              />
              <Count
                label={t('migrate.review.payments')}
                value={String(plan.payments.filter((p) => p.action === 'import').length)}
              />
            </dl>
            {nothing ? <EmptyState title={t('migrate.review.nothing')} /> : null}
          </Card>

          {plan.documents.length > 0 ? (
            <Card className="flex flex-col gap-2">
              <Table data-testid="review-documents">
                <TableHead>
                  <TableRow>
                    <TableHeaderCell>{t('migrate.review.where')}</TableHeaderCell>
                    <TableHeaderCell>{t('migrate.review.number')}</TableHeaderCell>
                    <TableHeaderCell>{t('migrate.review.action')}</TableHeaderCell>
                    <TableHeaderCell className="text-right">
                      {t('migrate.review.fileTotal')}
                    </TableHeaderCell>
                    <TableHeaderCell className="text-right">
                      {t('migrate.review.engineTotal')}
                    </TableHeaderCell>
                    <TableHeaderCell className="text-right">
                      {t('migrate.review.difference')}
                    </TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {plan.documents.slice(0, MAX_ROWS).map((d, i) => (
                    <TableRow key={`${d.ref}-${i}`}>
                      <TableCell>{d.ref}</TableCell>
                      <TableCell>
                        {d.number}
                        {d.number !== d.originalNumber ? (
                          <span className="text-xs text-fg-muted">
                            {' '}
                            ({t('migrate.review.was', { number: d.originalNumber })})
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Badge tone={d.action === 'import' ? 'success' : 'danger'}>
                          {t(
                            d.action === 'import'
                              ? 'migrate.review.willImport'
                              : 'migrate.review.willSkip',
                          )}
                        </Badge>
                        {d.reason ? (
                          <span className="ml-2 text-xs text-fg-muted">{d.reason}</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right">{money(d.fileTotalPaise)}</TableCell>
                      <TableCell className="text-right">{money(d.engineTotalPaise)}</TableCell>
                      <TableCell className="text-right">{money(d.differencePaise)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {plan.documents.length > MAX_ROWS ? (
                <p className="text-sm text-fg-muted">
                  {t('migrate.review.more', { count: plan.documents.length - MAX_ROWS })}
                </p>
              ) : null}
            </Card>
          ) : null}

          <Card className="flex flex-col gap-2" data-testid="review-issues">
            <h3 className="text-base font-semibold">{t('migrate.review.issues')}</h3>
            {plan.issues.filter((i) => i.severity !== 'info').length === 0 ? (
              <p className="text-sm text-fg-muted">{t('migrate.review.noIssues')}</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {plan.issues
                  .filter((i) => i.severity !== 'info')
                  .slice(0, MAX_ROWS)
                  .map((i, n) => (
                    <li key={n} className="flex items-start gap-2">
                      <Badge tone={i.severity === 'error' ? 'danger' : 'warning'}>
                        {t(
                          i.severity === 'error'
                            ? 'migrate.review.error'
                            : 'migrate.review.warning',
                        )}
                      </Badge>
                      <span className="text-fg-muted">{i.ref}</span>
                      <span>{i.message}</span>
                    </li>
                  ))}
              </ul>
            )}
            <div>
              <Button
                variant="outline"
                onClick={() => downloadBytes('import-report.csv', issuesCsv(plan.issues), CSV_MIME)}
              >
                {t('migrate.review.report')}
              </Button>
            </div>
          </Card>

          <div className="flex gap-2">
            <Button
              variant="ghost"
              onClick={() => setStep(source === 'tally' ? 'file' : 'map')}
              disabled={busy}
            >
              {t('migrate.back')}
            </Button>
            <Button
              disabled={busy || nothing}
              onClick={() => void doImport()}
              data-testid="do-import"
            >
              {t('migrate.review.import')}
            </Button>
          </div>
        </div>
      )}

      {step === 'done' && result && (
        <Card className="flex flex-col gap-3" data-testid="import-done">
          <h2 className="text-base font-semibold">{t('migrate.done.heading')}</h2>
          <ul className="text-sm" data-testid="import-result">
            <li>{t('migrate.done.parties', { count: result.parties })}</li>
            <li>{t('migrate.done.items', { count: result.items })}</li>
            <li>{t('migrate.done.documents', { count: result.documents })}</li>
            <li>{t('migrate.done.payments', { count: result.payments })}</li>
            {result.skipped > 0 ? (
              <li>{t('migrate.done.skipped', { count: result.skipped })}</li>
            ) : null}
          </ul>
          <p className="text-sm text-fg-muted">{t('migrate.done.imported')}</p>
          <div className="flex gap-2">
            <Button onClick={() => go(`/${shell}/documents`)} data-testid="open-documents">
              {t('migrate.done.open')}
            </Button>
            <Button variant="outline" onClick={reset}>
              {t('migrate.done.another')}
            </Button>
          </div>
        </Card>
      )}

      {log.length > 0 ? (
        <Card className="flex flex-col gap-2" data-testid="migration-log">
          <h3 className="text-base font-semibold">{t('migrate.log.heading')}</h3>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>{t('migrate.log.when')}</TableHeaderCell>
                <TableHeaderCell>{t('migrate.log.source')}</TableHeaderCell>
                <TableHeaderCell>{t('migrate.log.file')}</TableHeaderCell>
                <TableHeaderCell className="text-right">
                  {t('migrate.log.documents')}
                </TableHeaderCell>
                <TableHeaderCell className="text-right">
                  {t('migrate.log.problems')}
                </TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {[...log]
                .reverse()
                .slice(0, 10)
                .map((r) => (
                  <TableRow key={r.at}>
                    <TableCell>{r.at.slice(0, 16).replace('T', ' ')}</TableCell>
                    <TableCell>
                      {t(dyn(`migrate.source.${r.source}.title`), { defaultValue: r.source })}
                    </TableCell>
                    <TableCell>{r.fileName}</TableCell>
                    <TableCell className="text-right">{r.documents}</TableCell>
                    <TableCell className="text-right">{r.problems}</TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </Card>
      ) : null}
    </div>
  );
}

function Count({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
