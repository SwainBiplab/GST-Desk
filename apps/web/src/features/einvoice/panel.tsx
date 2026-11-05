import { EinvoiceRepo, type Row } from '@gst/db';
import { today, type EinvProblem, type EwbTransport } from '@gst/domain';
import { qrMatrix } from '@gst/print';
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  toast,
} from '@gst/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useDocPortal, useNow } from './hooks';
import {
  canCancelEwb,
  canCancelIrn,
  canExtendEwb,
  ewbView,
  hoursLeft,
  irnState,
  istText,
  pendingOrFailed,
} from './model';

import { useAppDb } from '@/app/db';
import { dyn } from '@/lib/dyn-key';

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The signed QR as vector squares (what prints, drawn on screen). */
export function QrView({ data, size = 112 }: { data: string; size?: number }) {
  const { t } = useTranslation();
  const m = qrMatrix(data);
  const rects: string[] = [];
  m.dark.forEach((d, i) => {
    if (d) rects.push(`M${i % m.size} ${Math.floor(i / m.size)}h1v1h-1z`);
  });
  return (
    <svg
      role="img"
      aria-label={t('einv.panel.qr')}
      viewBox={`-2 -2 ${m.size + 4} ${m.size + 4}`}
      width={size}
      height={size}
      className="shrink-0 rounded-sm bg-white"
      data-testid="irn-qr"
    >
      <path d={rects.join('')} fill="#000" shapeRendering="crispEdges" />
    </svg>
  );
}

/** A request on its way, or the plain reason the last one failed, with what to do next. */
function JobNote({ jobs, kinds, retry }: { jobs: Row[]; kinds: string[]; retry?: () => void }) {
  const { t } = useTranslation();
  const { pending, failed } = pendingOrFailed(jobs, kinds);
  if (pending)
    return (
      <p className="text-sm text-fg-muted" data-testid="einv-queued">
        {t('einv.panel.queued')}
      </p>
    );
  if (failed)
    return (
      <div role="alert" className="text-sm text-danger" data-testid="einv-failed">
        {t('einv.panel.failed', { plain: failed.plain, next: failed.next })}
        {retry && (
          <Button variant="outline" className="ml-2" data-testid="einv-retry" onClick={retry}>
            {t('einv.panel.retry')}
          </Button>
        )}
      </div>
    );
  return null;
}

/** e-Invoice and e-way bill of one issued document. Shown only when e-invoicing is on. */
export function EinvoicePanel({
  documentId,
  number,
  type,
}: {
  documentId: string;
  number: string;
  type: string;
}) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const portal = useDocPortal(documentId);
  const now = useNow();
  const [problems, setProblems] = useState<EinvProblem[] | null>(null);
  const [cancel, setCancel] = useState<'irn' | { ewb: Row } | null>(null);
  const [ewbForm, setEwbForm] = useState<'new' | { kind: 'extend' | 'vehicle'; ewb: Row } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  if (!portal || !portal.on || !database || !ctx) return null;
  const repo = new EinvoiceRepo(database);
  const state = irnState(portal.einv, portal.jobs);
  const day = today(() => now);
  const canHaveIrn = ['tax_invoice', 'credit_note', 'debit_note'].includes(type);
  const canHaveEwb = ['tax_invoice', 'bill_of_supply', 'delivery_challan'].includes(type);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(msg(e));
    } finally {
      setBusy(false);
    }
  };
  const check = () =>
    run(async () => {
      const r = await repo.previewIrn(ctx, documentId, day);
      setProblems(r.problems);
    });
  const generate = () =>
    run(async () => {
      const r = await repo.requestIrn(ctx, documentId, day);
      setProblems(r.problems);
    });

  const ewbActive = portal.ewbs.filter((w) => w['status'] !== 'cancelled');

  return (
    <div className="flex flex-col gap-3" data-testid="einvoice-panel">
      {portal.cfg.mode === 'practice' && (
        <p className="rounded-md border border-border bg-surface-1 p-2 text-xs text-fg-muted">
          {t('einv.practice')}
        </p>
      )}

      <Card>
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-medium">{t('einv.panel.title')}</h3>
          <Badge
            tone={
              state.kind === 'active'
                ? 'success'
                : state.kind === 'failed' || state.kind === 'stopped'
                  ? 'danger'
                  : state.kind === 'none'
                    ? 'neutral'
                    : 'info'
            }
            data-testid="irn-status"
          >
            {t(dyn(`einv.status.${state.kind}`))}
          </Badge>
        </div>

        {!canHaveIrn && <p className="pt-2 text-sm text-fg-muted">{t('einv.panel.notNeeded')}</p>}

        {(state.kind === 'active' || state.kind === 'cancelled') && (
          <div className="flex gap-3 pt-3">
            {state.kind === 'active' && state.einv['signed_qr'] ? (
              <QrView data={String(state.einv['signed_qr'])} />
            ) : null}
            <dl className="min-w-0 text-sm">
              <dt className="text-fg-muted">{t('einv.panel.irn')}</dt>
              <dd className="break-all font-mono text-xs" data-testid="irn-value">
                {String(state.einv['irn'])}
              </dd>
              <dt className="pt-1 text-fg-muted">{t('einv.panel.ackNo')}</dt>
              <dd data-testid="irn-ack-no">{String(state.einv['ack_no'])}</dd>
              <dt className="pt-1 text-fg-muted">{t('einv.panel.ackDate')}</dt>
              <dd>{istText(String(state.einv['ack_date']))}</dd>
              {state.einv['recovered'] ? (
                <dd className="pt-1 text-xs text-fg-muted">{t('einv.panel.recovered')}</dd>
              ) : null}
            </dl>
          </div>
        )}

        <div className="flex flex-col gap-2 pt-3">
          {canHaveIrn &&
            (state.kind === 'none' || state.kind === 'failed' || state.kind === 'stopped') && (
              <>
                {problems && problems.length > 0 && (
                  <div role="alert" className="text-sm text-danger" data-testid="irn-problems">
                    <p>{t('einv.panel.problems', { count: problems.length })}</p>
                    <ul className="list-disc pl-5">
                      {problems.map((p) => (
                        <li key={`${p.path}:${p.code}`}>
                          <span className="font-mono text-xs">{p.path}</span> {p.message}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {problems && problems.length === 0 && (
                  <p className="text-sm text-success" data-testid="irn-ready">
                    {t('einv.panel.ready')}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" disabled={busy} data-testid="irn-check" onClick={check}>
                    {t('einv.panel.check')}
                  </Button>
                  <Button disabled={busy} data-testid="irn-generate" onClick={generate}>
                    {t('einv.panel.generate')}
                  </Button>
                </div>
              </>
            )}
          <JobNote
            jobs={portal.jobs}
            kinds={['irn']}
            {...(state.kind === 'failed' || state.kind === 'stopped' ? { retry: generate } : {})}
          />
          {state.kind === 'active' && (
            <>
              <JobNote jobs={portal.jobs} kinds={['irn_cancel']} />
              {canCancelIrn(state.einv, now) ? (
                <div>
                  <Button
                    variant="outline"
                    data-testid="irn-cancel"
                    disabled={busy}
                    onClick={() => setCancel('irn')}
                  >
                    {t('einv.panel.cancel')}
                  </Button>
                  <p className="pt-1 text-xs text-fg-muted">{t('einv.panel.cancelHint')}</p>
                </div>
              ) : (
                <p className="text-sm text-fg-muted" data-testid="irn-too-late">
                  {t('einv.panel.tooLate')}
                </p>
              )}
            </>
          )}
        </div>
      </Card>

      {canHaveEwb && (
        <Card>
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-medium">{t('einv.ewb.title')}</h3>
            {ewbActive.length === 0 && (
              <Button
                variant="outline"
                data-testid="ewb-new"
                disabled={busy}
                onClick={() => setEwbForm('new')}
              >
                {t('einv.ewb.generate')}
              </Button>
            )}
          </div>
          {portal.ewbs.length === 0 && (
            <p className="pt-2 text-sm text-fg-muted">{t('einv.ewb.none')}</p>
          )}
          {portal.ewbs.map((w) => (
            <EwbRow
              key={String(w['id'])}
              w={w}
              now={now}
              onExtend={() => setEwbForm({ kind: 'extend', ewb: w })}
              onVehicle={() => setEwbForm({ kind: 'vehicle', ewb: w })}
              onCancel={() => setCancel({ ewb: w })}
            />
          ))}
          <div className="pt-2">
            <JobNote
              jobs={portal.jobs}
              kinds={['ewb', 'ewb_cancel', 'ewb_extend', 'ewb_vehicle']}
            />
          </div>
        </Card>
      )}

      {cancel && (
        <CancelPortalDialog
          title={cancel === 'irn' ? t('einv.panel.cancelTitle', { number }) : t('einv.ewb.cancel')}
          busy={busy}
          onClose={() => setCancel(null)}
          onConfirm={(reason, remarks) =>
            run(async () => {
              if (cancel === 'irn')
                await repo.requestIrnCancel(ctx, documentId, reason, remarks, new Date());
              else
                await repo.requestEwbCancel(
                  ctx,
                  String(cancel.ewb['id']),
                  reason,
                  remarks,
                  new Date(),
                );
              setCancel(null);
            })
          }
        />
      )}
      {ewbForm && (
        <EwbDialog
          form={ewbForm}
          busy={busy}
          onClose={() => setEwbForm(null)}
          onSubmit={(go) =>
            run(async () => {
              const problemsOut = await go(repo);
              if (problemsOut && problemsOut.length > 0) {
                toast.error(problemsOut[0]!.message);
                return;
              }
              setEwbForm(null);
            })
          }
          documentId={documentId}
        />
      )}
    </div>
  );
}

function EwbRow({
  w,
  now,
  onExtend,
  onVehicle,
  onCancel,
}: {
  w: Row;
  now: Date;
  onExtend: () => void;
  onVehicle: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const view = ewbView(w, now);
  const left = hoursLeft(String(w['valid_until']), now);
  return (
    <div className="border-t border-border pt-2 text-sm" data-testid="ewb-row">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono" data-testid="ewb-no">
          {String(w['ewb_no'])}
        </span>
        <Badge tone={view === 'active' ? 'success' : view === 'expired' ? 'warning' : 'neutral'}>
          {view === 'cancelled'
            ? t('einv.ewb.cancelled')
            : left === null
              ? t('einv.ewb.expired')
              : t('einv.ewb.hoursLeft', { count: left })}
        </Badge>
      </div>
      <p className="text-fg-muted" data-testid="ewb-valid">
        {t('einv.ewb.validUntil', { date: istText(String(w['valid_until'])) })}
        {w['vehicle_no'] ? ` · ${String(w['vehicle_no'])}` : ''}
      </p>
      {view !== 'cancelled' && (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button variant="outline" data-testid="ewb-vehicle" onClick={onVehicle}>
            {t('einv.ewb.vehicleUpdate')}
          </Button>
          {canExtendEwb(w, now) && (
            <Button variant="outline" data-testid="ewb-extend" onClick={onExtend}>
              {t('einv.ewb.extend')}
            </Button>
          )}
          {canCancelEwb(w, now) && (
            <Button variant="outline" data-testid="ewb-cancel" onClick={onCancel}>
              {t('einv.ewb.cancel')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function CancelPortalDialog({
  title,
  busy,
  onClose,
  onConfirm,
}: {
  title: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: '1' | '2' | '3' | '4', remarks: string) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState<'1' | '2' | '3' | '4'>('2');
  const [remarks, setRemarks] = useState('');
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="portal-cancel-dialog">
        <DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
        <DialogDescription className="text-sm text-fg-muted">
          {t('einv.panel.cancelHint')}
        </DialogDescription>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('einv.panel.reason')}
          <Select value={reason} onValueChange={(v) => setReason(v as typeof reason)}>
            <SelectTrigger data-testid="portal-cancel-reason">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['1', '2', '3', '4'] as const).map((r) => (
                <SelectItem key={r} value={r}>
                  {t(dyn(`einv.panel.reasons.${r}`))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('einv.panel.remarks')}
          <Textarea
            rows={2}
            data-testid="portal-cancel-remarks"
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t('einv.panel.keep')}
          </Button>
          <Button
            variant="danger"
            disabled={busy || !remarks.trim()}
            data-testid="portal-cancel-confirm"
            onClick={() => onConfirm(reason, remarks.trim())}
          >
            {t('einv.panel.cancelConfirm')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type EwbGo = (repo: EinvoiceRepo) => Promise<EinvProblem[] | null>;

function EwbDialog({
  form,
  busy,
  onClose,
  onSubmit,
  documentId,
}: {
  form: 'new' | { kind: 'extend' | 'vehicle'; ewb: Row };
  busy: boolean;
  onClose: () => void;
  onSubmit: (go: EwbGo) => void;
  documentId: string;
}) {
  const { t } = useTranslation();
  const { ctx } = useAppDb();
  const kind = form === 'new' ? 'new' : form.kind;
  const [mode, setMode] = useState<EwbTransport['mode']>('road');
  const [distance, setDistance] = useState('0');
  const [vehicle, setVehicle] = useState('');
  const [transporter, setTransporter] = useState('');
  const [odc, setOdc] = useState(false);
  const [place, setPlace] = useState('');
  const [pincode, setPincode] = useState('');
  const [state, setState] = useState('');
  const [remaining, setRemaining] = useState('');
  const [remarks, setRemarks] = useState('');

  const field = (label: string, value: string, set: (v: string) => void, testid: string) => (
    <label className="flex flex-col gap-1 text-sm font-medium">
      {label}
      <Input data-testid={testid} value={value} onChange={(e) => set(e.target.value)} />
    </label>
  );

  const submit = () =>
    onSubmit(async (repo) => {
      if (!ctx) return null;
      if (form === 'new') {
        const transport: EwbTransport = {
          mode,
          distanceKm: Number(distance) || 0,
          vehicleType: odc ? 'odc' : 'regular',
          ...(vehicle.trim() ? { vehicleNo: vehicle.trim() } : {}),
          ...(transporter.trim() ? { transporterId: transporter.trim() } : {}),
        };
        const r = await repo.requestEwb(ctx, documentId, transport);
        return r.problems;
      }
      const id = String(form.ewb['id']);
      if (form.kind === 'extend')
        await repo.requestEwbExtend(
          ctx,
          id,
          {
            remainingKm: Number(remaining),
            fromPlace: place.trim(),
            fromState: state.trim(),
            fromPincode: pincode.trim(),
            reason: '99',
            remarks: remarks.trim(),
          },
          new Date(),
        );
      else
        await repo.requestVehicleUpdate(ctx, id, {
          vehicleNo: vehicle.trim(),
          fromPlace: place.trim(),
          fromState: state.trim(),
          reason: '4',
          remarks: remarks.trim(),
          mode: '1',
        });
      return null;
    });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="ewb-dialog">
        <DialogTitle className="text-lg font-semibold">
          {kind === 'new'
            ? t('einv.ewb.generate')
            : kind === 'extend'
              ? t('einv.ewb.extend')
              : t('einv.ewb.vehicleUpdate')}
        </DialogTitle>
        <DialogDescription className="sr-only">{t('einv.ewb.title')}</DialogDescription>
        {kind === 'new' && (
          <>
            <label className="flex flex-col gap-1 text-sm font-medium">
              {t('einv.ewb.mode')}
              <Select value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
                <SelectTrigger data-testid="ewb-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['road', 'rail', 'air', 'ship'] as const).map((m) => (
                    <SelectItem key={m} value={m}>
                      {t(dyn(`einv.ewb.modes.${m}`))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            {field(t('einv.ewb.distance'), distance, setDistance, 'ewb-distance')}
            <p className="text-xs text-fg-muted">{t('einv.ewb.distanceHint')}</p>
            {field(t('einv.ewb.vehicle'), vehicle, setVehicle, 'ewb-vehicle-no')}
            {field(t('einv.ewb.transporter'), transporter, setTransporter, 'ewb-transporter')}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={odc} onChange={(e) => setOdc(e.target.checked)} />
              {t('einv.ewb.odc')}
            </label>
          </>
        )}
        {kind === 'vehicle' && (
          <>
            {field(t('einv.ewb.vehicle'), vehicle, setVehicle, 'ewb-vehicle-no')}
            {field(t('einv.ewb.fromPlace'), place, setPlace, 'ewb-place')}
            {field(t('einv.ewb.fromState'), state, setState, 'ewb-state')}
          </>
        )}
        {kind === 'extend' && (
          <>
            {field(t('einv.ewb.remaining'), remaining, setRemaining, 'ewb-remaining')}
            {field(t('einv.ewb.fromPlace'), place, setPlace, 'ewb-place')}
            {field(t('einv.ewb.fromPincode'), pincode, setPincode, 'ewb-pincode')}
            {field(t('einv.ewb.fromState'), state, setState, 'ewb-state')}
          </>
        )}
        {kind !== 'new' && field(t('einv.ewb.remarks'), remarks, setRemarks, 'ewb-remarks')}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t('einv.panel.keep')}
          </Button>
          <Button disabled={busy} data-testid="ewb-submit" onClick={submit}>
            {t('einv.ewb.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
