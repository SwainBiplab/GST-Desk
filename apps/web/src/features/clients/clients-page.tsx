/**
 * Clients (prompt 47): the accountant's side. Every business shared with the account (and its own), each
 * with its filing cells, what is waiting and when it last synced; shares waiting to be accepted; and one
 * client opened read-only over the cloud: overview, documents inside the shared dates with their PDFs,
 * comments to the owner's inbox, and export packs built on the server. Nothing here changes a book.
 */
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  formatPaise,
  toast,
} from '@gst/ui';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  CloudClient,
  CloudError,
  readSession,
  type BoardCell,
  type ClientComment,
  type ClientDocument,
  type ClientOverview,
  type ClientRow,
  type ExportPack,
  type ShareInvite,
} from '@/features/cloud/client';
import { browserStore } from '@/features/team/source';
import { dyn } from '@/lib/dyn-key';

const errText = (e: unknown) =>
  e instanceof CloudError ? e.message : e instanceof Error ? e.message : String(e);
const when = (ms: number) => new Date(ms).toLocaleString();
const COLOUR: Record<BoardCell['status'], string> = {
  filed: 'bg-success/30',
  pushed: 'bg-info/30',
  exported: 'bg-info/15',
  late: 'bg-danger/40',
  open: 'bg-surface-2',
};
const TYPES = [
  'tax_invoice',
  'bill_of_supply',
  'credit_note',
  'debit_note',
  'purchase_bill',
] as const;
export const PACK_POLL_MS = 2000;

export function ClientsPage() {
  const { t } = useTranslation();
  const session = readSession(browserStore.get);
  const client = useCallback(
    () => new CloudClient(session?.baseUrl ?? '', session?.token ?? null),
    [session?.baseUrl, session?.token],
  );
  const [rows, setRows] = useState<ClientRow[] | null>(null);
  const [invites, setInvites] = useState<ShareInvite[]>([]);
  const [open, setOpen] = useState<ClientRow | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!session) return;
    let live = true;
    const c = client();
    void Promise.all([c.clients(), c.shareInvites()]).then(
      ([cl, inv]) => {
        if (!live) return;
        setRows(cl);
        setInvites(inv);
      },
      (e: unknown) => live && toast.error(errText(e)),
    );
    return () => {
      live = false;
    };
  }, [client, version]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!session)
    return (
      <div className="p-4">
        <p className="text-sm text-fg-muted" data-testid="clients-signed-out">
          {t('clients.signedOut')}
        </p>
      </div>
    );
  if (open)
    return (
      <ClientView
        c={client()}
        row={open}
        onBack={() => {
          setOpen(null);
          setVersion((v) => v + 1);
        }}
      />
    );
  const answer = async (id: string, accept: boolean) => {
    try {
      await client().answerShare(id, accept);
      if (accept) toast.success(t('sharing.invites.accepted'));
      setVersion((v) => v + 1);
    } catch (e) {
      toast.error(errText(e));
    }
  };
  return (
    <div className="flex flex-col gap-4 p-4" data-testid="clients-page">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">{t('clients.title')}</h1>
          <p className="text-sm text-fg-muted">{t('clients.help')}</p>
        </div>
        <Button variant="outline" onClick={() => setVersion((v) => v + 1)}>
          {t('clients.refresh')}
        </Button>
      </div>
      {invites.length > 0 && (
        <Card className="flex flex-col gap-2 p-3" data-testid="share-invites">
          <h2 className="font-medium">{t('sharing.invites.title')}</h2>
          <ul className="flex flex-col gap-2 text-sm">
            {invites.map((i) => (
              <li
                key={i.id}
                className="flex flex-wrap items-center gap-2"
                data-testid="share-invite"
              >
                <span>
                  {t('sharing.invites.offer', {
                    business: i.businessName,
                    org: i.orgName,
                    from: i.from,
                    to: i.to,
                  })}
                </span>
                {i.note && <span className="text-fg-muted">“{i.note}”</span>}
                <Button onClick={() => void answer(i.id, true)} data-testid="share-accept">
                  {t('sharing.invites.accept')}
                </Button>
                <Button variant="ghost" onClick={() => void answer(i.id, false)}>
                  {t('sharing.invites.decline')}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {rows && rows.length === 0 && (
        <p className="text-sm text-fg-muted" data-testid="clients-none">
          {t('clients.none')}
        </p>
      )}
      {rows && rows.length > 0 && (
        <Card className="overflow-auto p-2">
          <Table data-testid="clients-table">
            <TableHead>
              <TableRow>
                <TableHeaderCell>{t('filing.board.client')}</TableHeaderCell>
                <TableHeaderCell>{t('clients.overview.returns')}</TableHeaderCell>
                <TableHeaderCell />
                <TableHeaderCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r) => {
                const late = r.cells.filter((c) => c.status === 'late').length;
                return (
                  <TableRow key={`${r.orgId}${r.businessId}`} data-testid="client-row">
                    <TableCell>
                      <div className="font-medium">{r.businessName}</div>
                      <div className="text-xs text-fg-muted">
                        {r.orgName}
                        {r.gstin ? ` · ${r.gstin}` : ''}
                      </div>
                      <Badge tone={r.via === 'share' ? 'info' : 'neutral'}>
                        {t(dyn(`clients.via.${r.via}`))}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-0.5">
                        {r.cells.map((c) => (
                          <span
                            key={`${c.fp}${c.ret}`}
                            className={`inline-block h-4 w-4 rounded ${COLOUR[c.status]}`}
                            title={`${c.fp} ${c.ret}: ${t(dyn(`filing.board.status.${c.status}`))}`}
                          />
                        ))}
                      </div>
                      {late > 0 && (
                        <span className="text-xs text-danger">
                          {t('clients.late', { count: late })}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-fg-muted">
                      <div>{t('clients.documents', { count: r.documents })}</div>
                      <div>{t('clients.waiting', { count: r.waiting })}</div>
                      <div>
                        {r.lastSyncAt
                          ? t('clients.lastSync', { when: when(r.lastSyncAt) })
                          : t('clients.neverSynced')}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Button onClick={() => setOpen(r)} data-testid="client-open">
                        {t('clients.open')}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

function ClientView({ c, row, onBack }: { c: CloudClient; row: ClientRow; onBack: () => void }) {
  const { t } = useTranslation();
  const [ov, setOv] = useState<ClientOverview | null>(null);
  useEffect(() => {
    let live = true;
    void c.clientOverview(row.orgId, row.businessId).then(
      (v) => live && setOv(v),
      (e: unknown) => live && toast.error(errText(e)),
    );
    return () => {
      live = false;
    };
  }, [c, row.orgId, row.businessId]);
  const perms = row.share?.perms ?? null;
  return (
    <div className="flex flex-col gap-3 p-4" data-testid="client-view">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={onBack} data-testid="client-back">
          {t('clients.back')}
        </Button>
        <h1 className="text-xl font-semibold">{row.businessName}</h1>
        <span className="text-sm text-fg-muted">{row.orgName}</span>
      </div>
      <p className="text-sm text-fg-muted" data-testid="client-access">
        {row.share
          ? t('clients.readOnly', { from: row.share.from, to: row.share.to })
          : t('clients.member')}
      </p>
      <Tabs defaultValue="overview">
        <TabsList aria-label={t('clients.title')}>
          {(['overview', 'documents', 'comments', 'exports'] as const).map((k) => (
            <TabsTrigger key={k} value={k} data-testid={`client-tab-${k}`}>
              {t(dyn(`clients.tabs.${k}`))}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview">{ov && <Overview ov={ov} />}</TabsContent>
        <TabsContent value="documents">
          <Documents c={c} row={row} canComment={!perms || perms.comment} />
        </TabsContent>
        <TabsContent value="comments">
          <Comments c={c} row={row} canComment={!perms || perms.comment} />
        </TabsContent>
        <TabsContent value="exports">
          <Exports c={c} row={row} canExport={!perms || perms.export} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Overview({ ov }: { ov: ClientOverview }) {
  const { t } = useTranslation();
  const periods = [...new Set(ov.cells.map((c) => c.fp))];
  return (
    <div className="flex flex-col gap-3" data-testid="client-overview">
      <Card className="grid gap-2 p-3 text-sm md:grid-cols-3">
        <div>
          <div className="text-xs text-fg-muted">{t('clients.overview.gstin')}</div>
          <div>{ov.business.gstin ?? '—'}</div>
        </div>
        <div>
          <div className="text-xs text-fg-muted">{t('clients.overview.state')}</div>
          <div>{ov.business.stateCode}</div>
        </div>
        <div>
          <div className="text-xs text-fg-muted">{t('clients.overview.scheme')}</div>
          <div className="capitalize">{ov.business.scheme}</div>
        </div>
        <div>
          <div className="text-xs text-fg-muted">{t('clients.overview.sales')}</div>
          <div data-testid="client-count-sales">{ov.counts.sales}</div>
        </div>
        <div>
          <div className="text-xs text-fg-muted">{t('clients.overview.purchases')}</div>
          <div>{ov.counts.purchases}</div>
        </div>
        <div>
          <div className="text-xs text-fg-muted">{t('clients.overview.notes')}</div>
          <div>{ov.counts.notes}</div>
        </div>
      </Card>
      <Card className="p-3">
        <h2 className="pb-2 font-medium">{t('clients.overview.returns')}</h2>
        {ov.cells.length === 0 ? (
          <p className="text-sm text-fg-muted">{t('clients.overview.noGst')}</p>
        ) : (
          <table className="text-sm">
            <thead>
              <tr className="text-xs text-fg-muted">
                <th />
                {periods.map((p) => (
                  <th
                    key={p}
                    className="px-1 text-center"
                    colSpan={2}
                  >{`${p.slice(0, 2)}/${p.slice(2)}`}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td />
                {periods.flatMap((p) =>
                  (['gstr1', 'gstr3b'] as const).map((ret) => {
                    const cell = ov.cells.find((x) => x.fp === p && x.ret === ret);
                    return (
                      <td key={`${p}${ret}`} className="px-0.5">
                        <div
                          className={`h-6 w-8 rounded ${COLOUR[cell?.status ?? 'open']}`}
                          title={`${ret === 'gstr1' ? 'GSTR-1' : 'GSTR-3B'} · ${t(dyn(`filing.board.status.${cell?.status ?? 'open'}`))}${cell ? ` · ${t('filing.due', { date: cell.due })}` : ''}`}
                          data-testid="client-cell"
                          data-status={cell?.status ?? 'open'}
                        />
                      </td>
                    );
                  }),
                )}
              </tr>
            </tbody>
          </table>
        )}
        <ul className="flex flex-col gap-1 pt-2 text-sm">
          {ov.exceptions.map((e, i) => (
            <li key={i} className="flex items-center gap-2" data-testid="client-exception">
              <Badge tone={e.kind === 'overdue' ? 'danger' : 'warning'}>
                {t(dyn(`filing.board.kind.${e.kind}`))}
              </Badge>
              <span className="text-fg-muted">{e.message}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function Documents({
  c,
  row,
  canComment,
}: {
  c: CloudClient;
  row: ClientRow;
  canComment: boolean;
}) {
  const { t } = useTranslation();
  const [from, setFrom] = useState(row.share?.from ?? '');
  const [to, setTo] = useState(row.share?.to ?? '');
  const [type, setType] = useState('all');
  const [data, setData] = useState<{ rows: ClientDocument[]; count: number } | null>(null);
  const [limit, setLimit] = useState(50);
  const [detail, setDetail] = useState<{
    document: Record<string, unknown>;
    lines: Record<string, unknown>[];
  } | null>(null);
  const [commentOn, setCommentOn] = useState<ClientDocument | null>(null);
  const [text, setText] = useState('');

  useEffect(() => {
    let live = true;
    void c
      .clientDocuments(row.orgId, row.businessId, {
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(type !== 'all' ? { type } : {}),
        limit,
      })
      .then(
        (d) => live && setData(d),
        (e: unknown) => live && toast.error(errText(e)),
      );
    return () => {
      live = false;
    };
  }, [c, row.orgId, row.businessId, from, to, type, limit]);

  const pdf = async (d: ClientDocument) => {
    try {
      const blob = await c.clientPdf(row.orgId, row.businessId, d.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${d.number ?? d.id}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      toast.error(errText(e));
    }
  };
  const send = async () => {
    if (!commentOn) return;
    try {
      await c.addClientComment(row.orgId, {
        businessId: row.businessId,
        documentId: commentOn.id,
        text: text.trim(),
      });
      toast.success(t('clients.comments.sent'));
      setCommentOn(null);
      setText('');
    } catch (e) {
      toast.error(errText(e));
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid="client-documents">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm">
          {t('clients.docs.from')}
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('clients.docs.to')}
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('clients.docs.type')}
          <Select value={type} onValueChange={setType}>
            <SelectTrigger className="w-48" data-testid="client-doc-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('clients.docs.all')}</SelectItem>
              {TYPES.map((k) => (
                <SelectItem key={k} value={k}>
                  {t(dyn(`docs.types.${k}`))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        {data && (
          <span className="pb-2 text-sm text-fg-muted" data-testid="client-doc-count">
            {t('clients.docs.count', { count: data.count })}
          </span>
        )}
      </div>
      {data && data.rows.length === 0 && (
        <p className="text-sm text-fg-muted">{t('clients.docs.none')}</p>
      )}
      {data && data.rows.length > 0 && (
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell>{t('clients.docs.number')}</TableHeaderCell>
              <TableHeaderCell>{t('clients.docs.type')}</TableHeaderCell>
              <TableHeaderCell>{t('clients.docs.date')}</TableHeaderCell>
              <TableHeaderCell>{t('clients.docs.party')}</TableHeaderCell>
              <TableHeaderCell className="text-right">{t('clients.docs.total')}</TableHeaderCell>
              <TableHeaderCell>{t('clients.docs.status')}</TableHeaderCell>
              <TableHeaderCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {data.rows.map((d) => (
              <TableRow key={d.id} data-testid="client-doc-row">
                <TableCell>{d.number ?? '—'}</TableCell>
                <TableCell>{t(dyn(`docs.types.${d.type}`))}</TableCell>
                <TableCell>{d.date}</TableCell>
                <TableCell>{d.partyName ?? ''}</TableCell>
                <TableCell className="text-right">{formatPaise(d.totalPaise)}</TableCell>
                <TableCell>
                  <Badge tone={d.status === 'cancelled' ? 'danger' : 'neutral'}>{d.status}</Badge>
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      onClick={() =>
                        void c
                          .clientDocument(row.orgId, row.businessId, d.id)
                          .then(setDetail, (e: unknown) => toast.error(errText(e)))
                      }
                      data-testid="client-doc-lines"
                    >
                      {t('clients.docs.lines')}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => void pdf(d)}
                      data-testid="client-doc-pdf"
                    >
                      {t('clients.docs.pdf')}
                    </Button>
                    {canComment && (
                      <Button
                        variant="ghost"
                        onClick={() => setCommentOn(d)}
                        data-testid="client-doc-comment"
                      >
                        {t('clients.docs.comment')}
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {data && data.count > data.rows.length && (
        <div>
          <Button variant="outline" onClick={() => setLimit((l) => l + 50)}>
            {t('clients.docs.more')}
          </Button>
        </div>
      )}
      {detail && (
        <Dialog open onOpenChange={(o) => !o && setDetail(null)}>
          <DialogContent className="max-w-2xl" data-testid="client-doc-detail">
            <DialogTitle>{String(detail.document['number'] ?? '')}</DialogTitle>
            <table className="w-full text-sm">
              <tbody>
                {detail.lines.map((l, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="py-1 pr-2">{String(l['description'] ?? '')}</td>
                    <td className="py-1 pr-2">{String(l['hsn'] ?? '')}</td>
                    <td className="py-1 pr-2 text-right">
                      {(Number(l['qty_micros'] ?? 0) / 1_000_000).toString()}
                    </td>
                    <td className="py-1 text-right">
                      {formatPaise(Number(l['total_paise'] ?? 0))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex justify-end">
              <Button variant="outline" onClick={() => setDetail(null)}>
                {t('clients.docs.close')}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {commentOn && (
        <Dialog open onOpenChange={(o) => !o && setCommentOn(null)}>
          <DialogContent data-testid="client-comment-dialog">
            <DialogTitle>
              {t('clients.comments.about', { number: commentOn.number ?? '' })}
            </DialogTitle>
            <Textarea
              value={text}
              rows={4}
              placeholder={t('clients.comments.placeholder')}
              onChange={(e) => setText(e.target.value)}
              data-testid="client-comment-text"
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCommentOn(null)}>
                {t('clients.docs.close')}
              </Button>
              <Button
                onClick={() => void send()}
                disabled={!text.trim()}
                data-testid="client-comment-send"
              >
                {t('clients.comments.send')}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function Comments({ c, row, canComment }: { c: CloudClient; row: ClientRow; canComment: boolean }) {
  const { t } = useTranslation();
  const [list, setList] = useState<ClientComment[] | null>(null);
  const [text, setText] = useState('');
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    void c.clientComments(row.orgId, row.businessId).then(
      (v) => live && setList(v),
      (e: unknown) => live && toast.error(errText(e)),
    );
    return () => {
      live = false;
    };
  }, [c, row.orgId, row.businessId, version]);
  const send = async () => {
    try {
      await c.addClientComment(row.orgId, {
        businessId: row.businessId,
        documentId: null,
        text: text.trim(),
      });
      toast.success(t('clients.comments.sent'));
      setText('');
      setVersion((v) => v + 1);
    } catch (e) {
      toast.error(errText(e));
    }
  };
  return (
    <div className="flex flex-col gap-3" data-testid="client-comments">
      {canComment ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={text}
            rows={3}
            placeholder={t('clients.comments.placeholder')}
            onChange={(e) => setText(e.target.value)}
            data-testid="client-comments-text"
          />
          <div>
            <Button
              onClick={() => void send()}
              disabled={!text.trim()}
              data-testid="client-comments-send"
            >
              {t('clients.comments.send')}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-fg-muted">{t('clients.comments.notAllowed')}</p>
      )}
      {list && list.length === 0 && (
        <p className="text-sm text-fg-muted">{t('clients.comments.none')}</p>
      )}
      <ul className="flex flex-col gap-2 text-sm">
        {(list ?? []).map((m) => (
          <li key={m.id} className="rounded border border-border p-2" data-testid="client-comment">
            <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
              <span className="font-medium text-fg">{m.byName}</span>
              <span>
                {m.number
                  ? t('clients.comments.about', { number: m.number })
                  : t('clients.comments.general')}
              </span>
              <span>{when(m.createdAt)}</span>
              <Badge tone={m.status === 'pending' ? 'info' : 'neutral'}>
                {t(dyn(`clients.comments.status.${m.status}`))}
              </Badge>
            </div>
            <p className="whitespace-pre-wrap">{m.text}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Exports({ c, row, canExport }: { c: CloudClient; row: ClientRow; canExport: boolean }) {
  const { t } = useTranslation();
  const [from, setFrom] = useState(row.share?.from ?? '');
  const [to, setTo] = useState(row.share?.to ?? '');
  const [packs, setPacks] = useState<ExportPack[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const live = (packs ?? []).some((p) => p.status === 'queued' || p.status === 'running');

  useEffect(() => {
    let on = true;
    const load = () =>
      c.exportPacks(row.orgId, row.businessId).then(
        (v) => on && setPacks(v),
        (e: unknown) => on && toast.error(errText(e)),
      );
    void load();
    const id = live ? setInterval(() => void load(), PACK_POLL_MS) : null;
    return () => {
      on = false;
      if (id) clearInterval(id);
    };
  }, [c, row.orgId, row.businessId, version, live]);

  const build = async () => {
    setBusy(true);
    try {
      await c.requestExportPack(row.orgId, { businessId: row.businessId, from, to });
      setVersion((v) => v + 1);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const download = async (id: string) => {
    try {
      const { url } = await c.exportPackDownload(row.orgId, id);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      toast.error(errText(e));
    }
  };
  return (
    <div className="flex flex-col gap-3" data-testid="client-exports">
      <p className="text-sm text-fg-muted">{t('clients.exports.help')}</p>
      {canExport ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-sm">
            {t('clients.exports.from')}
            <Input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              data-testid="pack-from"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('clients.exports.to')}
            <Input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              data-testid="pack-to"
            />
          </label>
          <Button
            onClick={() => void build()}
            disabled={busy || !from || !to}
            data-testid="pack-build"
          >
            {busy ? t('clients.exports.building') : t('clients.exports.build')}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-fg-muted">{t('clients.exports.notAllowed')}</p>
      )}
      <h2 className="font-medium">{t('clients.exports.list')}</h2>
      {packs && packs.length === 0 && (
        <p className="text-sm text-fg-muted">{t('clients.exports.none')}</p>
      )}
      <ul className="flex flex-col gap-2 text-sm">
        {(packs ?? []).map((p) => (
          <li
            key={p.id}
            className="flex flex-wrap items-center gap-2"
            data-testid="pack-row"
            data-status={p.status}
          >
            <span>{t('sharing.span', { from: p.from, to: p.to })}</span>
            <Badge
              tone={p.status === 'done' ? 'success' : p.status === 'failed' ? 'danger' : 'info'}
            >
              {t(dyn(`clients.exports.status.${p.status}`))}
            </Badge>
            {p.sizeBytes != null && (
              <span className="text-fg-muted">
                {t('clients.exports.size', { size: (p.sizeBytes / 1_048_576).toFixed(1) })}
              </span>
            )}
            {p.manifest && p.manifest.warnings.length > 0 && (
              <span className="text-fg-muted" title={p.manifest.warnings.join('\n')}>
                {t('clients.exports.warnings', { count: p.manifest.warnings.length })}
              </span>
            )}
            {p.error && <span className="text-danger">{p.error}</span>}
            {p.status === 'done' && (
              <Button onClick={() => void download(p.id)} data-testid="pack-download">
                {t('clients.exports.download')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
