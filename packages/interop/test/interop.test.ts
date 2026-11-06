import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseCsv } from '@gst/domain';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TALLY_NAMES,
  DOCUMENT_TEMPLATE,
  TallyReader,
  XmlStream,
  buildTallyMasters,
  buildTallyVouchers,
  classifySheet,
  itemsFromRows,
  partiesFromRows,
  detectPartyMapping,
  detectItemMapping,
  decodeEntities,
  decodeXmlBytes,
  detectDocumentMapping,
  documentTypeFromText,
  documentsFromRows,
  escapeXml,
  joinSheets,
  readTally,
  readXml,
  sheetDate,
  snapRate,
  sniffXmlEncoding,
  tallyIsoDate,
  tallyPaise,
  tallyQuantity,
  tallyRate,
  type TallyDocument,
  type TallyExportInput,
  type XmlNode,
} from '../src';

const R = (n: number): bigint => BigInt(Math.round(n * 100));

describe('xml', () => {
  it('escapes text and drops characters XML cannot carry', () => {
    expect(escapeXml('A & B <c> "d"')).toBe('A &amp; B &lt;c&gt; &quot;d&quot;');
    expect(escapeXml('a\u0004b')).toBe('ab');
    expect(decodeEntities('a &amp; b &#65; &#x42; &#4; &unknown;')).toBe('a & b A B  &unknown;');
  });

  it('reads the wanted elements with attributes, nesting, CDATA and comments', () => {
    const seen: XmlNode[] = [];
    readXml(
      '<?xml version="1.0"?><A><!-- c --><ITEM NAME="x &amp; y" K=\'v\'><NAME>One</NAME><SUB><V>1</V><V>2</V></SUB><T><![CDATA[a < b]]></T></ITEM><SKIP>no</SKIP><ITEM/></A>',
      new Set(['ITEM']),
      (n) => seen.push(n),
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]!.attrs).toEqual({ NAME: 'x & y', K: 'v' });
    expect(seen[0]!.children.map((c) => c.name)).toEqual(['NAME', 'SUB', 'T']);
    expect(seen[0]!.children[1]!.children.map((c) => c.text)).toEqual(['1', '2']);
    expect(seen[0]!.children[2]!.text).toBe('a < b');
    expect(seen[1]!.name).toBe('ITEM');
  });

  it('copes with a tag, an attribute value with ">" and an entity split across pieces', () => {
    const xml = '<R><ITEM NAME="a>b"><N>caf&#233; &amp; co</N></ITEM></R>';
    for (let size = 1; size <= 7; size++) {
      const seen: XmlNode[] = [];
      const s = new XmlStream(new Set(['ITEM']), (n) => seen.push(n));
      for (let i = 0; i < xml.length; i += size) s.write(xml.slice(i, i + size));
      s.end();
      expect(seen, `piece size ${size}`).toHaveLength(1);
      expect(seen[0]!.attrs['NAME']).toBe('a>b');
      expect(seen[0]!.children[0]!.text).toBe('café & co');
    }
  });

  it('streams a large file without holding it: memory is one element at a time', () => {
    const one = '<VOUCHER><NUMBER>1</NUMBER></VOUCHER>';
    let count = 0;
    const s = new XmlStream(new Set(['VOUCHER']), () => count++);
    s.write('<ENVELOPE>');
    for (let i = 0; i < 50_000; i++) s.write(one);
    s.write('</ENVELOPE>');
    s.end();
    expect(count).toBe(50_000);
  });

  it('decodes UTF-16 files by their byte order mark', () => {
    const text = '<A>₹ café</A>';
    const le = new Uint8Array([
      0xff,
      0xfe,
      ...[...text].flatMap((c) => [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8]),
    ]);
    expect(decodeXmlBytes(le)).toBe(text);
    expect(sniffXmlEncoding(le)).toBe('utf-16le');
    const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
    expect(decodeXmlBytes(utf8)).toBe(text);
    expect(sniffXmlEncoding(utf8)).toBe('utf-8');
  });
});

describe('tally text helpers', () => {
  it('reads amounts, quantities, rates and dates the way Tally writes them', () => {
    expect(tallyPaise('-1,180.00')).toBe(-R(1180));
    expect(tallyPaise('1180')).toBe(R(1180));
    expect(tallyPaise('')).toBeNull();
    expect(tallyPaise('abc')).toBeNull();
    expect(tallyQuantity('10 Nos')).toEqual({ qtyMicros: 10_000_000n, unit: 'Nos' });
    expect(tallyQuantity(' 2.500 kg = 2500 gm')).toEqual({ qtyMicros: 2_500_000n, unit: 'kg' });
    expect(tallyRate('100.00/Nos')).toEqual({ ratePaise: R(100), unit: 'Nos' });
    expect(tallyIsoDate('20250412')).toBe('2025-04-12');
    expect(tallyIsoDate('12-04-2025')).toBe('');
  });

  it('snaps a worked-out rate to a standard one, and leaves an odd one alone', () => {
    expect(snapRate(1799)).toBe(1800);
    expect(snapRate(501)).toBe(500);
    expect(snapRate(1400)).toBe(1400);
  });
});

const doc = (o: Partial<TallyDocument> = {}): TallyDocument => ({
  type: 'tax_invoice',
  number: 'INV/25-26/0001',
  date: '2025-04-12',
  partyName: 'Sharma & Sons',
  partyGstin: '27AAPFU0939F1ZV',
  placeOfSupply: 'Maharashtra',
  reference: '',
  narration: '',
  reverseCharge: false,
  lines: [
    {
      description: 'Cement bag',
      itemName: 'Cement bag',
      hsn: '2523',
      qtyMicros: 10_000_000n,
      unit: 'Bag',
      ratePaise: R(350),
      discountPaise: 0n,
      taxablePaise: R(3500),
      gstRateBp: 1800,
    },
  ],
  taxablePaise: R(3500),
  cgstPaise: R(315),
  sgstPaise: R(315),
  utgstPaise: 0n,
  igstPaise: 0n,
  cessPaise: 0n,
  tcsPaise: 0n,
  roundOffPaise: 0n,
  totalPaise: R(4130),
  ...o,
});

const input = (
  documents: TallyDocument[],
  payments: TallyExportInput['payments'] = [],
): TallyExportInput => ({
  companyName: 'Demo Traders',
  parties: [
    {
      name: 'Sharma & Sons',
      type: 'customer',
      gstin: '27AAPFU0939F1ZV',
      pan: 'AAPFU0939F',
      stateCode: '27',
      addressLines: ['12 MG Road', 'Pune'],
      pincode: '411001',
      country: 'India',
      registration: 'Regular',
    },
    {
      name: 'Kumar Cements',
      type: 'supplier',
      gstin: '',
      pan: '',
      stateCode: '29',
      addressLines: [],
      pincode: '',
      country: 'India',
      registration: 'Unregistered',
    },
  ],
  items: [{ name: 'Cement bag', hsn: '2523', unit: 'Bag', gstRateBp: 1800, description: '' }],
  documents,
  payments,
});

describe('tally export', () => {
  it('writes the masters: units, GST ledgers, party ledgers and stock items', () => {
    const r = buildTallyMasters(input([doc()]));
    expect(r.xml).toContain('<REPORTNAME>All Masters</REPORTNAME>');
    expect(r.xml).toContain('<SVCURRENTCOMPANY>Demo Traders</SVCURRENTCOMPANY>');
    expect(r.xml).toContain('<LEDGER NAME="Sharma &amp; Sons" ACTION="Create">');
    expect(r.xml).toContain('<PARENT>Sundry Debtors</PARENT>');
    expect(r.xml).toContain('<PARENT>Sundry Creditors</PARENT>');
    expect(r.xml).toContain('<PARTYGSTIN>27AAPFU0939F1ZV</PARTYGSTIN>');
    expect(r.xml).toContain('<LEDSTATENAME>Maharashtra</LEDSTATENAME>');
    expect(r.xml).toContain('<GSTREGISTRATIONTYPE>Unregistered</GSTREGISTRATIONTYPE>');
    expect(r.xml).toContain('<STOCKITEM NAME="Cement bag" ACTION="Create">');
    expect(r.xml).toContain('<HSNCODE>2523</HSNCODE>');
    expect(r.xml).toContain('<GSTRATEDUTYHEAD>Integrated Tax</GSTRATEDUTYHEAD>');
    expect(r.counts).toMatchObject({ stockItems: 1, units: 1 });
  });

  it('writes a sales voucher that balances: the party debited, sales and taxes credited', () => {
    const r = buildTallyVouchers(input([doc()]));
    expect(r.warnings).toEqual([]);
    expect(r.xml).toContain(
      '<VOUCHER VCHTYPE="Sales" ACTION="Create" OBJVIEW="Invoice Voucher View">',
    );
    expect(r.xml).toContain('<DATE>20250412</DATE>');
    expect(r.xml).toContain('<AMOUNT>-4130.00</AMOUNT>'); // the party, a debit
    expect(r.xml).toContain('<AMOUNT>3500.00</AMOUNT>'); // sales
    expect(r.xml).toContain('<LEDGERNAME>Output CGST</LEDGERNAME>');
    const amounts = [
      ...r.xml.matchAll(/<ALLLEDGERENTRIES\.LIST>.*?<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g),
    ].map((m) => Number(m[1]));
    // party, CGST and SGST are ledger entries; sales is on the inventory line
    expect(amounts.reduce((a, b) => a + b, 0) + 3500).toBeCloseTo(0, 5);
  });

  it('mirrors a purchase and a credit note, and puts the round-off in the voucher', () => {
    const purchase = doc({
      type: 'purchase_bill',
      number: 'PB/1',
      partyName: 'Kumar Cements',
      roundOffPaise: R(0.4),
      totalPaise: R(4130.4),
    });
    const credit = doc({ type: 'credit_note', number: 'CN/1' });
    const r = buildTallyVouchers(input([purchase, credit]));
    expect(r.warnings).toEqual([]);
    expect(r.xml).toContain('VCHTYPE="Purchase"');
    expect(r.xml).toContain('VCHTYPE="Credit Note"');
    expect(r.xml).toContain('<LEDGERNAME>Input CGST</LEDGERNAME>');
    expect(r.xml).toContain('<LEDGERNAME>Round Off</LEDGERNAME>');
  });

  it('writes receipts and payments through the bank or cash ledger', () => {
    const r = buildTallyVouchers(
      input(
        [],
        [
          {
            direction: 'received',
            date: '2025-04-20',
            partyName: 'Sharma & Sons',
            amountPaise: R(1000),
            mode: 'UPI',
            voucherNumber: 'RV/1',
            reference: 'UPI 123',
          },
          {
            direction: 'made',
            date: '2025-04-21',
            partyName: 'Kumar Cements',
            amountPaise: R(500),
            mode: 'Cash',
            voucherNumber: '',
            reference: '',
          },
        ],
      ),
    );
    expect(r.xml).toContain('VCHTYPE="Receipt"');
    expect(r.xml).toContain('VCHTYPE="Payment"');
    expect(r.xml).toContain(`<LEDGERNAME>${DEFAULT_TALLY_NAMES.cash}</LEDGERNAME>`);
    expect(r.xml).toContain(`<LEDGERNAME>${DEFAULT_TALLY_NAMES.bank}</LEDGERNAME>`);
  });

  it('leaves out a document with no party and says so, and warns about one that does not add up', () => {
    const r = buildTallyVouchers(
      input([doc({ partyName: '' }), doc({ number: 'X', totalPaise: R(9999) })]),
    );
    expect(r.warnings.join(' ')).toMatch(/no party/);
    expect(r.warnings.join(' ')).toMatch(/X: the lines and the total differ/);
  });
});

describe('tally import', () => {
  it('reads the masters and vouchers this software writes, and gets the same documents back', () => {
    const docs = [
      doc(),
      doc({ type: 'purchase_bill', number: 'PB/1', partyName: 'Kumar Cements', partyGstin: '' }),
      doc({ type: 'credit_note', number: 'CN/1' }),
    ];
    const masters = buildTallyMasters(input(docs)).xml;
    const vouchers = buildTallyVouchers(
      input(docs, [
        {
          direction: 'received',
          date: '2025-04-20',
          partyName: 'Sharma & Sons',
          amountPaise: R(1000),
          mode: 'Bank',
          voucherNumber: 'RV/1',
          reference: 'ref',
        },
      ]),
    ).xml;
    const b = readTally(masters + vouchers);
    expect(b.issues.filter((i) => i.severity === 'error')).toEqual([]);

    expect(b.parties.map((p) => p.name).sort()).toEqual(['Kumar Cements', 'Sharma & Sons']);
    const sharma = b.parties.find((p) => p.name === 'Sharma & Sons')!;
    expect(sharma).toMatchObject({
      type: 'customer',
      gstin: '27AAPFU0939F1ZV',
      stateCode: '27',
      pincode: '411001',
      pan: 'AAPFU0939F',
    });
    expect(b.items[0]).toMatchObject({
      name: 'Cement bag',
      hsn: '2523',
      gstRateBp: 1800,
      unit: 'Bag',
    });

    expect(b.documents.map((d) => [d.type, d.number])).toEqual([
      ['tax_invoice', 'INV/25-26/0001'],
      ['purchase_bill', 'PB/1'],
      ['credit_note', 'CN/1'],
    ]);
    const inv = b.documents[0]!;
    expect(inv).toMatchObject({
      date: '2025-04-12',
      partyName: 'Sharma & Sons',
      placeOfSupply: '27',
      fileTotalPaise: R(4130),
      fileTaxPaise: R(630),
    });
    expect(inv.lines).toHaveLength(1);
    expect(inv.lines[0]).toMatchObject({
      itemName: 'Cement bag',
      qtyMicros: 10_000_000n,
      ratePaise: R(350),
      taxablePaise: R(3500),
      gstRateBp: 1800,
      unit: 'Bag',
    });

    expect(b.payments).toEqual([
      expect.objectContaining({
        direction: 'received',
        partyName: 'Sharma & Sons',
        amountPaise: R(1000),
        account: 'Bank Account',
      }),
    ]);
  });

  const real = (body: string) =>
    `<?xml version="1.0" encoding="UTF-16"?><ENVELOPE><BODY><IMPORTDATA><REQUESTDATA>${body}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;

  it('reads a voucher with no stock items from its ledger lines, and a party with no ledger master', () => {
    const b = readTally(
      real(`<TALLYMESSAGE><VOUCHER VCHTYPE="Sales"><DATE>20250501</DATE><VOUCHERNUMBER>S-9</VOUCHERNUMBER><PARTYLEDGERNAME>Walk&#4;in</PARTYLEDGERNAME>
        <LEDGERENTRIES.LIST><LEDGERNAME>Walk&#4;in</LEDGERNAME><AMOUNT>-1180.00</AMOUNT></LEDGERENTRIES.LIST>
        <LEDGERENTRIES.LIST><LEDGERNAME>Consulting Income</LEDGERNAME><AMOUNT>1000.00</AMOUNT></LEDGERENTRIES.LIST>
        <LEDGERENTRIES.LIST><LEDGERNAME>CGST 9%</LEDGERNAME><AMOUNT>90.00</AMOUNT></LEDGERENTRIES.LIST>
        <LEDGERENTRIES.LIST><LEDGERNAME>SGST 9%</LEDGERNAME><AMOUNT>90.00</AMOUNT></LEDGERENTRIES.LIST>
      </VOUCHER></TALLYMESSAGE>`),
    );
    expect(b.documents).toHaveLength(1);
    const d = b.documents[0]!;
    expect(d.partyName).toBe('Walkin');
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0]).toMatchObject({
      description: 'Consulting Income',
      taxablePaise: R(1000),
      gstRateBp: 1800,
      itemName: null,
    });
    expect(d.fileTotalPaise).toBe(R(1180));
    expect(b.parties.map((p) => p.name)).toEqual(['Walkin']);
    expect(b.issues.some((i) => /no ledger master/.test(i.message))).toBe(true);
  });

  it('works out the side of a debit note from the ledger group, and skips what it should', () => {
    const b = readTally(
      real(`<TALLYMESSAGE><GROUP NAME="Purchase Accounts"><PARENT>Primary</PARENT></GROUP><GROUP NAME="Sundry Creditors"><PARENT>Primary</PARENT></GROUP>
        <LEDGER NAME="Goods Bought"><PARENT>Purchase Accounts</PARENT></LEDGER><LEDGER NAME="Kumar" ><PARENT>Sundry Creditors</PARENT><OPENINGBALANCE>2500.00</OPENINGBALANCE></LEDGER></TALLYMESSAGE>
        <TALLYMESSAGE><VOUCHER VCHTYPE="Debit Note"><DATE>20250601</DATE><VOUCHERNUMBER>DN-1</VOUCHERNUMBER><PARTYLEDGERNAME>Kumar</PARTYLEDGERNAME>
          <LEDGERENTRIES.LIST><LEDGERNAME>Kumar</LEDGERNAME><AMOUNT>-500.00</AMOUNT></LEDGERENTRIES.LIST>
          <LEDGERENTRIES.LIST><LEDGERNAME>Goods Bought</LEDGERNAME><AMOUNT>500.00</AMOUNT></LEDGERENTRIES.LIST></VOUCHER></TALLYMESSAGE>
        <TALLYMESSAGE><VOUCHER VCHTYPE="Journal"><DATE>20250602</DATE><VOUCHERNUMBER>J-1</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE>
        <TALLYMESSAGE><VOUCHER VCHTYPE="Sales"><DATE>20250603</DATE><VOUCHERNUMBER>S-1</VOUCHERNUMBER><ISCANCELLED>Yes</ISCANCELLED></VOUCHER></TALLYMESSAGE>`),
    );
    expect(b.documents.map((d) => d.type)).toEqual(['purchase_return']);
    // Kumar owes nobody the other way: a credit opening balance means we owe them
    expect(b.parties[0]).toMatchObject({
      name: 'Kumar',
      type: 'supplier',
      openingBalancePaise: -R(2500),
    });
    expect(b.issues.map((i) => i.message).join('|')).toMatch(/Journal vouchers are not imported/);
    expect(b.issues.map((i) => i.message).join('|')).toMatch(/cancelled voucher/);
  });

  it('refuses a voucher with no number or no date, naming it', () => {
    const b = readTally(
      real(
        '<TALLYMESSAGE><VOUCHER VCHTYPE="Sales"><DATE>20250501</DATE><PARTYLEDGERNAME>A</PARTYLEDGERNAME></VOUCHER><VOUCHER VCHTYPE="Sales"><VOUCHERNUMBER>N</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE>',
      ),
    );
    expect(b.documents).toEqual([]);
    expect(b.issues.filter((i) => i.severity === 'error').map((i) => i.message)).toEqual([
      'no voucher number, not imported',
      'no date, not imported',
    ]);
  });

  it('reads in pieces the same as whole', () => {
    const xml = buildTallyMasters(input([doc()])).xml + buildTallyVouchers(input([doc()])).xml;
    const r = new TallyReader();
    for (let i = 0; i < xml.length; i += 37) r.feed(xml.slice(i, i + 37));
    const b = r.finish();
    expect(b.documents).toHaveLength(1);
    expect(b.parties).toHaveLength(2);
  });
});

describe('spreadsheet documents', () => {
  const headers = [
    'Invoice No',
    'Date',
    'Type',
    'Party Name',
    'GSTIN',
    'Place of Supply',
    'Item',
    'HSN',
    'Qty',
    'Unit',
    'Rate',
    'Discount %',
    'GST %',
  ];
  const row = (...c: string[]) => c;

  it('guesses the columns from Vyapar-style and plain headings', () => {
    const m = detectDocumentMapping([
      'Invoice No.',
      'Date',
      'Party Name',
      'Item Name',
      'HSN/SAC',
      'Quantity',
      'Price/Unit',
      'Tax %',
    ]);
    expect(m['number']).toBe(0);
    expect(m['party']).toBe(2);
    expect(m['item']).toBe(3);
    expect(m['hsn']).toBe(4);
    expect(m['qty']).toBe(5);
    expect(m['rate']).toBe(6);
    expect(m['gstRate']).toBe(7);
  });

  it('groups lines into documents and reads types, dates, discounts and states', () => {
    const rows = [
      row(
        'INV-1',
        '10-04-2025',
        'Sale',
        'Sharma',
        '27AAPFU0939F1ZV',
        'Maharashtra',
        'Cement',
        '2523',
        '10',
        'Bag',
        '350',
        '10',
        '18',
      ),
      row(
        'INV-1',
        '10-04-2025',
        'Sale',
        'Sharma',
        '27AAPFU0939F1ZV',
        'Maharashtra',
        'Delivery',
        '9965',
        '1',
        'Nos',
        '500',
        '',
        '18%',
      ),
      row(
        'PB-7',
        '45758',
        'Purchase',
        'Kumar',
        '',
        'Karnataka (29)',
        'Cement',
        '2523',
        '100',
        'Bag',
        '300',
        '',
        '18',
      ),
      row(
        'RET-1',
        '2025-04-15',
        'Sale Return',
        'Sharma',
        '',
        '27',
        'Cement',
        '',
        '1',
        '',
        '350',
        '',
        '18',
      ),
    ];
    const { documents, issues } = documentsFromRows({
      source: 'excel',
      headers,
      rows,
      lines: [2, 3, 4, 5],
      mapping: detectDocumentMapping(headers),
      defaultType: 'tax_invoice',
    });
    expect(issues).toEqual([]);
    expect(documents.map((d) => [d.type, d.number, d.lines.length])).toEqual([
      ['tax_invoice', 'INV-1', 2],
      ['purchase_bill', 'PB-7', 1],
      ['credit_note', 'RET-1', 1],
    ]);
    const inv = documents[0]!;
    expect(inv.date).toBe('2025-04-10');
    expect(inv.placeOfSupply).toBe('27');
    // 10 bags at 350 less 10%: discount 350
    expect(inv.lines[0]).toMatchObject({
      qtyMicros: 10_000_000n,
      ratePaise: R(350),
      discountPaise: R(350),
      gstRateBp: 1800,
      hsn: '2523',
    });
    expect(inv.lines[1]!.gstRateBp).toBe(1800);
    expect(documents[1]!.date).toBe('2025-04-11'); // an Excel serial number: 45658 is 1 January 2025
    expect(documents[1]!.placeOfSupply).toBe('29');
  });

  it('says what is wrong with a row, by line, and keeps the good ones', () => {
    const rows = [
      row('A-1', '10-04-2025', '', 'P', '', '', 'Item', '', 'ten', '', '100', '', '18'),
      row('', '10-04-2025', '', 'P', '', '', 'Item', '', '1', '', '100', '', '18'),
      row('A-3', '31-02-2025', '', 'P', '', '', 'Item', '', '1', '', '100', '', '18'),
      row('A-4', '10-04-2025', '', 'P', '', '', 'Item', '', '1', '', 'abc', '', '18'),
      row('A-5', '10-04-2025', 'strange', 'P', '', '', 'Item', '', '1', '', '100', '200', '18'),
      row('A-6', '10-04-2025', '', 'P', '', '', 'Item', '', '1', '', '100', '', '18'),
    ];
    const { documents, issues } = documentsFromRows({
      source: 'excel',
      headers,
      rows,
      lines: [2, 3, 4, 5, 6, 7],
      mapping: detectDocumentMapping(headers),
      defaultType: 'tax_invoice',
    });
    expect(documents.map((d) => d.number)).toEqual(['A-6']);
    expect(issues.map((i) => `${i.ref}: ${i.message}`)).toEqual(
      [
        'line 2: "ten" is not a quantity',
        'line 3: no invoice number',
        'line 4: "31-02-2025" is not a date',
        'line 5: "abc" is not an amount',
        'line 6: the discount is more than the line value',
        'line 6: "strange" is not a known type; taken as tax_invoice',
      ]
        .sort((a, b) => a.localeCompare(b))
        .sort((a, b) => Number(a.slice(5, 6)) - Number(b.slice(5, 6))),
    );
  });

  it('derives the rate from a taxable amount and a quantity when there is no rate column', () => {
    const h = ['Invoice No', 'Date', 'Party', 'Item', 'Qty', 'Taxable Amount'];
    const { documents } = documentsFromRows({
      source: 'excel',
      headers: h,
      rows: [['X1', '2025-05-01', 'P', 'Thing', '4', '1000']],
      lines: [2],
      mapping: detectDocumentMapping(h),
      defaultType: 'tax_invoice',
    });
    expect(documents[0]!.lines[0]).toMatchObject({ ratePaise: R(250), taxablePaise: R(1000) });
  });

  it('joins a header sheet and a lines sheet, and reports a line with no invoice', () => {
    const j = joinSheets(
      {
        headers: ['Invoice No', 'Date', 'Party Name'],
        rows: [
          ['A', '2025-04-01', 'P1'],
          ['B', '2025-04-02', 'P2'],
        ],
      },
      {
        headers: ['Invoice No', 'Item', 'Qty', 'Rate'],
        rows: [
          ['A', 'x', '1', '10'],
          ['B', 'y', '2', '20'],
          ['Z', 'q', '1', '1'],
        ],
      },
      0,
      0,
    );
    expect(j.headers).toEqual(['Invoice No', 'Item', 'Qty', 'Rate', 'Date', 'Party Name']);
    expect(j.rows).toEqual([
      ['A', 'x', '1', '10', '2025-04-01', 'P1'],
      ['B', 'y', '2', '20', '2025-04-02', 'P2'],
    ]);
    expect(j.issues).toHaveLength(1);
    expect(j.issues[0]!.message).toMatch(/no invoice Z/);
  });

  it('knows the words for document types and the dates a sheet holds', () => {
    expect(documentTypeFromText('Sale Invoice')).toBe('tax_invoice');
    expect(documentTypeFromText('Purchase')).toBe('purchase_bill');
    expect(documentTypeFromText('Purchase Return')).toBe('purchase_return');
    expect(documentTypeFromText('Debit Note')).toBe('debit_note');
    expect(documentTypeFromText('Estimate')).toBe('quotation');
    expect(documentTypeFromText('Sale Order')).toBeNull();
    expect(sheetDate('5/4/25')).toBe('2025-04-05');
    expect(sheetDate('2025-13-01')).toBe('');
  });

  it('the downloadable template reads back without a problem', () => {
    const [head, ...rest] = DOCUMENT_TEMPLATE.trim()
      .split('\n')
      .map((l) => l.split(','));
    const { documents, issues } = documentsFromRows({
      source: 'excel',
      headers: head!,
      rows: rest,
      lines: rest.map((_, i) => i + 2),
      mapping: detectDocumentMapping(head!),
      defaultType: 'tax_invoice',
    });
    expect(issues).toEqual([]);
    expect(documents.map((d) => d.number)).toEqual(['INV-001', 'PB-007']);
  });
});

describe('parties, items and sheet kinds', () => {
  it('reads parties with a state name, a bad GSTIN, an opening balance and a phone with a country code', () => {
    const headers = ['Party Name', 'GSTIN', 'Phone No', 'State', 'City', 'Balance', 'Type'];
    const rows = [
      [
        'Sharma Traders',
        '27AAPFU0939F1ZV',
        '+91 98765 43210',
        'Maharashtra',
        'Pune',
        '1,500.50',
        'Customer',
      ],
      ['Kumar Cements', '27BADGSTIN', '09876543210', 'Karnataka', '', 'abc', 'Supplier'],
      ['', '', '', '', '', '', ''],
      ['', '29AABCU9603R1ZJ', '', '', '', '', ''],
    ];
    const { parties, issues } = partiesFromRows({
      rows,
      lines: [2, 3, 4, 5],
      mapping: detectPartyMapping(headers),
    });
    expect(parties.map((p) => p.name)).toEqual(['Sharma Traders', 'Kumar Cements']);
    expect(parties[0]).toMatchObject({
      stateCode: '27',
      phone: '9876543210',
      openingBalancePaise: R(1500.5),
      pan: 'AAPFU0939F',
      type: 'customer',
    });
    expect(parties[1]).toMatchObject({
      gstin: '',
      stateCode: '29',
      type: 'supplier',
      openingBalancePaise: 0n,
    });
    expect(issues.map((i) => i.message)).toEqual([
      'Kumar Cements: "27BADGSTIN" is not a GSTIN; it is left out',
      'Kumar Cements: "abc" is not an amount; the opening balance is left out',
      'no party name',
    ]);
  });

  it('reads items with prices, rates and a service marked by its code', () => {
    const headers = ['Item Name', 'HSN/SAC', 'Unit', 'Selling Price', 'Purchase Price', 'GST %'];
    const { items, issues } = itemsFromRows({
      rows: [
        ['Cement', '2523', 'Bag', '350', '300', '18'],
        ['Consulting', '998313', '', '1000', '', '18%'],
        ['Bad', '', '', 'x', '', 'y'],
      ],
      lines: [2, 3, 4],
      mapping: detectItemMapping(headers),
    });
    expect(items[0]).toMatchObject({
      name: 'Cement',
      sellPaise: R(350),
      buyPaise: R(300),
      gstRateBp: 1800,
      kind: 'goods',
    });
    expect(items[1]!.kind).toBe('service');
    expect(items[2]).toMatchObject({ sellPaise: 0n, gstRateBp: null });
    expect(issues).toHaveLength(2);
  });

  it('guesses what a sheet holds from its headings', () => {
    expect(classifySheet(['Invoice No', 'Date', 'Party Name', 'Item', 'Qty', 'Rate']).kind).toBe(
      'documents',
    );
    expect(classifySheet(['Party Name', 'GSTIN', 'Phone', 'City', 'State']).kind).toBe('parties');
    expect(classifySheet(['Item Name', 'HSN', 'Unit', 'Price', 'GST']).kind).toBe('items');
    expect(classifySheet(['Foo', 'Bar']).kind).toBe('unknown');
  });
});

describe('the Vyapar sample files (synthetic)', () => {
  const read = (name: string) => {
    const p = parseCsv(
      readFileSync(join(import.meta.dirname, '..', '..', '..', 'fixtures', 'vyapar', name), 'utf8'),
    );
    return { headers: p.rows[0]!, rows: p.rows.slice(1), lines: p.lines.slice(1) };
  };

  it('reads the parties, the items, the sales and the purchases without a problem', () => {
    const parties = read('parties.csv');
    const pr = partiesFromRows({
      rows: parties.rows,
      lines: parties.lines,
      mapping: detectPartyMapping(parties.headers),
    });
    expect(pr.issues).toEqual([]);
    expect(pr.parties.map((p) => [p.name, p.type, p.openingBalancePaise])).toEqual([
      ['Sample Traders', 'customer', R(1500)],
      ['Demo Hardware', 'supplier', -R(2500)],
      ['Test Stores', 'customer', 0n],
    ]);

    const items = read('items.csv');
    const ir = itemsFromRows({
      rows: items.rows,
      lines: items.lines,
      mapping: detectItemMapping(items.headers),
    });
    expect(ir.issues).toEqual([]);
    expect(ir.items.map((i) => [i.name, i.hsn, i.gstRateBp, i.kind])).toEqual([
      ['Sample Cement', '2523', 1800, 'goods'],
      ['Sample Rod', '7214', 1800, 'goods'],
      ['Sample Service', '998313', 1800, 'service'],
    ]);

    for (const [file, type, numbers] of [
      ['sales-items.csv', 'tax_invoice', ['1001', '1002']],
      ['purchases-items.csv', 'purchase_bill', ['B-501']],
    ] as const) {
      const s = read(file);
      const r = documentsFromRows({
        source: 'vyapar',
        headers: s.headers,
        rows: s.rows,
        lines: s.lines,
        mapping: detectDocumentMapping(s.headers),
        defaultType: type,
      });
      expect(r.issues, file).toEqual([]);
      expect(r.documents.map((d) => d.number)).toEqual([...numbers]);
    }
    const sales = read('sales-items.csv');
    const first = documentsFromRows({
      source: 'vyapar',
      headers: sales.headers,
      rows: sales.rows,
      lines: sales.lines,
      mapping: detectDocumentMapping(sales.headers),
      defaultType: 'tax_invoice',
    }).documents[0]!;
    expect(first.date).toBe('2025-04-10');
    expect(first.lines).toHaveLength(2);
    // 10 bags at 350 less 5%
    expect(first.lines[0]).toMatchObject({ discountPaise: R(175), gstRateBp: 1800 });
  });
});
