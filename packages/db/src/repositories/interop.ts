/**
 * Moving data in and out (prompt 34). Out: the books as plain records for the Tally writer in
 * `@gst/interop`. In: a bundle read from Tally, Vyapar or a spreadsheet is checked against the books
 * (a dry run that writes nothing), then written in one transaction: parties and items it does not know,
 * then each document through the tax engine and issued under the number it already has.
 *
 * Money in a file is never trusted over the engine: every imported document is worked out again by the
 * same engine the editor uses, and a document whose total differs from the file's is reported.
 */
import {
  buildDocument,
  canIssue,
  draftToRows,
  emptyDraft,
  emptyDraftLine,
  isUqc,
  STATES as StateNames,
  today,
  type DocumentType,
  type DraftDocument,
  type DraftLine,
} from '@gst/domain';
import type {
  ImportBundle,
  ImportDocument,
  ImportIssue,
  ImportItem,
  ImportParty,
  TallyExportInput,
} from '@gst/interop';
import { sql } from 'drizzle-orm';

import { queryRows, type Database } from '../database';
import type { Row } from '../schema';

import { BusinessRepo, PartyRepo } from './aggregates';
import { runInTx, type Ctx } from './base';
import { DocumentFlowRepo } from './document-flow';
import { ItemRepo, UnitRepo } from './items';
import { PaymentFlowRepo } from './payment-flow';
import { PeriodLockRepo } from './period-lock';

const s = (v: unknown): string => (v == null ? '' : String(v));
const n = (v: unknown): number => Number(v ?? 0);
const b = (v: unknown): bigint => BigInt(Math.trunc(Number(v ?? 0)));

/** A JSON column as a list: some drivers return the text, and a malformed value is an empty list. */
function listOf<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (typeof v === 'string') {
    try {
      const x: unknown = JSON.parse(v);
      return Array.isArray(x) ? (x as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** A name reduced to what identifies it: case, spacing, punctuation and company suffixes do not matter. */
export const nameKey = (name: string): string =>
  name
    .toLowerCase()
    .replace(/\b(pvt|private|ltd|limited|llp|co|company|and)\b/g, '')
    .replace(/[^a-z0-9]+/g, '');

const UNIT_WORDS: Record<string, string> = {
  nos: 'NOS',
  no: 'NOS',
  number: 'NOS',
  numbers: 'NOS',
  pcs: 'PCS',
  pc: 'PCS',
  piece: 'PCS',
  pieces: 'PCS',
  kg: 'KGS',
  kgs: 'KGS',
  kilogram: 'KGS',
  kilograms: 'KGS',
  gm: 'GMS',
  gms: 'GMS',
  gram: 'GMS',
  grams: 'GMS',
  ltr: 'LTR',
  ltrs: 'LTR',
  litre: 'LTR',
  litres: 'LTR',
  liter: 'LTR',
  liters: 'LTR',
  ml: 'MLT',
  mtr: 'MTR',
  mtrs: 'MTR',
  meter: 'MTR',
  meters: 'MTR',
  metre: 'MTR',
  metres: 'MTR',
  box: 'BOX',
  boxes: 'BOX',
  set: 'SET',
  sets: 'SET',
  bag: 'BAG',
  bags: 'BAG',
  pair: 'PAR',
  pairs: 'PAR',
  dozen: 'DOZ',
  doz: 'DOZ',
  unit: 'UNT',
  units: 'UNT',
};

/** The GST unit code a file's unit most likely means, or null when it is not one the software knows. */
export function unitCodeOf(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  const up = t.toUpperCase();
  if (isUqc(up)) return up;
  return UNIT_WORDS[t.toLowerCase().replace(/[^a-z]/g, '')] ?? null;
}

export interface PlannedMigration {
  ref: string;
  type: DocumentType;
  originalNumber: string;
  /** The number it will be issued under: the original, unless that is taken. */
  number: string;
  action: 'import' | 'skip';
  reason: string;
  /** What the engine makes of it. */
  engineTotalPaise: bigint;
  fileTotalPaise: bigint | null;
  /** Engine less file, when the file gave a total. */
  differencePaise: bigint | null;
}

export interface BookImportPlan {
  parties: { create: number; matched: number };
  items: { create: number; matched: number };
  documents: PlannedMigration[];
  payments: { ref: string; action: 'import' | 'skip'; reason: string }[];
  issues: ImportIssue[];
  /** True when nothing in the plan is an error, so applying it is allowed. */
  ok: boolean;
}

export interface BookImportOptions {
  /** The date opening balances are posted on; defaults to the earliest document in the file. */
  openingDate?: string;
  /** Tolerance in paise before a difference from the file's total is reported (default INR 1). */
  tolerancePaise?: bigint;
}

export interface BookImportResult {
  parties: number;
  items: number;
  documents: number;
  payments: number;
  skipped: number;
  issues: ImportIssue[];
}

interface Known {
  businessState: string;
  composition: boolean;
  partiesByGstin: Map<string, Row>;
  partiesByName: Map<string, Row>;
  itemsByName: Map<string, Row>;
  taken: Set<string>;
  lockedUntil: string | null;
}

const PURCHASE: DocumentType[] = ['purchase_bill', 'purchase_return'];

/** The state code of a party from what the file says, in order of trust. */
function stateOf(gstin: string, stateCode: string, fallback: string): string {
  if (/^\d{2}[A-Z0-9]{13}$/.test(gstin)) return gstin.slice(0, 2);
  return stateCode || fallback;
}

/** A draft document for the engine from an imported one. Ids are filled in when they are known. */
function draftOf(
  doc: ImportDocument,
  k: Pick<Known, 'businessState' | 'composition'>,
  partyState: string,
  ids: { party: string | null; items: Map<string, string>; units: Map<string, string> },
  roundOff: boolean,
): DraftDocument {
  const purchase = PURCHASE.includes(doc.type);
  const own = k.businessState;
  const supplierState = purchase ? partyState || own : own;
  const placeOfSupply = purchase ? own : doc.placeOfSupply || partyState || own;
  const base = emptyDraft(doc.type, doc.date, {
    supplierState,
    composition: !purchase && k.composition,
  });
  const anyDiscount = doc.lines.some((l) => l.discountPaise > 0n);
  const lines: DraftLine[] = doc.lines.map((l, i) => {
    const line = emptyDraftLine(`i${i}`);
    const unit = unitCodeOf(l.unit);
    line.itemId = l.itemName ? (ids.items.get(nameKey(l.itemName)) ?? null) : null;
    line.description = l.description;
    line.hsn = l.hsn;
    line.qtyMicros = l.qtyMicros;
    line.unitId = unit ? (ids.units.get(unit) ?? null) : null;
    line.ratePaise = l.ratePaise;
    line.discountValue =
      l.discountPaise > 0n && l.qtyMicros > 0n ? (l.discountPaise * 1_000_000n) / l.qtyMicros : 0n;
    line.gstRateBp = l.gstRateBp ?? 0;
    line.cessBp = l.cessBp;
    return line;
  });
  return {
    ...base,
    partyId: ids.party,
    partyName: doc.partyName,
    partyGstin: doc.partyGstin || null,
    partyState: partyState || null,
    placeOfSupply,
    export: placeOfSupply === '96',
    reverseCharge: doc.reverseCharge,
    discountMode: anyDiscount ? 'per_unit' : 'none',
    lines,
    roundOff,
    notes: doc.narration,
    ...(purchase ? { supplierInvoiceNo: doc.number, supplierInvoiceDate: doc.date } : {}),
  };
}

/** The engine's total for a draft. */
const totalOf = (d: DraftDocument): bigint => buildDocument(d).totals.totalPaise;

/** The draft whose round-off setting brings the engine closest to the file's total. */
function bestDraft(
  doc: ImportDocument,
  k: Pick<Known, 'businessState' | 'composition'>,
  partyState: string,
  ids: Parameters<typeof draftOf>[3],
): { draft: DraftDocument; total: bigint } {
  const on = draftOf(doc, k, partyState, ids, true);
  const off = draftOf(doc, k, partyState, ids, false);
  const tOn = totalOf(on);
  const tOff = totalOf(off);
  if (doc.fileTotalPaise === null) return { draft: on, total: tOn };
  const gap = (t: bigint) =>
    t > doc.fileTotalPaise! ? t - doc.fileTotalPaise! : doc.fileTotalPaise! - t;
  return gap(tOff) < gap(tOn) ? { draft: off, total: tOff } : { draft: on, total: tOn };
}

export class InteropRepo {
  constructor(private readonly d: Database) {}

  private async known(ctx: Ctx): Promise<Known> {
    const tx = ctx.tx;
    const biz = await new BusinessRepo(this.d).get(ctx);
    const parties = await queryRows(
      this.d,
      tx,
      sql`SELECT * FROM parties WHERE business_id = ${ctx.businessId} AND deleted_at IS NULL`,
    );
    const items = await queryRows(
      this.d,
      tx,
      sql`SELECT * FROM items WHERE business_id = ${ctx.businessId} AND deleted_at IS NULL`,
    );
    const taken = await queryRows(
      this.d,
      tx,
      sql`SELECT type, number FROM documents WHERE business_id = ${ctx.businessId}
          AND deleted_at IS NULL AND status <> 'draft' AND number IS NOT NULL`,
    );
    const lock = await new PeriodLockRepo(this.d).get(ctx);
    const k: Known = {
      businessState: s(biz?.['state_code']),
      composition: biz?.['scheme'] === 'composition',
      partiesByGstin: new Map(),
      partiesByName: new Map(),
      itemsByName: new Map(items.map((r) => [nameKey(s(r['name'])), r as Row])),
      taken: new Set(taken.map((r) => `${s(r['type'])}|${s(r['number'])}`)),
      lockedUntil: lock?.until ?? null,
    };
    for (const p of parties) {
      if (s(p['gstin'])) k.partiesByGstin.set(s(p['gstin']).toUpperCase(), p as Row);
      k.partiesByName.set(nameKey(s(p['name'])), p as Row);
    }
    return k;
  }

  private findParty(k: Known, name: string, gstin: string): Row | null {
    return (
      (gstin ? k.partiesByGstin.get(gstin.toUpperCase()) : undefined) ??
      k.partiesByName.get(nameKey(name)) ??
      null
    );
  }

  /**
   * Check a bundle against the books and say what applying it would do. Writes nothing. The same checks
   * run again when it is applied, inside the transaction.
   */
  async plan(
    ctx: Ctx,
    bundle: ImportBundle,
    opts: BookImportOptions = {},
  ): Promise<BookImportPlan> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const k = await this.known(c);
      const tol = opts.tolerancePaise ?? 100n;
      const issues: ImportIssue[] = [...bundle.issues];
      const add = (severity: ImportIssue['severity'], ref: string, message: string) =>
        issues.push({ severity, ref, message });

      const wantedParties = new Map<string, { name: string; gstin: string }>();
      for (const p of bundle.parties)
        wantedParties.set(nameKey(p.name), { name: p.name, gstin: p.gstin });
      for (const doc of bundle.documents)
        if (doc.partyName && !wantedParties.has(nameKey(doc.partyName)))
          wantedParties.set(nameKey(doc.partyName), { name: doc.partyName, gstin: doc.partyGstin });
      let newParties = 0;
      let matchedParties = 0;
      for (const w of wantedParties.values()) {
        if (this.findParty(k, w.name, w.gstin)) matchedParties++;
        else newParties++;
      }

      const wantedItems = new Set<string>();
      for (const i of bundle.items) wantedItems.add(nameKey(i.name));
      for (const doc of bundle.documents)
        for (const l of doc.lines) if (l.itemName) wantedItems.add(nameKey(l.itemName));
      let newItems = 0;
      let matchedItems = 0;
      for (const key of wantedItems) {
        if (k.itemsByName.has(key)) matchedItems++;
        else newItems++;
      }

      const taken = new Set(k.taken);
      const documents: PlannedMigration[] = [];
      for (const doc of bundle.documents) {
        const party = this.findParty(k, doc.partyName, doc.partyGstin);
        const partyState = stateOf(
          doc.partyGstin || s(party?.['gstin']),
          s(party?.['state_code']),
          '',
        );
        const { total } = bestDraft(doc, k, partyState, {
          party: null,
          items: new Map(),
          units: new Map(),
        });
        const planned: PlannedMigration = {
          ref: doc.ref,
          type: doc.type,
          originalNumber: doc.number,
          number: doc.number,
          action: 'import',
          reason: '',
          engineTotalPaise: total,
          fileTotalPaise: doc.fileTotalPaise,
          differencePaise: doc.fileTotalPaise === null ? null : total - doc.fileTotalPaise,
        };
        const check = canIssue(doc.type, k.composition ? 'composition' : 'regular');
        if (!check.ok) {
          planned.action = 'skip';
          planned.reason = check.reason;
        } else if (k.lockedUntil && doc.date <= k.lockedUntil) {
          planned.action = 'skip';
          planned.reason = `the books are locked up to ${k.lockedUntil}`;
        } else if (doc.lines.length === 0) {
          planned.action = 'skip';
          planned.reason = 'no lines';
        } else if (doc.partyName.trim() === '') {
          planned.action = 'skip';
          planned.reason = 'no party';
        }
        if (planned.action === 'import') {
          let number = doc.number;
          for (let i = 2; taken.has(`${doc.type}|${number}`) && i < 1000; i++)
            number = i === 2 ? `${doc.number}/IMP` : `${doc.number}/IMP${i}`;
          if (number !== doc.number) {
            add(
              'warning',
              doc.ref,
              `${doc.number} is already used here; it will be imported as ${number}`,
            );
            planned.number = number;
          }
          taken.add(`${doc.type}|${number}`);
          if (number.length > 16 || !/^[A-Za-z0-9/-]+$/.test(number))
            add(
              'warning',
              doc.ref,
              `${number} is not a number the GST portal accepts (16 characters, letters, digits, - and /)`,
            );
          if (doc.lines.some((l) => l.gstRateBp === null))
            add('warning', doc.ref, 'a line has no tax rate; it is taken as 0%');
          if (
            planned.differencePaise !== null &&
            (planned.differencePaise > tol || -planned.differencePaise > tol)
          )
            add(
              'warning',
              doc.ref,
              `the file says ${planned.fileTotalPaise! / 100n} and the tax engine makes it ${total / 100n}.${String(total % 100n).padStart(2, '0')}; the engine's figure is imported`,
            );
        } else add('error', doc.ref, `${doc.number} will not be imported: ${planned.reason}`);
        documents.push(planned);
      }

      const payments = bundle.payments.map((p) => {
        const party = this.findParty(k, p.partyName, '');
        if (!party && !wantedParties.has(nameKey(p.partyName)))
          return { ref: p.ref, action: 'skip' as const, reason: 'no such party' };
        if (k.lockedUntil && p.date <= k.lockedUntil)
          return {
            ref: p.ref,
            action: 'skip' as const,
            reason: `the books are locked up to ${k.lockedUntil}`,
          };
        return { ref: p.ref, action: 'import' as const, reason: '' };
      });
      for (const p of payments)
        if (p.action === 'skip') add('error', p.ref, `will not be imported: ${p.reason}`);

      return {
        parties: { create: newParties, matched: matchedParties },
        items: { create: newItems, matched: matchedItems },
        documents,
        payments,
        issues,
        ok: !issues.some((i) => i.severity === 'error' && !/will not be imported/.test(i.message)),
      };
    });
  }

  /**
   * Write a bundle: parties, units and items it needs, then every document that the plan allows, then
   * payments. One transaction: a failure leaves the books as they were. Rows the plan skipped are left
   * out and counted.
   */
  async apply(
    ctx: Ctx,
    bundle: ImportBundle,
    opts: BookImportOptions = {},
  ): Promise<BookImportResult> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const plan = await this.plan(c, bundle, opts);
      const k = await this.known(c);
      const parties = new PartyRepo(this.d);
      const items = new ItemRepo(this.d);
      const units = new UnitRepo(this.d);
      const flow = new DocumentFlowRepo(this.d);
      const issues = [...plan.issues];
      const add = (severity: ImportIssue['severity'], ref: string, message: string) =>
        issues.push({ severity, ref, message });

      const firstDate =
        bundle.documents.map((x) => x.date).sort()[0] ??
        opts.openingDate ??
        today(() => new Date());
      const openingDate = opts.openingDate ?? firstDate;

      // parties: those in the file, then any a document names that the file did not list
      const want = new Map<string, ImportParty>();
      for (const p of bundle.parties) want.set(nameKey(p.name), p);
      for (const doc of bundle.documents)
        if (doc.partyName && !want.has(nameKey(doc.partyName)))
          want.set(nameKey(doc.partyName), {
            name: doc.partyName,
            type: PURCHASE.includes(doc.type) ? 'supplier' : 'customer',
            gstin: doc.partyGstin,
            pan: '',
            stateCode: doc.placeOfSupply,
            phone: '',
            email: '',
            addressLine: '',
            city: '',
            pincode: '',
            openingBalancePaise: 0n,
            country: 'India',
          });
      const partyIds = new Map<string, string>();
      let createdParties = 0;
      for (const [key, p] of want) {
        const have = this.findParty(k, p.name, p.gstin);
        if (have) {
          partyIds.set(key, s(have['id']));
          continue;
        }
        const gstin = /^\d{2}[A-Z0-9]{13}$/.test(p.gstin) ? p.gstin : '';
        const row = await parties.create(c, {
          type: p.type,
          name: p.name,
          gstin: gstin || null,
          pan: p.pan || (gstin ? gstin.slice(2, 12) : null),
          state_code: gstin ? gstin.slice(0, 2) : p.stateCode || null,
          country: p.country || 'India',
          phone: p.phone || null,
          email: p.email || null,
          city: p.city || null,
          addresses_json:
            p.addressLine || p.city || p.pincode
              ? [{ kind: 'billing', line1: p.addressLine, city: p.city, pincode: p.pincode }]
              : [],
          opening_balance_paise: Number(p.openingBalancePaise),
          opening_balance_date: p.openingBalancePaise !== 0n ? openingDate : null,
          is_unregistered: !gstin,
        } as never);
        partyIds.set(key, s(row['id']));
        k.partiesByName.set(key, row);
        if (gstin) k.partiesByGstin.set(gstin, row);
        createdParties++;
      }

      // units the lines and items use
      const unitIds = new Map<string, string>();
      const wantUnits = new Set<string>();
      for (const i of bundle.items) wantUnits.add(i.unit);
      for (const doc of bundle.documents) for (const l of doc.lines) wantUnits.add(l.unit);
      for (const text of wantUnits) {
        const code = unitCodeOf(text);
        if (!code || unitIds.has(code)) continue;
        try {
          unitIds.set(code, s((await units.addStandard(c, code))['id']));
        } catch (e) {
          add(
            'warning',
            text,
            `unit ${text} was not added: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      // items: those in the file, then any line names that the file did not list
      const wantItem = new Map<string, ImportItem>();
      for (const i of bundle.items) wantItem.set(nameKey(i.name), i);
      for (const doc of bundle.documents)
        for (const l of doc.lines)
          if (l.itemName && !wantItem.has(nameKey(l.itemName)))
            wantItem.set(nameKey(l.itemName), {
              name: l.itemName,
              sku: '',
              hsn: l.hsn,
              unit: l.unit,
              gstRateBp: l.gstRateBp,
              sellPaise: PURCHASE.includes(doc.type) ? 0n : l.ratePaise,
              buyPaise: PURCHASE.includes(doc.type) ? l.ratePaise : 0n,
              kind: l.hsn.startsWith('99') ? 'service' : 'goods',
            });
      const itemIds = new Map<string, string>();
      let createdItems = 0;
      for (const [key, i] of wantItem) {
        const have = k.itemsByName.get(key);
        if (have) {
          itemIds.set(key, s(have['id']));
          continue;
        }
        const code = unitCodeOf(i.unit);
        const row = await items.create(c, {
          kind: i.kind,
          name: i.name,
          sku: i.sku || null,
          hsn: i.hsn || null,
          unit_id: code ? (unitIds.get(code) ?? null) : null,
          sale_rate_paise: Number(i.sellPaise),
          purchase_rate_paise: Number(i.buyPaise),
          gst_rate_bp: i.gstRateBp ?? 0,
        } as never);
        itemIds.set(key, s(row['id']));
        createdItems++;
      }

      // documents, in date order so an older one never meets a newer one's lock
      let documents = 0;
      let skipped = 0;
      const order = bundle.documents
        .map((doc, index) => ({ doc, index }))
        .sort((a, z) => a.doc.date.localeCompare(z.doc.date) || a.index - z.index);
      for (const { doc, index } of order) {
        const planned = plan.documents[index]!;
        if (planned.action === 'skip') {
          skipped++;
          continue;
        }
        const partyId = partyIds.get(nameKey(doc.partyName)) ?? null;
        const partyRow = partyId ? this.partyRow(k, doc) : null;
        const partyState = stateOf(
          doc.partyGstin || s(partyRow?.['gstin']),
          s(partyRow?.['state_code']),
          want.get(nameKey(doc.partyName))?.stateCode ?? '',
        );
        const { draft } = bestDraft(doc, k, partyState, {
          party: partyId,
          items: itemIds,
          units: unitIds,
        });
        const r = draftToRows(draft);
        const docRow = {
          ...(r.doc as unknown as Record<string, unknown>),
          metadata_json: {
            ...((r.doc as unknown as Record<string, unknown>)['metadata_json'] as object | null),
            imported: {
              source: doc.source,
              originalNumber: doc.number,
              ref: doc.ref,
              fileTotalPaise: doc.fileTotalPaise === null ? null : Number(doc.fileTotalPaise),
            },
          },
        };
        const saved = await flow.saveDraft(c, {
          doc: docRow,
          lines: r.lines as unknown as Record<string, unknown>[],
        });
        await flow.issueImported(c, s(saved.document['id']), n(saved.document['version']), {
          number: planned.number,
        });
        documents++;
      }

      // payments: money received or paid, left unallocated as party credit
      let payments = 0;
      const pay = new PaymentFlowRepo(this.d);
      for (const [i, p] of bundle.payments.entries()) {
        if (plan.payments[i]!.action === 'skip') {
          skipped++;
          continue;
        }
        const partyId =
          partyIds.get(nameKey(p.partyName)) ?? s(this.findParty(k, p.partyName, '')?.['id']);
        await pay.record(c, {
          direction: p.direction,
          partyId,
          date: p.date,
          mode: /cash/i.test(p.account) ? 'cash' : 'bank',
          amountPaise: p.amountPaise,
          reference: p.reference || null,
          notes: `Imported from ${bundle.source}`,
          allocations: [],
        });
        payments++;
      }
      if (payments > 0)
        add(
          'info',
          'payments',
          `${payments} payments were imported as party credit; allocate them to invoices by hand`,
        );

      return { parties: createdParties, items: createdItems, documents, payments, skipped, issues };
    });
  }

  private partyRow(k: Known, doc: ImportDocument): Row | null {
    return this.findParty(k, doc.partyName, doc.partyGstin);
  }

  /** The books as plain records for the Tally writer: issued documents of a period, with their parties, items and payments. */
  async tallyInput(ctx: Ctx, from: string, to: string): Promise<TallyExportInput> {
    return runInTx(this.d, ctx, async (tx) => {
      const biz = await new BusinessRepo(this.d).get({ ...ctx, tx });
      const parties = await queryRows(
        this.d,
        tx,
        sql`SELECT * FROM parties WHERE business_id = ${ctx.businessId} AND deleted_at IS NULL ORDER BY name`,
      );
      const items = await queryRows(
        this.d,
        tx,
        sql`SELECT i.name, i.hsn, i.description, i.gst_rate_bp, i.kind, u.code AS unit_code
            FROM items i LEFT JOIN units u ON u.id = i.unit_id
            WHERE i.business_id = ${ctx.businessId} AND i.deleted_at IS NULL AND i.kind = 'goods' ORDER BY i.name`,
      );
      const docs = await queryRows(
        this.d,
        tx,
        sql`SELECT d.id, d.type, d.number, d.date, d.party_name, d.place_of_supply_state AS pos, d.notes,
                   d.reverse_charge, d.total_taxable_paise, d.total_cgst_paise, d.total_sgst_paise,
                   d.total_utgst_paise, d.total_igst_paise, d.total_cess_paise, d.tcs_paise,
                   d.round_off_paise, d.total_paise, coalesce(p.gstin, '') AS gstin
            FROM documents d LEFT JOIN parties p ON p.id = d.party_id
            WHERE d.business_id = ${ctx.businessId} AND d.deleted_at IS NULL AND d.status = 'issued'
              AND d.date >= ${from} AND d.date <= ${to}
              AND d.type IN ('tax_invoice', 'bill_of_supply', 'credit_note', 'debit_note', 'purchase_bill', 'purchase_return')
            ORDER BY d.date, d.number`,
      );
      const lines = await queryRows(
        this.d,
        tx,
        sql`SELECT l.document_id, l.description, l.hsn, l.qty_micros, l.rate_paise, l.discount_value,
                   l.taxable_paise, (l.cgst_bp + l.sgst_bp + l.igst_bp + l.utgst_bp) AS rate_bp,
                   i.name AS item_name, i.kind AS item_kind, u.code AS unit_code
            FROM document_lines l
            JOIN documents d ON d.id = l.document_id
            LEFT JOIN items i ON i.id = l.item_id LEFT JOIN units u ON u.id = l.unit_id
            WHERE d.business_id = ${ctx.businessId} AND d.deleted_at IS NULL AND l.deleted_at IS NULL
              AND d.status = 'issued' AND d.date >= ${from} AND d.date <= ${to}
            ORDER BY l.document_id, l.line_no`,
      );
      const pays = await queryRows(
        this.d,
        tx,
        sql`SELECT pay.date, pay.direction, pay.mode, pay.amount_paise, pay.reference, p.name AS party_name
            FROM payments pay JOIN parties p ON p.id = pay.party_id
            WHERE pay.business_id = ${ctx.businessId} AND pay.deleted_at IS NULL AND pay.status = 'cleared'
              AND pay.date >= ${from} AND pay.date <= ${to}
            ORDER BY pay.date, pay.id`,
      );
      const byDoc = new Map<string, Row[]>();
      for (const l of lines)
        (
          byDoc.get(s(l['document_id'])) ??
          byDoc.set(s(l['document_id']), []).get(s(l['document_id']))!
        ).push(l as Row);

      return {
        companyName: s(biz?.['legal_name']) || 'Company',
        parties: parties.map((p) => ({
          name: s(p['name']),
          type: s(p['type']) as 'customer' | 'supplier' | 'both',
          gstin: s(p['gstin']),
          pan: s(p['pan']),
          stateCode: s(p['state_code']),
          addressLines: listOf<{ line1?: string; city?: string }>(p['addresses_json'])
            .flatMap((a) => [a.line1 ?? '', a.city ?? ''])
            .filter(Boolean),
          pincode: listOf<{ pincode?: string }>(p['addresses_json'])[0]?.pincode ?? '',
          country: s(p['country']) || 'India',
          registration: p['is_composition']
            ? 'Composition'
            : s(p['gstin'])
              ? 'Regular'
              : 'Unregistered',
        })),
        items: items.map((i) => ({
          name: s(i['name']),
          hsn: s(i['hsn']),
          unit: s(i['unit_code']) || 'NOS',
          gstRateBp: n(i['gst_rate_bp']),
          description: s(i['description']),
        })),
        documents: docs.map((d) => ({
          type: s(d['type']) as DocumentType,
          number: s(d['number']),
          date: s(d['date']),
          partyName: s(d['party_name']),
          partyGstin: s(d['gstin']),
          placeOfSupply: s(d['pos']) ? (StateNames[s(d['pos'])] ?? '') : '',
          reference: '',
          narration: s(d['notes']),
          reverseCharge: !!d['reverse_charge'],
          lines: (byDoc.get(s(d['id'])) ?? []).map((l) => {
            const qty = b(l['qty_micros']);
            const taxable = b(l['taxable_paise']);
            const gross = (qty * b(l['rate_paise'])) / 1_000_000n;
            const discounted = n(l['discount_value']) > 0;
            // a price that includes tax has no discount to show: the line is written at its taxable rate
            const rate =
              discounted || gross === taxable || qty === 0n
                ? b(l['rate_paise'])
                : (taxable * 1_000_000n) / qty;
            return {
              description: s(l['description']) || s(l['item_name']),
              itemName: s(l['item_kind']) === 'goods' && l['item_name'] ? s(l['item_name']) : null,
              hsn: s(l['hsn']),
              qtyMicros: qty,
              unit: s(l['unit_code']) || 'NOS',
              ratePaise: rate,
              discountPaise: discounted && gross > taxable ? gross - taxable : 0n,
              taxablePaise: taxable,
              gstRateBp: n(l['rate_bp']),
            };
          }),
          taxablePaise: b(d['total_taxable_paise']),
          cgstPaise: b(d['total_cgst_paise']),
          sgstPaise: b(d['total_sgst_paise']),
          utgstPaise: b(d['total_utgst_paise']),
          igstPaise: b(d['total_igst_paise']),
          cessPaise: b(d['total_cess_paise']),
          tcsPaise: b(d['tcs_paise']),
          roundOffPaise: b(d['round_off_paise']),
          totalPaise: b(d['total_paise']),
        })),
        payments: pays.map((p) => ({
          direction: s(p['direction']) === 'made' ? ('made' as const) : ('received' as const),
          date: s(p['date']),
          partyName: s(p['party_name']),
          amountPaise: b(p['amount_paise']),
          mode: s(p['mode']),
          voucherNumber: '',
          reference: s(p['reference']),
        })),
      };
    });
  }
}
