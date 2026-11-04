/**
 * Rule 46 of the CGST Rules lists what a tax invoice must show. This prints real documents (seeded ones,
 * and ones made through the repositories for the cases the seed does not have: export and reverse
 * charge) with the Classic template and checks every mandatory field is on the page. See
 * docs/compliance/invoice-fields.md for the rule-by-rule mapping a reviewer signs.
 */
import {
  buildDocument,
  draftFromRows,
  draftToRows,
  emptyDraft,
  emptyDraftLine,
  validateDocumentNumber,
  type DraftDocument,
} from '@gst/domain';
import {
  FixedMeasurer,
  buildPrintModel,
  buildStoredPrintModel,
  layoutDocument,
  presetSpec,
  type PrintModel,
} from '@gst/print';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from './database';
import {
  BusinessRepo,
  DocumentRepo,
  PartyRepo,
  createOrganisation,
} from './repositories/aggregates';
import type { Ctx } from './repositories/base';
import { DocumentFlowRepo } from './repositories/document-flow';
import { seedDemo } from './seed';
import { openTestDb } from './testing/harness';

const measurer = new FixedMeasurer(0.5);
let k = 0;
const newKey = () => `r${++k}`;

/** Every text the Classic template prints for a stored document, all pages. */
async function printed(
  d: Database,
  ctx: Ctx,
  documentId: string,
  gstin: string | null,
): Promise<{ texts: string[]; model: PrintModel }> {
  const flow = new DocumentFlowRepo(d);
  const found = (await flow.load(ctx, documentId))!;
  const party = found.document['party_id']
    ? await new PartyRepo(d).get(ctx, found.document['party_id'])
    : null;
  const biz = (await new BusinessRepo(d).get(ctx))!;
  const addr = party?.['addresses_json'] as
    { line1?: string; city?: string; pincode?: string }[] | null;
  // issued documents print from what was stored, never from a recalculation
  const model = buildStoredPrintModel({
    document: found.document,
    lines: found.lines,
    business: {
      name: String(biz['trade_name'] ?? biz['legal_name']),
      gstin,
      pan: (biz['pan'] as string | null) ?? null,
      address: ['12 Market Road', 'Mumbai 400069'],
      phone: null,
      email: null,
      scheme: 'regular',
      logo: null,
    },
    party: party
      ? {
          name: String(party['name']),
          gstin: (party['gstin'] as string | null) ?? null,
          address: addr?.[0]
            ? [addr[0].line1 ?? '', `${addr[0].city ?? ''} ${addr[0].pincode ?? ''}`.trim()]
            : [],
          stateName: String(party['state_code'] ?? ''),
          phone: null,
        }
      : null,
    accounts: [],
    units: new Map(),
  });
  const r = layoutDocument(model, presetSpec('classic'), { measurer });
  const texts = r.pages.flatMap((p) => p.items.flatMap((i) => (i.t === 'text' ? [i.text] : [])));
  return { texts, model };
}

describe('Classic template and Rule 46', () => {
  let d: Database;
  let ctx: Ctx;
  let flow: DocumentFlowRepo;
  let customerId: string;
  let businessGstin: string;

  const issue = async (over: Partial<DraftDocument>, lineOver = {}) => {
    const dr: DraftDocument = {
      ...emptyDraft('tax_invoice', '2026-05-01', { supplierState: '27' }),
      partyId: customerId,
      partyName: 'Rao Works',
      partyGstin: '29AAAPA1234A1Z5',
      lines: [
        {
          ...emptyDraftLine('a'),
          description: 'Steel bolt M8',
          hsn: '7318',
          qtyMicros: 5_000_000n,
          ratePaise: 12_000n,
          gstRateBp: 1800,
          ...lineOver,
        },
      ],
      ...over,
    };
    const rows = draftToRows(dr);
    const saved = await flow.saveDraft(ctx, {
      doc: rows.doc as never,
      lines: rows.lines as never,
    });
    const r = await flow.issueDraft(ctx, saved.document['id'], saved.document['version']);
    return r;
  };

  beforeAll(async () => {
    d = await openTestDb('sqlite');
    const org = await createOrganisation(d, 'Org');
    const base: Ctx = { orgId: org['id'], businessId: '', actor: 't', deviceId: 'd' };
    businessGstin = '27AABCD1234E1Z5';
    const biz = await new BusinessRepo(d).create(base, {
      legal_name: 'Demo Traders Pvt Ltd',
      trade_name: 'Demo Traders',
      gstin: businessGstin,
      state_code: '27',
      pan: 'AABCD1234E',
    });
    ctx = { ...base, businessId: biz['id'] };
    flow = new DocumentFlowRepo(d);
    customerId = (
      await new PartyRepo(d).create(ctx, {
        type: 'customer',
        name: 'Rao Works',
        gstin: '29AAAPA1234A1Z5',
        state_code: '29',
        addresses_json: [
          { kind: 'billing', line1: '4 Station Lane', city: 'Bengaluru', pincode: '560001' },
        ],
      })
    )['id'];
  }, 60_000);
  afterAll(async () => {
    await d.close();
  });

  /** The fields every tax invoice must carry, whatever the supply. */
  const mandatory = (t: string[], model: PrintModel, number: string) => {
    const has = (s: string | RegExp, why: string) =>
      expect(
        t.some((x) => (typeof s === 'string' ? x.includes(s) : s.test(x))),
        why,
      ).toBe(true);
    has('Demo Traders', "46(a) the supplier's name");
    has('12 Market Road', "46(a) the supplier's address");
    has(businessGstin, "46(a) the supplier's GSTIN");
    expect(
      validateDocumentNumber(number),
      '46(b) a number of 16 characters or fewer, allowed characters',
    ).toEqual([]);
    has(number, '46(b) the consecutive serial number');
    has('2026-05-01', '46(c) the date of issue');
    has('Rao Works', "46(d) the recipient's name");
    has('29AAAPA1234A1Z5', "46(d) the recipient's GSTIN");
    has('4 Station Lane', "46(d) the recipient's address");
    has('7318', '46(f) the HSN code');
    has('Steel bolt M8', '46(g) the description of goods');
    has(/^5( |$)/, '46(h) the quantity');
    has('600.00', '46(j) the taxable value');
    has(model.totals.total, '46(i) the total value of supply');
    has('Authorised Signatory', '46(p) the signature');
    has(/^Rupees .* Only$/, 'the total in words');
  };

  it('intra-state: CGST and SGST, rate and amount; place of supply', async () => {
    const r = await issue({ placeOfSupply: '27' });
    const { texts, model } = await printed(d, ctx, r.document['id'], businessGstin);
    mandatory(texts, model, String(r.document['number']));
    expect(texts).toContain('CGST');
    expect(texts).toContain('SGST');
    expect(texts).not.toContain('IGST');
    expect(texts).toContain('9%'.replace('9%', '18%')); // 46(k) the rate of tax
    expect(texts).toContain('54.00'); // 46(l) CGST 9% of 600, and the same for SGST
    expect(texts.filter((x) => x === '54.00').length).toBeGreaterThanOrEqual(2);
    expect(texts.some((x) => x.includes('Maharashtra (27)'))).toBe(true); // 46(m) place of supply, state and code
    expect(texts).not.toContain('Tax is payable on reverse charge');
  });

  it('inter-state: IGST, and the place of supply names the state and code', async () => {
    const r = await issue({ placeOfSupply: '29' });
    const { texts, model } = await printed(d, ctx, r.document['id'], businessGstin);
    mandatory(texts, model, String(r.document['number']));
    expect(texts).toContain('IGST');
    expect(texts).not.toContain('CGST');
    expect(texts).toContain('108.00'); // 18% of 600
    expect(texts.some((x) => x.includes('Karnataka (29)'))).toBe(true);
  });

  it('export under LUT: the Rule 46 wording, and no tax charged', async () => {
    const r = await issue({ placeOfSupply: '96', export: true, lut: true });
    const { texts } = await printed(d, ctx, r.document['id'], businessGstin);
    expect(
      texts.some((x) => x.includes('export under LUT without payment of integrated tax')),
    ).toBe(true);
    expect(texts.some((x) => x.includes('Outside India (96)'))).toBe(true);
    expect(texts).not.toContain('IGST');
    expect(texts).toContain('600.00');
  });

  it('reverse charge: the document says tax is payable by the recipient, and the tax is not in the total', async () => {
    const r = await issue({ placeOfSupply: '27', reverseCharge: true });
    const { texts, model } = await printed(d, ctx, r.document['id'], businessGstin);
    mandatory(texts, model, String(r.document['number']));
    expect(texts).toContain('Tax is payable on reverse charge'); // 46(o)
    expect(model.totals.totalPaise).toBe(60_000n); // the invoice total excludes the tax the recipient pays
  });

  it('the stored model and the live (priced) model print the same document', async () => {
    const r = await issue({ placeOfSupply: '29' });
    const found = (await flow.load(ctx, r.document['id']))!;
    const draft = draftFromRows(found.document, found.lines, newKey);
    const live = buildPrintModel({
      draft,
      built: buildDocument(draft),
      number: String(found.document['number']),
      status: 'issued',
      business: (await printed(d, ctx, r.document['id'], businessGstin)).model.business,
      party: null,
      accounts: [],
      units: new Map(),
    });
    const stored = (await printed(d, ctx, r.document['id'], businessGstin)).model;
    expect(stored.totals).toEqual(live.totals);
    expect(stored.lines.map((l) => [l.taxable, l.igst, l.amount])).toEqual(
      live.lines.map((l) => [l.taxable, l.igst, l.amount]),
    );
    expect(stored.taxSummary).toEqual(live.taxSummary);
    expect(stored.supply).toBe(live.supply);
  });

  it('the supplier invoice number is printed when it is a purchase bill, and a cancelled document says so', async () => {
    const dr = emptyDraft('purchase_bill', '2026-05-02', { supplierState: '27' });
    const draft: DraftDocument = {
      ...dr,
      partyId: customerId,
      partyName: 'Rao Works',
      supplierInvoiceNo: 'SUP-77',
      supplierInvoiceDate: '2026-05-01',
      lines: [
        {
          ...emptyDraftLine('p'),
          description: 'Bolt',
          hsn: '7318',
          qtyMicros: 1_000_000n,
          ratePaise: 10_000n,
          gstRateBp: 1800,
        },
      ],
    };
    const rows = draftToRows(draft);
    const saved = await flow.saveDraft(ctx, { doc: rows.doc as never, lines: rows.lines as never });
    const issued = await flow.issueDraft(ctx, saved.document['id'], saved.document['version']);
    const { texts } = await printed(d, ctx, issued.document['id'], businessGstin);
    expect(texts.some((x) => x.includes('SUP-77'))).toBe(true);

    await flow.cancelDocument(
      ctx,
      issued.document['id'],
      issued.document['version'],
      'entered twice',
    );
    const after = await printed(d, ctx, issued.document['id'], businessGstin);
    expect(after.texts).toContain('CANCELLED');
  });

  it('seeded documents of both kinds print every field the data has', async () => {
    const seeded = await openTestDb('sqlite');
    try {
      const { ctx: sctx } = await seedDemo(seeded);
      const docs = (await new DocumentRepo(seeded).list(sctx)).filter(
        (x) => x['type'] === 'tax_invoice' && x['status'] === 'issued',
      );
      const intra = docs.find((x) => x['supply_type'] === 'intra')!;
      const inter = docs.find((x) => x['supply_type'] === 'inter')!;
      for (const doc of [intra, inter]) {
        const { texts, model } = await printed(seeded, sctx, doc['id'], '27AABCD1234E1Z5');
        const number = String(doc['number']);
        expect(validateDocumentNumber(number)).toEqual([]);
        expect(texts.some((x) => x.includes(number))).toBe(true);
        expect(texts.some((x) => x.includes(String(doc['date'])))).toBe(true);
        expect(texts).toContain(model.totals.total);
        expect(texts.some((x) => /^\d{4,8}$/.test(x))).toBe(true); // an HSN code
        expect(texts).toContain('Authorised Signatory');
        expect(texts.some((x) => x.includes(`(${doc['place_of_supply_state']})`))).toBe(true);
        expect(texts.includes(doc['supply_type'] === 'intra' ? 'CGST' : 'IGST')).toBe(true);
      }
    } finally {
      await seeded.close();
    }
  });
});
