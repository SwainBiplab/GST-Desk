/**
 * e-Invoicing and e-way bills (prompt 32): documents turned into the portal's payloads, requests queued
 * with idempotency keys and sent when a GSP client is available (online and unlocked), results recorded
 * on the document, and every call kept in `gsp_log` with secrets removed.
 *
 * This package does not depend on `@gst/gsp`: the queue takes any client with the `GspPort` methods, so
 * the database layer never sees credentials.
 */
import {
  addDaysIso,
  buildEinvoice,
  buildEwb,
  checkEinvoice,
  checkEwb,
  divRound,
  explainGspError,
  ewbCancellable,
  ewbExtendable,
  irnCancellable,
  needsIrn,
  returnsUqc,
  type EinvDoc,
  type EinvLine,
  type EinvProblem,
  type EwbInput,
  type EwbTransport,
  type IrnResult,
} from '@gst/domain';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

import { queryRows, type Database } from '../database';
import { noteWrite } from '../events';
import type { Row } from '../schema';

import { BusinessRepo, ReviewRepo, SettingsRepo } from './aggregates';
import { BaseRepo, RuleError, newId, runInTx, writeAudit, type Ctx } from './base';
import { DocumentFlowRepo } from './document-flow';
import { GstrRepo } from './gstr';

const n = (v: unknown): number => Number(v ?? 0);
const s = (v: unknown): string => (v == null ? '' : String(v));
const flag = (v: unknown): boolean => v === true || Number(v) === 1;

/** What the queue needs from a GSP client (`GspClient` in @gst/gsp has these). */
export interface GspPort {
  generateIrn(
    payload: Record<string, unknown>,
    doc: { type: string; number: string; date: string },
  ): Promise<IrnResult & { recovered: boolean }>;
  cancelIrn(irn: string, reason: string, remarks: string): Promise<{ cancelledAt: string }>;
  generateEwb(
    payload: Record<string, unknown>,
  ): Promise<{ ewbNo: string; generatedAt: string; validUntil: string; distanceKm: number }>;
  updateVehicle(
    ewbNo: string,
    v: {
      vehicleNo: string;
      fromPlace: string;
      fromState: string;
      reason: string;
      remarks: string;
      mode: string;
    },
  ): Promise<{ validUntil: string }>;
  extendEwb(
    ewbNo: string,
    x: {
      remainingKm: number;
      fromPlace: string;
      fromState: string;
      fromPincode: string;
      reason: string;
      remarks: string;
      vehicleNo?: string;
    },
  ): Promise<{ validUntil: string }>;
  cancelEwb(ewbNo: string, reason: string, remarks: string): Promise<{ cancelledAt: string }>;
}

export type JobKind = 'irn' | 'irn_cancel' | 'ewb' | 'ewb_cancel' | 'ewb_extend' | 'ewb_vehicle';

export interface GspConfig {
  /** `practice` uses the built-in practice GSP; nothing is filed. */
  mode: 'practice' | 'vendor-x';
  baseUrl?: string;
  sandbox: boolean;
}

/** Retry after these minutes for a failure worth retrying, then give up. */
const BACKOFF_MIN = [1, 5, 15, 60, 180, 360];
/** A job left "running" longer than this was interrupted. */
const STALE_MS = 5 * 60_000;
const KIND_LABEL: Record<string, string> = {
  tax_invoice: 'INV',
  credit_note: 'CRN',
  debit_note: 'DBN',
};

class Jobs extends BaseRepo {
  constructor(d: Database) {
    super(d, 'gsp_jobs');
  }
}
class Einvoices extends BaseRepo {
  constructor(d: Database) {
    super(d, 'einvoices');
  }
}
class Ewaybills extends BaseRepo {
  constructor(d: Database) {
    super(d, 'ewaybills');
  }
}

function parseJson(v: unknown): Record<string, any> {
  if (v && typeof v === 'object') return v as Record<string, any>;
  if (typeof v === 'string' && v) {
    try {
      const p = JSON.parse(v) as unknown;
      return p && typeof p === 'object' ? (p as Record<string, any>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

const hash = (text: string): string => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

export class EinvoiceRepo {
  private readonly jobs: Jobs;
  private readonly einvoices: Einvoices;
  private readonly ewaybills: Ewaybills;
  private readonly settings: SettingsRepo;

  constructor(private readonly d: Database) {
    this.jobs = new Jobs(d);
    this.einvoices = new Einvoices(d);
    this.ewaybills = new Ewaybills(d);
    this.settings = new SettingsRepo(d);
  }

  /* ------------------------------------------------------------ settings */

  async einvoicingOn(ctx: Ctx): Promise<boolean> {
    return runInTx(
      this.d,
      ctx,
      async (tx) =>
        (await this.settings.getValue<boolean>({ ...ctx, tx }, 'gst.einvoicing')) === true,
    );
  }

  async setEinvoicing(ctx: Ctx, on: boolean): Promise<void> {
    await runInTx(this.d, ctx, async (tx) =>
      this.settings.set({ ...ctx, tx }, 'gst.einvoicing', on),
    );
  }

  async gspConfig(ctx: Ctx): Promise<GspConfig> {
    return runInTx(this.d, ctx, async (tx) => {
      const v = await this.settings.getValue<GspConfig>({ ...ctx, tx }, 'gsp.config');
      return v && (v.mode === 'practice' || v.mode === 'vendor-x')
        ? v
        : { mode: 'practice', sandbox: true };
    });
  }

  async setGspConfig(ctx: Ctx, cfg: GspConfig): Promise<void> {
    await runInTx(this.d, ctx, async (tx) => {
      if (cfg.mode === 'vendor-x' && !/^https:\/\/[^\s/]+/.test(cfg.baseUrl ?? ''))
        throw new RuleError('Give the GSP address, starting with https://.');
      await this.settings.set({ ...ctx, tx }, 'gsp.config', cfg);
    });
  }

  /** The credentials, sealed with the person's PIN. Kept as a secret setting: never in a backup or the audit trail. */
  async sealedCredentials(ctx: Ctx): Promise<unknown> {
    return runInTx(
      this.d,
      ctx,
      async (tx) =>
        (await this.settings.getValue<unknown>({ ...ctx, tx }, 'secret.gsp.credentials')) ?? null,
    );
  }

  async saveSealedCredentials(ctx: Ctx, sealed: unknown): Promise<void> {
    await runInTx(this.d, ctx, async (tx) =>
      this.settings.set({ ...ctx, tx }, 'secret.gsp.credentials', sealed),
    );
  }

  /* ------------------------------------------------------------ payloads */

  private async loadDoc(c: Ctx, id: string) {
    const tx = c.tx;
    const docs = await tx
      .select()
      .from(this.d.schema.documents)
      .where(
        and(
          eq(this.d.schema.documents.id, id),
          eq(this.d.schema.documents.business_id, c.businessId),
        ),
      );
    const doc = docs[0] as Row | undefined;
    if (!doc || doc['deleted_at']) throw new RuleError('The document was not found.');
    const lines = (await tx
      .select()
      .from(this.d.schema.document_lines)
      .where(
        and(
          eq(this.d.schema.document_lines.document_id, id),
          isNull(this.d.schema.document_lines.deleted_at),
        ),
      )
      .orderBy(asc(this.d.schema.document_lines.line_no))) as Row[];
    const unitIds = [...new Set(lines.map((l) => l['unit_id']).filter(Boolean))] as string[];
    const units = unitIds.length
      ? ((await tx
          .select()
          .from(this.d.schema.units)
          .where(inArray(this.d.schema.units.id, unitIds))) as Row[])
      : [];
    const unitById = new Map(units.map((u) => [s(u['id']), u]));
    const party = doc['party_id']
      ? ((
          await tx
            .select()
            .from(this.d.schema.parties)
            .where(eq(this.d.schema.parties.id, doc['party_id']))
        )[0] as Row | undefined)
      : undefined;
    const business = await new BusinessRepo(this.d).get(c, c.businessId);
    const source = doc['source_document_id']
      ? ((
          await tx
            .select()
            .from(this.d.schema.documents)
            .where(eq(this.d.schema.documents.id, doc['source_document_id']))
        )[0] as Row | undefined)
      : undefined;
    return { doc, lines, unitById, party, business, source };
  }

  /** The document as the e-invoice builder takes it. */
  async einvDoc(ctx: Ctx, id: string): Promise<EinvDoc> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const { doc, lines, unitById, party, business, source } = await this.loadDoc(c, id);
      const kind = KIND_LABEL[s(doc['type'])];
      if (!kind) throw new RuleError('Only tax invoices, credit notes and debit notes get an IRN.');
      if (doc['status'] !== 'issued')
        throw new RuleError('Issue the document before generating its IRN.');
      const meta = parseJson(doc['metadata_json']);
      const supplyType = s(doc['supply_type']);
      const lut = meta['lut'] === true;
      const supply =
        supplyType === 'export'
          ? lut
            ? 'EXPWOP'
            : 'EXPWP'
          : supplyType === 'sez'
            ? lut
              ? 'SEZWOP'
              : 'SEZWP'
            : 'B2B';
      const exporting = supply === 'EXPWP' || supply === 'EXPWOP';
      const addr = parseJson(business?.['address']);
      const contact = parseJson(parseJson(business?.['settings_json'])['contact']);
      const pAddrs = (
        Array.isArray(party?.['addresses_json'])
          ? party!['addresses_json']
          : parseJson(party?.['addresses_json'])
      ) as Record<string, any>[] | Record<string, any>;
      const list = Array.isArray(pAddrs) ? pAddrs : [];
      const billing = list.find((a) => a['kind'] === 'billing') ?? list[0] ?? {};
      const shipping = list.find((a) => a['kind'] === 'shipping');
      const partyState = s(party?.['state_code']);

      const einvLines: EinvLine[] = lines.map((l) => {
        const qty = n(l['qty_micros']);
        const taxable = n(l['taxable_paise']);
        const inclusive = flag(l['price_includes_tax']);
        const rate = n(l['rate_paise']);
        const grossBig = inclusive
          ? BigInt(taxable)
          : divRound(BigInt(qty) * BigInt(rate), 1_000_000n);
        const gross = grossBig < BigInt(taxable) ? taxable : Number(grossBig);
        const unitPrice =
          inclusive && qty > 0 ? Number(divRound(BigInt(taxable) * 1_000_000n, BigInt(qty))) : rate;
        const igst = n(l['igst_paise']);
        const cgst = n(l['cgst_paise']);
        const sgst = n(l['sgst_paise']) + n(l['utgst_paise']);
        const cess = n(l['cess_paise']);
        const unit = l['unit_id'] ? unitById.get(s(l['unit_id'])) : undefined;
        return {
          description: s(l['description']).trim(),
          hsn: s(l['hsn']),
          qtyMicros: qty,
          uqc: unit
            ? returnsUqc({
                code: s(unit['code']),
                uqc: unit['uqc'] == null ? null : s(unit['uqc']),
                is_custom: flag(unit['is_custom']),
              })
            : 'OTH',
          unitPricePaise: unitPrice,
          grossPaise: gross,
          discountPaise: gross - taxable,
          taxablePaise: taxable,
          gstRateBp: n(l['cgst_bp']) + n(l['sgst_bp']) + n(l['utgst_bp']) + n(l['igst_bp']),
          igstPaise: igst,
          cgstPaise: cgst,
          sgstPaise: sgst,
          cessRateBp: n(l['cess_bp']),
          cessPaise: cess,
          otherChargesPaise: 0,
          totalPaise: taxable + igst + cgst + sgst + cess,
        };
      });

      return {
        kind: kind as EinvDoc['kind'],
        number: s(doc['number']),
        date: s(doc['date']),
        supply,
        reverseCharge: flag(doc['reverse_charge']),
        seller: {
          gstin: s(business?.['gstin']),
          legalName: s(business?.['legal_name']),
          tradeName: s(business?.['trade_name']) || undefined,
          addr1: s(addr['line1']),
          location: s(addr['city']),
          pincode: s(addr['pincode']),
          stateCode: s(business?.['state_code']),
          phone: s(contact['phone']) || undefined,
          email: s(contact['email']) || undefined,
        },
        buyer: {
          gstin: exporting ? 'URP' : s(party?.['gstin']),
          legalName: s(party?.['name'] ?? doc['party_name']),
          addr1: s(billing['line1']),
          location: s(billing['city']) || s(party?.['city']),
          pincode: exporting ? '999999' : s(billing['pincode']),
          stateCode: exporting ? '96' : partyState,
          pos: exporting ? '96' : s(doc['place_of_supply_state']) || partyState,
          phone: s(party?.['phone']) || undefined,
          email: s(party?.['email']) || undefined,
        },
        shipTo:
          shipping && !exporting
            ? {
                gstin: s(party?.['gstin']),
                legalName: s(party?.['name']),
                addr1: s(shipping['line1']),
                location: s(shipping['city']),
                pincode: s(shipping['pincode']),
                stateCode: s(doc['place_of_supply_state']) || partyState,
              }
            : null,
        lines: einvLines,
        totals: {
          assessablePaise: n(doc['total_taxable_paise']),
          cgstPaise: n(doc['total_cgst_paise']),
          sgstPaise: n(doc['total_sgst_paise']) + n(doc['total_utgst_paise']),
          igstPaise: n(doc['total_igst_paise']),
          cessPaise: n(doc['total_cess_paise']),
          discountPaise: 0,
          otherChargesPaise: n(doc['tcs_paise']),
          roundOffPaise: n(doc['round_off_paise']),
          totalPaise: n(doc['total_paise']),
        },
        preceding: source ? { number: s(source['number']), date: s(source['date']) } : null,
        exportDetails: null,
      };
    });
  }

  /** The payload and everything the portal would refuse in it, before anything is sent. */
  async previewIrn(
    ctx: Ctx,
    id: string,
    today: string,
  ): Promise<{ payload: Record<string, unknown>; problems: EinvProblem[] }> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const d = await this.einvDoc(c, id);
      const gstr = new GstrRepo(this.d);
      const period = {
        gstin: d.seller.gstin,
        fp: '',
        from: d.date,
        to: d.date,
        kind: 'month' as const,
      };
      const turnover = await gstr.priorYearTurnover(c, period);
      return {
        payload: buildEinvoice(d),
        problems: checkEinvoice(d, { today, turnoverPaise: turnover }),
      };
    });
  }

  /** An e-way bill input for a document, with the transport the person gave. */
  async ewbInput(ctx: Ctx, id: string, transport: EwbTransport): Promise<EwbInput> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const { doc, lines, unitById, party, business } = await this.loadDoc(c, id);
      const type = s(doc['type']);
      if (
        ![
          'tax_invoice',
          'bill_of_supply',
          'delivery_challan',
          'credit_note',
          'debit_note',
        ].includes(type)
      )
        throw new RuleError(
          'An e-way bill is made for an invoice, a bill of supply, a delivery challan or a note.',
        );
      if (doc['status'] !== 'issued')
        throw new RuleError('Issue the document before its e-way bill.');
      const exporting = s(doc['supply_type']) === 'export';
      const addr = parseJson(business?.['address']);
      const list = Array.isArray(party?.['addresses_json'])
        ? (party!['addresses_json'] as Record<string, any>[])
        : [];
      const to =
        list.find((a) => a['kind'] === 'shipping') ??
        list.find((a) => a['kind'] === 'billing') ??
        list[0] ??
        {};
      return {
        docType: type,
        number: s(doc['number']),
        date: s(doc['date']),
        supplyType: 'O',
        subSupplyType: exporting ? '3' : type === 'delivery_challan' ? '8' : '1',
        from: {
          gstin: s(business?.['gstin']),
          name: s(business?.['trade_name'] ?? business?.['legal_name']),
          addr1: s(addr['line1']),
          place: s(addr['city']),
          pincode: s(addr['pincode']),
          stateCode: s(business?.['state_code']),
        },
        to: {
          gstin: party?.['gstin'] && !exporting ? s(party['gstin']) : 'URP',
          name: s(party?.['name'] ?? doc['party_name']),
          addr1: s(to['line1']),
          place: s(to['city']) || s(party?.['city']),
          pincode: s(to['pincode']),
          stateCode: exporting ? '96' : s(doc['place_of_supply_state']) || s(party?.['state_code']),
        },
        transactionType: 1,
        values: {
          taxablePaise: n(doc['total_taxable_paise']),
          cgstPaise: n(doc['total_cgst_paise']),
          sgstPaise: n(doc['total_sgst_paise']) + n(doc['total_utgst_paise']),
          igstPaise: n(doc['total_igst_paise']),
          cessPaise: n(doc['total_cess_paise']),
          otherPaise: n(doc['tcs_paise']) + n(doc['round_off_paise']),
          totalPaise: n(doc['total_paise']),
        },
        lines: lines.map((l) => {
          const unit = l['unit_id'] ? unitById.get(s(l['unit_id'])) : undefined;
          return {
            name: s(l['description']).trim() || s(l['hsn']),
            hsn: s(l['hsn']),
            qtyMicros: n(l['qty_micros']),
            uqc: unit
              ? returnsUqc({
                  code: s(unit['code']),
                  uqc: unit['uqc'] == null ? null : s(unit['uqc']),
                  is_custom: flag(unit['is_custom']),
                })
              : 'OTH',
            taxablePaise: n(l['taxable_paise']),
            cgstRateBp: n(l['cgst_bp']),
            sgstRateBp: n(l['sgst_bp']) + n(l['utgst_bp']),
            igstRateBp: n(l['igst_bp']),
            cessRateBp: n(l['cess_bp']),
          };
        }),
        transport,
      };
    });
  }

  /* ------------------------------------------------------------ state */

  async einvoiceOf(ctx: Ctx, documentId: string): Promise<Row | null> {
    return runInTx(
      this.d,
      ctx,
      async (tx) =>
        (await this.einvoices.list({ ...ctx, tx })).find((r) => r['document_id'] === documentId) ??
        null,
    );
  }

  async ewaybillsOf(ctx: Ctx, documentId: string | null): Promise<Row[]> {
    return runInTx(this.d, ctx, async (tx) =>
      (await this.ewaybills.list({ ...ctx, tx }))
        .filter((r) => documentId === null || r['document_id'] === documentId)
        .sort((a, b) => s(b['generated_at']).localeCompare(s(a['generated_at']))),
    );
  }

  async jobsOf(ctx: Ctx, documentId: string | null): Promise<Row[]> {
    return runInTx(this.d, ctx, async (tx) =>
      (await this.jobs.list({ ...ctx, tx }))
        .filter((r) => documentId === null || r['document_id'] === documentId)
        .sort((a, b) => n(b['created_at']) - n(a['created_at'])),
    );
  }

  async logOf(ctx: Ctx, documentId: string): Promise<Row[]> {
    return runInTx(this.d, ctx, async (tx) =>
      queryRows(
        this.d,
        tx,
        sql`SELECT * FROM gsp_log WHERE business_id = ${ctx.businessId} AND document_id = ${documentId} ORDER BY created_at DESC`,
      ),
    );
  }

  /** Issued documents that need an IRN and have none (and no request on its way), for bulk generation. */
  async waitingForIrn(ctx: Ctx, from: string, to: string): Promise<Row[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const on = await this.einvoicingOn(c);
      if (!on) return [];
      const rows = await queryRows(
        this.d,
        tx,
        sql`SELECT d.id, d.type, d.number, d.date, d.party_name, d.total_paise, d.supply_type, d.status,
                   coalesce(pa.gstin, '') AS gstin, pa.is_unregistered AS unreg
            FROM documents d LEFT JOIN parties pa ON pa.id = d.party_id
            WHERE d.business_id = ${ctx.businessId} AND d.deleted_at IS NULL AND d.status = 'issued'
              AND d.type IN ('tax_invoice', 'credit_note', 'debit_note') AND d.irn IS NULL
              AND d.date >= ${from} AND d.date <= ${to}
            ORDER BY d.date, d.number`,
      );
      const live = new Set(
        (await this.jobs.list(c))
          .filter(
            (j) => j['kind'] === 'irn' && (j['status'] === 'queued' || j['status'] === 'running'),
          )
          .map((j) => s(j['document_id'])),
      );
      return rows.filter(
        (r) =>
          !live.has(s(r['id'])) &&
          needsIrn({
            einvoicingOn: true,
            type: s(r['type']),
            status: 'issued',
            registered: s(r['gstin']) !== '' && !flag(r['unreg']),
            supplyType: s(r['supply_type']),
          }),
      );
    });
  }

  /* ------------------------------------------------------------ requests */

  private async queue(
    c: Ctx,
    kind: JobKind,
    documentId: string | null,
    ewaybillId: string | null,
    payload: unknown,
    args: unknown,
    revision: number | null,
  ): Promise<Row> {
    const key = `${kind}:${documentId ?? ewaybillId}:${revision ?? 0}:${hash(JSON.stringify(args ?? null))}`;
    const existing = (await this.jobs.list(c)).find(
      (j) => j['idempotency_key'] === key && j['status'] !== 'failed' && j['status'] !== 'stopped',
    );
    if (existing) return existing;
    // a failed or stopped job with the same key is history: its key is freed by moving it to the trash
    for (const old of (await this.jobs.list(c)).filter((j) => j['idempotency_key'] === key))
      await this.jobs.softDelete(c, s(old['id']), n(old['version']));
    return this.jobs.create(c, {
      kind,
      document_id: documentId,
      ewaybill_id: ewaybillId,
      idempotency_key: key,
      payload_json: payload,
      args_json: args ?? null,
      doc_revision: revision,
      status: 'queued',
      attempts: 0,
    });
  }

  /**
   * Ask for an IRN. Returns the problems instead of queuing when the portal would refuse it, so the
   * person can fix the document first.
   */
  async requestIrn(
    ctx: Ctx,
    id: string,
    today: string,
  ): Promise<{ job: Row | null; problems: EinvProblem[] }> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      if (await this.einvoiceOf(c, id).then((e) => e && e['status'] === 'active'))
        throw new RuleError('This document already has an IRN.');
      const { payload, problems } = await this.previewIrn(c, id, today);
      if (problems.length > 0) return { job: null, problems };
      const { doc } = await this.loadDoc(c, id);
      const job = await this.queue(
        c,
        'irn',
        id,
        null,
        payload,
        { type: KIND_LABEL[s(doc['type'])], number: s(doc['number']), date: s(doc['date']) },
        n(doc['revision']),
      );
      return { job, problems: [] };
    });
  }

  /** Cancel an IRN: within 24 hours of it, with one of the portal's reasons. After that, a credit note. */
  async requestIrnCancel(
    ctx: Ctx,
    id: string,
    reason: '1' | '2' | '3' | '4',
    remarks: string,
    now: Date,
  ): Promise<Row> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const e = await this.einvoiceOf(c, id);
      if (!e || e['status'] !== 'active')
        throw new RuleError('This document has no IRN to cancel.');
      if (!irnCancellable(s(e['ack_date']), now))
        throw new RuleError(
          'An IRN can be cancelled only within 24 hours of being generated. Issue a credit note for this invoice instead.',
        );
      if (!remarks.trim()) throw new RuleError('Say why the IRN is being cancelled.');
      const active = (await this.ewaybillsOf(c, id)).some((w) => w['status'] === 'active');
      if (active)
        throw new RuleError('Cancel the e-way bill made for this document first, then its IRN.');
      return this.queue(
        c,
        'irn_cancel',
        id,
        null,
        null,
        { irn: s(e['irn']), reason, remarks: remarks.trim() },
        null,
      );
    });
  }

  /** Ask for an e-way bill for a document; returns the problems instead when the portal would refuse it. */
  async requestEwb(
    ctx: Ctx,
    id: string,
    transport: EwbTransport,
  ): Promise<{ job: Row | null; problems: EinvProblem[] }> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      if ((await this.ewaybillsOf(c, id)).some((w) => w['status'] === 'active'))
        throw new RuleError(
          'This document already has an active e-way bill. Update its vehicle or extend it instead.',
        );
      const input = await this.ewbInput(c, id, transport);
      const problems = checkEwb(input);
      if (problems.length > 0) return { job: null, problems };
      const e = await this.einvoiceOf(c, id);
      const payload = {
        ...buildEwb(input),
        ...(e && e['status'] === 'active' ? { Irn: s(e['irn']) } : {}),
      };
      const { doc } = await this.loadDoc(c, id);
      const job = await this.queue(c, 'ewb', id, null, payload, transport, n(doc['revision']));
      return { job, problems: [] };
    });
  }

  private async ewbRow(c: Ctx, ewaybillId: string): Promise<Row> {
    const row = (await this.ewaybills.list(c)).find((r) => r['id'] === ewaybillId);
    if (!row || row['status'] !== 'active') throw new RuleError('This e-way bill is not active.');
    return row;
  }

  async requestEwbCancel(
    ctx: Ctx,
    ewaybillId: string,
    reason: '1' | '2' | '3' | '4',
    remarks: string,
    now: Date,
  ): Promise<Row> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const w = await this.ewbRow(c, ewaybillId);
      if (!ewbCancellable(s(w['generated_at']), now))
        throw new RuleError(
          'An e-way bill can be cancelled only within 24 hours of being generated.',
        );
      if (!remarks.trim()) throw new RuleError('Say why the e-way bill is being cancelled.');
      return this.queue(
        c,
        'ewb_cancel',
        w['document_id'] ? s(w['document_id']) : null,
        ewaybillId,
        null,
        { ewbNo: s(w['ewb_no']), reason, remarks: remarks.trim() },
        null,
      );
    });
  }

  async requestEwbExtend(
    ctx: Ctx,
    ewaybillId: string,
    x: {
      remainingKm: number;
      fromPlace: string;
      fromState: string;
      fromPincode: string;
      reason: string;
      remarks: string;
      vehicleNo?: string;
    },
    now: Date,
  ): Promise<Row> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const w = await this.ewbRow(c, ewaybillId);
      if (!ewbExtendable(s(w['valid_until']), now))
        throw new RuleError(
          'An e-way bill can be extended only from 8 hours before to 8 hours after it expires.',
        );
      if (!Number.isInteger(x.remainingKm) || x.remainingKm <= 0)
        throw new RuleError('Give the distance still to travel, in whole kilometres.');
      if (!/^\d{6}$/.test(x.fromPincode))
        throw new RuleError('Give the pincode where the goods are now.');
      if (!x.remarks.trim()) throw new RuleError('Say why the e-way bill is being extended.');
      return this.queue(
        c,
        'ewb_extend',
        w['document_id'] ? s(w['document_id']) : null,
        ewaybillId,
        null,
        { ewbNo: s(w['ewb_no']), ...x },
        null,
      );
    });
  }

  async requestVehicleUpdate(
    ctx: Ctx,
    ewaybillId: string,
    v: {
      vehicleNo: string;
      fromPlace: string;
      fromState: string;
      reason: string;
      remarks: string;
      mode: string;
    },
  ): Promise<Row> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const w = await this.ewbRow(c, ewaybillId);
      if (!v.vehicleNo.trim()) throw new RuleError('Give the new vehicle number.');
      return this.queue(
        c,
        'ewb_vehicle',
        w['document_id'] ? s(w['document_id']) : null,
        ewaybillId,
        null,
        { ewbNo: s(w['ewb_no']), ...v },
        null,
      );
    });
  }

  /* ------------------------------------------------------------ the queue */

  /** Write one GSP call to the log (already redacted by the client). */
  async writeLog(
    ctx: Ctx,
    e: {
      portal: string;
      action: string;
      request: unknown;
      response: unknown;
      ok: boolean;
      code: string | null;
      message: string | null;
      ms: number;
    },
    link: { jobId?: string | null; documentId?: string | null },
  ): Promise<void> {
    await runInTx(this.d, ctx, async (tx) => {
      const now = Date.now();
      await tx.insert(this.d.schema.gsp_log).values({
        id: newId(),
        org_id: ctx.orgId,
        business_id: ctx.businessId,
        version: 1,
        created_at: now,
        updated_at: now,
        created_by: ctx.actor,
        updated_by: ctx.actor,
        job_id: link.jobId ?? null,
        document_id: link.documentId ?? null,
        portal: e.portal,
        action: e.action,
        request_json: e.request ?? null,
        response_json: e.response ?? null,
        ok: e.ok,
        code: e.code,
        message: e.message,
        ms: Math.round(e.ms),
      });
      noteWrite(tx, 'gsp_log');
    });
  }

  /**
   * Send what is waiting. `link` is updated before each job so the client's log lines can name it.
   * Returns what happened, for the screen.
   */
  async process(
    ctx: Ctx,
    client: GspPort,
    opts: { now?: () => Date; link?: { jobId?: string | null; documentId?: string | null } } = {},
  ): Promise<{ done: number; failed: number; stopped: number; waiting: number }> {
    const now = opts.now ?? (() => new Date());
    const link = opts.link ?? {};
    const out = { done: 0, failed: 0, stopped: 0, waiting: 0 };
    const all = await runInTx(this.d, ctx, async (tx) => this.jobs.list({ ...ctx, tx }));
    const due = all
      .filter((j) => {
        if (j['status'] === 'running') return now().getTime() - n(j['updated_at']) > STALE_MS;
        return j['status'] === 'queued' && (!j['next_at'] || n(j['next_at']) <= now().getTime());
      })
      .sort((a, b) => n(a['created_at']) - n(b['created_at']));

    for (const job of due) {
      const id = s(job['id']);
      link.jobId = id;
      link.documentId = job['document_id'] ? s(job['document_id']) : null;
      const kind = s(job['kind']) as JobKind;

      // interrupted mid-call: an IRN is safe to send again (a duplicate is recovered); an e-way bill is not
      if (job['status'] === 'running' && kind !== 'irn') {
        await this.finish(
          ctx,
          id,
          'failed',
          'GD-UNCERTAIN',
          'The request was interrupted and may have reached the portal. Check the portal before sending it again.',
          null,
        );
        out.failed += 1;
        continue;
      }

      // a document changed after it was queued: stop, and say so in the inbox
      if ((kind === 'irn' || kind === 'ewb') && job['document_id']) {
        const doc = await runInTx(
          this.d,
          ctx,
          async (tx) =>
            (
              await tx
                .select()
                .from(this.d.schema.documents)
                .where(eq(this.d.schema.documents.id, job['document_id']))
            )[0] as Row | undefined,
        );
        if (!doc || doc['status'] !== 'issued' || n(doc['revision']) !== n(job['doc_revision'])) {
          await this.finish(
            ctx,
            id,
            'stopped',
            'GD-CHANGED',
            explainGspError('GD-CHANGED').plain,
            null,
          );
          await this.raiseStopped(ctx, job, doc);
          out.stopped += 1;
          continue;
        }
      }

      const attempts = n(job['attempts']) + 1;
      await runInTx(this.d, ctx, async (tx) =>
        this.jobs.update({ ...ctx, tx }, id, { status: 'running', attempts }, n(job['version'])),
      );
      const payload = parseJson(job['payload_json']);
      const args = parseJson(job['args_json']);
      try {
        let result: unknown;
        if (kind === 'irn')
          result = await client.generateIrn(
            payload,
            args as { type: string; number: string; date: string },
          );
        else if (kind === 'irn_cancel')
          result = await client.cancelIrn(args['irn'], args['reason'], args['remarks']);
        else if (kind === 'ewb') result = await client.generateEwb(payload);
        else if (kind === 'ewb_cancel')
          result = await client.cancelEwb(args['ewbNo'], args['reason'], args['remarks']);
        else if (kind === 'ewb_extend') result = await client.extendEwb(args['ewbNo'], args as any);
        else result = await client.updateVehicle(args['ewbNo'], args as any);
        await this.apply(ctx, job, result);
        await this.finish(ctx, id, 'done', null, null, result);
        out.done += 1;
      } catch (e) {
        const code = (e as { code?: string }).code ?? 'GD-UNKNOWN';
        const message = e instanceof Error ? e.message : String(e);
        const info = explainGspError(code, message);
        if (info.retry && attempts < BACKOFF_MIN.length) {
          await this.finish(
            ctx,
            id,
            'queued',
            code,
            message,
            null,
            now().getTime() + BACKOFF_MIN[attempts - 1]! * 60_000,
          );
          out.waiting += 1;
        } else {
          await this.finish(ctx, id, 'failed', code, message, null);
          out.failed += 1;
        }
      }
    }
    link.jobId = null;
    link.documentId = null;
    return out;
  }

  private async finish(
    ctx: Ctx,
    id: string,
    status: string,
    code: string | null,
    message: string | null,
    result: unknown,
    nextAt?: number,
  ) {
    await runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const cur = await this.jobs.get(c, id);
      if (!cur) return;
      await this.jobs.update(
        c,
        id,
        {
          status,
          last_code: code,
          last_message: message,
          result_json: result ?? cur['result_json'] ?? null,
          next_at: nextAt ?? null,
        },
        n(cur['version']),
      );
    });
  }

  private async raiseStopped(ctx: Ctx, job: Row, doc: Row | undefined) {
    await runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const key = `gsp_job_stopped:${s(job['id'])}`;
      const seen = await queryRows(
        this.d,
        tx,
        sql`SELECT id FROM review_items WHERE business_id = ${ctx.businessId} AND dedupe_key = ${key}`,
      );
      if (seen.length > 0) return;
      const suggestion = {
        documentId: s(job['document_id']),
        number: s(doc?.['number']),
        job: s(job['kind']),
        message: explainGspError('GD-CHANGED').plain,
      };
      await new ReviewRepo(this.d).create(c, {
        kind: 'gsp_job_stopped',
        status: 'pending',
        payload_json: { jobId: s(job['id']) },
        suggestion_json: suggestion,
        diff_json: null,
        source: 'system',
        model: null,
        confidence: null,
        dedupe_key: key,
      });
    });
  }

  /** Record what the portal returned, on the document and in the e-invoice and e-way bill tables. */
  private async apply(ctx: Ctx, job: Row, result: unknown): Promise<void> {
    const kind = s(job['kind']) as JobKind;
    const r = result as Record<string, any>;
    const args = parseJson(job['args_json']);
    const docId = job['document_id'] ? s(job['document_id']) : null;
    await runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const docs = this.d.schema.documents;
      const setDoc = async (patch: Record<string, unknown>) => {
        if (!docId) return;
        const before = (await tx.select().from(docs).where(eq(docs.id, docId)))[0] as Row;
        await tx
          .update(docs)
          .set({ ...patch, updated_at: Date.now(), updated_by: ctx.actor })
          .where(eq(docs.id, docId));
        await writeAudit(this.d, tx, c, 'documents', docId, 'update', before, {
          ...before,
          ...patch,
        });
      };
      if (kind === 'irn' && docId) {
        const existing = await this.einvoiceOf(c, docId);
        const values = {
          document_id: docId,
          irn: s(r['irn']),
          ack_no: s(r['ackNo']),
          ack_date: s(r['ackDate']),
          signed_invoice: s(r['signedInvoice']),
          signed_qr: s(r['signedQr']),
          status: 'active',
          recovered: r['recovered'] === true,
        };
        if (existing)
          await this.einvoices.update(c, s(existing['id']), values, n(existing['version']));
        else await this.einvoices.create(c, values);
        await setDoc({
          irn: values.irn,
          irn_ack_no: values.ack_no,
          irn_ack_date: values.ack_date,
          irn_signed_qr: values.signed_qr,
        });
        if (r['ewbNo']) {
          await this.ewaybills.create(c, {
            document_id: docId,
            ewb_no: s(r['ewbNo']),
            generated_at: values.ack_date,
            valid_until: s(r['ewbValidUntil']),
            status: 'active',
          });
          await setDoc({ eway_bill_no: s(r['ewbNo']) });
        }
      } else if (kind === 'irn_cancel' && docId) {
        const e = await this.einvoiceOf(c, docId);
        if (e)
          await this.einvoices.update(
            c,
            s(e['id']),
            {
              status: 'cancelled',
              cancel_reason: s(args['reason']),
              cancel_remarks: s(args['remarks']),
              cancelled_at: s(r['cancelledAt']),
            },
            n(e['version']),
          );
      } else if (kind === 'ewb' && docId) {
        const t = args as Record<string, any>;
        await this.ewaybills.create(c, {
          document_id: docId,
          ewb_no: s(r['ewbNo']),
          generated_at: s(r['generatedAt']),
          valid_until: s(r['validUntil']),
          status: 'active',
          distance_km: n(r['distanceKm']),
          trans_mode: s(t['mode']),
          vehicle_no: t['vehicleNo']
            ? s(t['vehicleNo'])
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, '')
            : null,
          transporter_id: t['transporterId'] ? s(t['transporterId']) : null,
          history_json: [],
        });
        await setDoc({
          eway_bill_no: s(r['ewbNo']),
          eway_valid_until: Date.parse(s(r['validUntil'])) || null,
        });
      } else if (job['ewaybill_id']) {
        const w = (await this.ewaybills.list(c)).find((x) => x['id'] === job['ewaybill_id']);
        if (!w) return;
        const history = Array.isArray(w['history_json']) ? (w['history_json'] as unknown[]) : [];
        if (kind === 'ewb_cancel') {
          await this.ewaybills.update(
            c,
            s(w['id']),
            {
              status: 'cancelled',
              cancel_reason: s(args['reason']),
              cancelled_at: s(r['cancelledAt']),
            },
            n(w['version']),
          );
          if (w['document_id']) await setDoc({ eway_valid_until: null });
        } else if (kind === 'ewb_extend') {
          await this.ewaybills.update(
            c,
            s(w['id']),
            {
              valid_until: s(r['validUntil']),
              history_json: [
                ...history,
                { at: Date.now(), extend: { ...args, validUntil: r['validUntil'] } },
              ],
            },
            n(w['version']),
          );
          if (w['document_id'])
            await setDoc({ eway_valid_until: Date.parse(s(r['validUntil'])) || null });
        } else if (kind === 'ewb_vehicle') {
          const vehicle = s(args['vehicleNo'])
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, '');
          await this.ewaybills.update(
            c,
            s(w['id']),
            {
              vehicle_no: vehicle,
              history_json: [
                ...history,
                { at: Date.now(), vehicle: { ...args, vehicleNo: vehicle } },
              ],
            },
            n(w['version']),
          );
        }
      }
    });
    // an IRN cancelled on the portal cancels the document in the books (it is no longer a valid invoice)
    if (kind === 'irn_cancel' && docId) {
      try {
        await runInTx(this.d, ctx, async (tx) => {
          const c: Ctx = { ...ctx, tx };
          const doc = (
            await tx
              .select()
              .from(this.d.schema.documents)
              .where(eq(this.d.schema.documents.id, docId))
          )[0] as Row;
          if (doc['status'] === 'issued')
            await new DocumentFlowRepo(this.d).cancelDocument(
              c,
              docId,
              n(doc['version']),
              `IRN cancelled: ${s(args['remarks'])}`,
            );
        });
      } catch {
        // a closed period (or another rule) keeps it issued; the e-invoice record says the IRN is cancelled
      }
    }
  }
}

/** The day after `date` (for tests and screens that show validity). */
export const dayAfter = (date: string): string => addDaysIso(date, 1);
