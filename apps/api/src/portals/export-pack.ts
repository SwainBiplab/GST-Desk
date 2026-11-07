/**
 * The accountant's export pack (prompt 47): one ZIP for a business and a span of dates with the registers, the
 * GSTR-1 and GSTR-3B files of every month (and the problems standing against each), the Tally masters and
 * vouchers, the party statements and balances, and the PDFs of the sales documents. Built as a job and put in
 * the organisation's temporary store, where it expires in seven days; the answer is a signed download link.
 */
import {
  GstrRepo,
  InteropRepo,
  PartyRepo,
  REPORTS,
  exportReport,
  getPartyStatement,
  newId,
  runReport,
  type Ctx,
  type ReportId,
  type ReportRow,
  type Row,
} from '@gst/db';
import {
  gstr1Json,
  gstr3bJson,
  periodsBetween,
  toCsv,
  today as istToday,
  type CsvValue,
} from '@gst/domain';
import { buildTallyMasters, buildTallyVouchers } from '@gst/interop';
import { zipSync } from 'fflate';
import type { Logger } from 'pino';

import { inOrg } from '../auth/permissions';
import type { PgDatabase } from '../db/pool';
import { renderDocumentPdf } from '../messaging/pdf';
import type { Storage } from '../storage/s3';

export const PDF_CAP = 300;

export interface PackManifest {
  business: { name: string; gstin: string | null };
  from: string;
  to: string;
  generatedAt: number;
  files: { name: string; bytes: number }[];
  counts: Record<string, number>;
  warnings: string[];
}

export interface PackView {
  id: string;
  businessId: string;
  from: string;
  to: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  sizeBytes: number | null;
  manifest: PackManifest | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export class PackError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'no_storage' | 'validation' | 'not_ready',
  ) {
    super(message);
  }
}

const csvOf = (columns: readonly { key: string; kind: string }[], rows: ReportRow[]): string => {
  const out: CsvValue[][] = [columns.map((c) => c.key)];
  for (const r of rows)
    out.push(
      columns.map((c) => {
        const v = r[c.key];
        if (v == null) return '';
        if (c.kind === 'money') return { numeric: (Number(v) / 100).toFixed(2) };
        return typeof v === 'number' ? { numeric: String(v) } : String(v);
      }),
    );
  return toCsv(out);
};

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
const enc = new TextEncoder();

/** The files of a pack, in memory. Pure of storage; the job wraps it. */
export async function buildExportPack(
  db: PgDatabase,
  ctx: Ctx,
  from: string,
  to: string,
  now: number,
): Promise<{ zip: Uint8Array; manifest: PackManifest }> {
  const files: Record<string, Uint8Array> = {};
  const warnings: string[] = [];
  const counts: Record<string, number> = {};
  const today = istToday(() => new Date(now));
  const gr = new GstrRepo(db);
  const info = await gr.businessInfo(ctx);
  const [biz] = await inOrg(
    db,
    ctx.orgId,
    (tx) => tx`SELECT trade_name, legal_name FROM businesses WHERE id = ${ctx.businessId}`,
  );
  const businessName = String(biz?.['trade_name'] || biz?.['legal_name'] || '');
  const put = (name: string, text: string | Uint8Array) => {
    files[name] = typeof text === 'string' ? enc.encode(text) : text;
  };

  // registers
  for (const id of ['sales_register', 'purchase_register', 'note_register'] as const) {
    const rows: ReportRow[] = [];
    await exportReport(db, ctx, id, { from, to, today }, (batch) => {
      rows.push(...batch);
    });
    put(`registers/${id.replace('_', '-')}.csv`, csvOf(REPORTS[id].columns, rows));
    counts[id] = rows.length;
  }
  for (const id of [
    'gst_summary',
    'hsn_summary',
    'party_outstanding',
  ] as const satisfies ReportId[]) {
    const r = await runReport(db, ctx, id, { from, to, today });
    put(
      `${id === 'party_outstanding' ? 'ledger' : 'gst'}/${id.replace('_', '-')}.csv`,
      csvOf(REPORTS[id].columns, r.rows),
    );
    counts[id] = r.rows.length;
  }

  // the return files of each month, and what stands against them
  if (info.gstin) {
    for (const p of periodsBetween(info.gstin, from, to, 'month')) {
      try {
        const review = await gr.review(ctx, p, { today });
        put(
          `gst/GSTR1_${info.gstin}_${p.fp}.json`,
          JSON.stringify(gstr1Json(review.gstr1), null, 2),
        );
        put(
          `gst/GSTR3B_${info.gstin}_${p.fp}.json`,
          JSON.stringify(gstr3bJson(review.gstr3b), null, 2),
        );
        if (review.issues.length)
          put(`gst/issues_${p.fp}.json`, JSON.stringify(review.issues, null, 2));
        if (review.blockers > 0)
          warnings.push(
            `${p.fp}: ${review.blockers} problem(s) standing; the files are as the books are`,
          );
      } catch (e) {
        warnings.push(`${p.fp}: return files not built (${(e as Error).message})`);
      }
    }
  } else warnings.push('No GSTIN on the business: no return files');

  // Tally
  try {
    const input = await new InteropRepo(db).tallyInput(ctx, from, to);
    const masters = buildTallyMasters(input);
    const vouchers = buildTallyVouchers(input);
    put('tally/masters.xml', masters.xml);
    put('tally/vouchers.xml', vouchers.xml);
    counts['tally_vouchers'] = vouchers.counts.vouchers;
    warnings.push(
      ...masters.warnings.map((w) => `tally: ${w}`),
      ...vouchers.warnings.map((w) => `tally: ${w}`),
    );
  } catch (e) {
    warnings.push(`tally: not built (${(e as Error).message})`);
  }

  // party statements
  const parties = await new PartyRepo(db).listLite(ctx);
  const stRows: CsvValue[][] = [
    ['party', 'gstin', 'date', 'kind', 'ref', 'description', 'debit', 'credit', 'balance'],
  ];
  let statements = 0;
  for (const p of parties) {
    const st = await getPartyStatement(db, ctx, p.id, { from, to });
    if (!st.lines.length && st.openingBalancePaise === 0n) continue;
    statements++;
    stRows.push([
      p.name,
      p.gstin ?? '',
      from,
      'opening',
      '',
      'Opening balance',
      {
        numeric:
          st.openingBalancePaise > 0n ? (Number(st.openingBalancePaise) / 100).toFixed(2) : '0.00',
      },
      {
        numeric:
          st.openingBalancePaise < 0n ? (Number(-st.openingBalancePaise) / 100).toFixed(2) : '0.00',
      },
      { numeric: (Number(st.openingBalancePaise) / 100).toFixed(2) },
    ]);
    for (const l of st.lines)
      stRows.push([
        p.name,
        p.gstin ?? '',
        l.date,
        l.kind,
        l.ref,
        l.description,
        { numeric: (Number(l.debitPaise) / 100).toFixed(2) },
        { numeric: (Number(l.creditPaise) / 100).toFixed(2) },
        { numeric: (Number(l.balancePaise) / 100).toFixed(2) },
      ]);
  }
  put('ledger/party-statements.csv', toCsv(stRows));
  counts['party_statements'] = statements;

  // PDFs of the sales documents, up to the cap
  const docs = await inOrg(
    db,
    ctx.orgId,
    (tx) =>
      tx`SELECT id, number, type FROM documents WHERE business_id = ${ctx.businessId} AND deleted_at IS NULL
         AND status IN ('issued', 'cancelled') AND type IN ('tax_invoice', 'bill_of_supply', 'credit_note', 'debit_note')
         AND date >= ${from} AND date <= ${to} ORDER BY date, number LIMIT ${PDF_CAP + 1}`,
  );
  if (docs.length > PDF_CAP)
    warnings.push(`More than ${PDF_CAP} documents: only the first ${PDF_CAP} PDFs are in the pack`);
  let pdfs = 0;
  for (const d of (docs as Row[]).slice(0, PDF_CAP)) {
    const out = await renderDocumentPdf(db, ctx, String(d['id']));
    if (!out) continue;
    put(`pdf/${safe(`${String(d['type'])}_${String(d['number'] ?? d['id'])}`)}.pdf`, out.bytes);
    pdfs++;
  }
  counts['pdfs'] = pdfs;

  const manifest: PackManifest = {
    business: { name: businessName, gstin: info.gstin || null },
    from,
    to,
    generatedAt: now,
    files: [
      ...Object.entries(files).map(([name, b]) => ({ name, bytes: b.byteLength })),
      { name: 'manifest.json', bytes: 0 },
    ],
    counts,
    warnings,
  };
  put('manifest.json', JSON.stringify(manifest, null, 2));
  const zip = zipSync(files, { level: 6 });
  return { zip, manifest };
}

const view = (r: Row): PackView => ({
  id: String(r['id']),
  businessId: String(r['business_id']),
  from: String(r['from_date']),
  to: String(r['to_date']),
  status: String(r['status']) as PackView['status'],
  sizeBytes: r['size_bytes'] == null ? null : Number(r['size_bytes']),
  manifest: (r['manifest_json'] as PackManifest | null) ?? null,
  error: (r['error'] as string | null) ?? null,
  createdAt: Number(r['created_at']),
  finishedAt: r['finished_at'] == null ? null : Number(r['finished_at']),
});

export class ExportPackService {
  constructor(
    private readonly o: {
      db: PgDatabase;
      storage: Storage | null;
      log: Logger;
      /** Put the job on the queue; when there is none the request runs the job itself. */
      enqueue: ((job: { orgId: string; packId: string }) => Promise<void>) | null;
      now?: () => number;
      fetch?: typeof fetch;
    },
  ) {}

  private now() {
    return (this.o.now ?? Date.now)();
  }

  async request(a: {
    orgId: string;
    businessId: string;
    from: string;
    to: string;
    shareId: string | null;
    by: string;
  }): Promise<PackView> {
    if (!this.o.storage)
      throw new PackError('File storage is not configured on this server.', 'no_storage');
    if (a.from > a.to) throw new PackError('The dates are the wrong way round.', 'validation');
    const now = this.now();
    const id = newId();
    const [row] = await inOrg(
      this.o.db,
      a.orgId,
      (tx) =>
        tx`INSERT INTO export_packs (id, org_id, business_id, share_id, from_date, to_date, status, created_by, created_at, updated_at)
        VALUES (${id}, ${a.orgId}, ${a.businessId}, ${a.shareId}, ${a.from}, ${a.to}, 'queued', ${a.by}, ${now}, ${now}) RETURNING *`,
    );
    if (this.o.enqueue) await this.o.enqueue({ orgId: a.orgId, packId: id });
    else await this.run(a.orgId, id);
    return (await this.pack(a.orgId, id)) ?? view(row!);
  }

  async run(orgId: string, packId: string): Promise<PackView['status']> {
    const [r] = await inOrg(
      this.o.db,
      orgId,
      (tx) =>
        tx`UPDATE export_packs SET status = 'running', updated_at = ${this.now()} WHERE id = ${packId} AND status IN ('queued', 'running') RETURNING *`,
    );
    if (!r) return 'failed';
    const ctx: Ctx = {
      orgId,
      businessId: String(r['business_id']),
      actor: String(r['created_by'] ?? 'system'),
      deviceId: 'api',
    };
    try {
      const storage = this.o.storage;
      if (!storage)
        throw new PackError('File storage is not configured on this server.', 'no_storage');
      const { zip, manifest } = await buildExportPack(
        this.o.db,
        ctx,
        String(r['from_date']),
        String(r['to_date']),
        this.now(),
      );
      const key = storage.key(orgId, 'tmp', `export-pack-${packId}.zip`);
      const signed = await storage.signUpload(key, 'application/zip', zip.byteLength);
      const res = await (this.o.fetch ?? fetch)(signed.url, {
        method: 'PUT',
        headers: signed.headers,
        body: Buffer.from(zip),
      });
      if (!res.ok) throw new Error(`the store answered ${res.status}`);
      const now = this.now();
      await inOrg(
        this.o.db,
        orgId,
        (tx) =>
          tx`UPDATE export_packs SET status = 'done', storage_key = ${key}, size_bytes = ${zip.byteLength},
             manifest_json = ${JSON.stringify(manifest)}::jsonb, finished_at = ${now}, updated_at = ${now} WHERE id = ${packId}`,
      );
      return 'done';
    } catch (e) {
      const now = this.now();
      this.o.log.warn({ orgId, packId, err: (e as Error).message }, 'export pack failed');
      await inOrg(
        this.o.db,
        orgId,
        (tx) =>
          tx`UPDATE export_packs SET status = 'failed', error = ${(e as Error).message.slice(0, 500)}, finished_at = ${now}, updated_at = ${now} WHERE id = ${packId}`,
      );
      return 'failed';
    }
  }

  async pack(orgId: string, id: string): Promise<PackView | null> {
    const [r] = await inOrg(
      this.o.db,
      orgId,
      (tx) => tx`SELECT * FROM export_packs WHERE org_id = ${orgId} AND id = ${id}`,
    );
    return r ? view(r) : null;
  }

  async list(orgId: string, businessId: string): Promise<PackView[]> {
    const rows = await inOrg(
      this.o.db,
      orgId,
      (tx) =>
        tx`SELECT * FROM export_packs WHERE org_id = ${orgId} AND business_id = ${businessId} ORDER BY created_at DESC LIMIT 50`,
    );
    return rows.map(view);
  }

  /** A signed address for the ZIP; the store's lifecycle removes it after seven days. */
  async download(orgId: string, id: string): Promise<{ url: string; expiresAt: number }> {
    const p = await this.pack(orgId, id);
    if (!p) throw new PackError('That export pack was not found.', 'not_found');
    if (p.status !== 'done') throw new PackError('That export pack is not ready yet.', 'not_ready');
    if (!this.o.storage)
      throw new PackError('File storage is not configured on this server.', 'no_storage');
    const [r] = await inOrg(
      this.o.db,
      orgId,
      (tx) => tx`SELECT storage_key FROM export_packs WHERE id = ${id}`,
    );
    const key = String(r?.['storage_key'] ?? '');
    if (!key || !(await this.o.storage.exists(key)))
      throw new PackError('That export pack has expired; ask for a new one.', 'not_found');
    return this.o.storage.signDownload(key, `export-pack-${p.from}-${p.to}.zip`);
  }
}
