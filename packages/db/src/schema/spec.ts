import { c, type TableSpec } from './dialect';

export const DOCUMENT_TYPES = [
  'tax_invoice',
  'bill_of_supply',
  'proforma',
  'quotation',
  'credit_note',
  'debit_note',
  'delivery_challan',
  'receipt_voucher',
  'purchase_bill',
  'purchase_return',
  'expense',
  'rcm_self_invoice',
] as const;
export const DOCUMENT_STATUSES = ['draft', 'issued', 'cancelled'] as const;
export const SUPPLY_TYPES = ['intra', 'inter', 'export', 'sez'] as const;

const money = () => c.big().nn.default(0);
const bp = () => c.int().nn.default(0);

/** Single source of truth for the schema; compiled for SQLite and Postgres. */
export const SPEC: TableSpec[] = [
  {
    name: 'organisations',
    kind: 'plain',
    cols: { name: c.text().nn, plan: c.text().nn.default('free') },
  },
  {
    name: 'users',
    kind: 'plain',
    cols: {
      email: c.text().nn.unique,
      name: c.text().nn,
      phone: c.text(),
      locale: c.text().nn.default('en'),
    },
  },
  {
    name: 'businesses',
    kind: 'org',
    cols: {
      gstin: c.text(),
      legal_name: c.text().nn,
      trade_name: c.text(),
      address: c.json(),
      state_code: c.text().nn,
      pan: c.text(),
      scheme: c.text().nn.default('regular').oneOf(['regular', 'composition']),
      fy_start_month: c.int().nn.default(4),
      preset: c.text(),
      settings_json: c.json(),
    },
    indexes: [{ cols: ['gstin'] }],
  },
  {
    name: 'memberships',
    kind: 'org',
    cols: {
      user_id: c.uuid().nn.ref('users'),
      business_id: c.uuid().ref('businesses'),
      role: c.text().nn.oneOf(['owner', 'admin', 'accountant', 'staff', 'ca', 'viewer']),
    },
    indexes: [{ cols: ['user_id'] }],
  },
  {
    name: 'devices',
    kind: 'tenant',
    cols: {
      name: c.text().nn,
      platform: c.text(),
      last_seen_at: c.ts(),
      /** `sync` is a device of a synced business (numbering ranges); `lan` is a tablet paired to this computer. */
      kind: c.text().nn.default('sync').oneOf(['sync', 'lan']),
      /** What a paired device may do: `full`, `counter` or `view`. */
      role: c.text().oneOf(['full', 'counter', 'view']),
      /** SHA-256 of the device's token. The token itself is never stored. */
      token_hash: c.text(),
      token_issued_at: c.ts(),
      /** The token before the last rotation, accepted for a short grace. */
      prev_token_hash: c.text(),
      prev_valid_until: c.ts(),
      revoked_at: c.ts(),
    },
    indexes: [{ cols: ['token_hash'] }],
  },
  {
    name: 'business_accounts',
    kind: 'tenant',
    cols: {
      kind: c.text().nn.oneOf(['bank', 'upi', 'cash', 'wallet']),
      name: c.text().nn,
      holder_name: c.text(),
      account_no: c.text(),
      ifsc: c.text(),
      /** savings, current, ... for a bank account. */
      account_type: c.text(),
      upi_id: c.text(),
      is_default: c.bool().nn.default(false),
      /** Printed on documents and receipts. */
      show_on_documents: c.bool().nn.default(true),
    },
  },
  {
    name: 'units',
    kind: 'tenant',
    cols: {
      code: c.text().nn,
      name: c.text().nn,
      is_custom: c.bool().nn.default(false),
      /** The GST UQC this unit reports as in returns (a standard unit reports itself). */
      uqc: c.text(),
    },
    indexes: [{ cols: ['business_id', 'code'], unique: true, where: 'deleted_at IS NULL' }],
  },
  {
    name: 'parties',
    kind: 'tenant',
    cols: {
      type: c.text().nn.oneOf(['customer', 'supplier', 'both']),
      name: c.text().nn,
      /** What the name sounds like in Roman letters, kept when the name is typed in a native script, so search works either way. */
      name_latin: c.text(),
      /** The language this party's documents and reminders are in; empty means the business default. */
      language: c.text().oneOf(['en', 'hi', 'ta', 'bn', 'gu', 'mr']),
      trade_name: c.text(),
      gstin: c.text(),
      pan: c.text(),
      phone: c.text(),
      email: c.text(),
      state_code: c.text(),
      addresses_json: c.json(),
      contacts_json: c.json(),
      credit_days: c.int().nn.default(0),
      /** Positive = the party owes us at `opening_balance_date`; negative = we owe the party. */
      opening_balance_paise: money(),
      opening_balance_date: c.date(),
      credit_limit_paise: money(),
      city: c.text(),
      country: c.text().nn.default('India'),
      notes: c.text(),
      tags_json: c.json(),
      is_sez: c.bool().nn.default(false),
      is_export: c.bool().nn.default(false),
      is_unregistered: c.bool().nn.default(false),
      is_composition: c.bool().nn.default(false),
      /** Who the party is for TDS returns: a company (code 01) or anyone else (code 02). */
      deductee_type: c.text().oneOf(['company', 'non_company']),
      /** The TDS section to deduct under when we pay this party (`194C`, `194J`, ...); empty means none. */
      tds_section: c.text(),
      /** 194C rate group: individual or HUF (1%) or anyone else (2%). */
      tds_category: c.text().oneOf(['individual_huf', 'other']),
      /** 194J rate: professional (10%) or technical service (2%). */
      tds_kind: c.text().oneOf(['professional', 'technical']),
      /** What we collect TCS on when we sell to this party (`scrap`, `motor_vehicle`, ...); empty means none. */
      tcs_nature: c.text(),
      /** A lower or nil deduction certificate (section 197) the party gave us. */
      lower_cert_no: c.text(),
      lower_cert_rate_bp: c.int(),
      lower_cert_from: c.date(),
      lower_cert_to: c.date(),
      lower_cert_limit_paise: c.big(),
    },
    indexes: [{ cols: ['business_id', 'gstin'] }, { cols: ['business_id', 'name'] }],
  },
  {
    name: 'items',
    kind: 'tenant',
    cols: {
      kind: c.text().nn.default('goods').oneOf(['goods', 'service']),
      name: c.text().nn,
      /** The Roman-letter form of the name when it is typed in a native script (for search). */
      name_latin: c.text(),
      description: c.text(),
      sku: c.text(),
      barcode: c.text(),
      hsn: c.text(),
      unit_id: c.uuid().ref('units'),
      /** Optional second unit; `secondary_factor_micros` primary units make one secondary unit. */
      secondary_unit_id: c.uuid().ref('units'),
      secondary_factor_micros: c.big(),
      sale_rate_paise: money(),
      purchase_rate_paise: money(),
      mrp_paise: c.big(),
      /** True when `sale_rate_paise` already includes GST. */
      tax_inclusive: c.bool().nn.default(false),
      gst_rate_bp: bp(),
      cess_bp: bp(),
      /** True when the rate differs from what the HSN master gives for `hsn`. Set by the repository. */
      gst_rate_overridden: c.bool().nn.default(false),
      track_stock: c.bool().nn.default(false),
      /** Reorder level. */
      min_stock_micros: money(),
      opening_stock_micros: money(),
      opening_stock_value_paise: money(),
      /** Small references to image bytes held in the blob store: `{ sha256, mime, storagePath, name }`. */
      images_json: c.json(),
      tags_json: c.json(),
      is_active: c.bool().nn.default(true),
    },
    indexes: [
      {
        cols: ['business_id', 'sku'],
        unique: true,
        where: 'deleted_at IS NULL AND sku IS NOT NULL',
      },
      {
        cols: ['business_id', 'barcode'],
        unique: true,
        where: 'deleted_at IS NULL AND barcode IS NOT NULL',
      },
      { cols: ['business_id', 'hsn'] },
    ],
  },
  {
    name: 'item_variants',
    kind: 'tenant',
    cols: {
      item_id: c.uuid().nn.ref('items'),
      name: c.text().nn,
      sku: c.text(),
      barcode: c.text(),
      sale_rate_paise: c.big(),
      attrs_json: c.json(),
    },
    indexes: [{ cols: ['item_id'] }],
  },
  {
    name: 'hsn_master',
    kind: 'plain',
    cols: {
      code: c.text().nn,
      description: c.text().nn,
      rate_bp: bp(),
      cess_bp: bp(),
      effective_from: c.date().nn,
      effective_to: c.date(),
      source_version: c.text(),
    },
    indexes: [{ cols: ['code', 'effective_from'], unique: true }],
  },
  {
    name: 'rate_master_versions',
    kind: 'plain',
    cols: {
      version: c.text().nn.unique,
      effective_from: c.date().nn,
      source: c.text(),
      notes: c.text(),
      published_at: c.ts(),
      /** Date the rates were checked against. */
      as_of: c.date(),
      row_count: c.int(),
      sha256: c.text(),
      imported_at: c.ts(),
    },
  },
  {
    /** Vectors over hsn_master for semantic search (prompt 36). One row per code and embedding model. */
    name: 'hsn_embeddings',
    kind: 'plain',
    cols: {
      code: c.text().nn,
      model: c.text().nn,
      dims: c.int().nn,
      /** The vector as a JSON array of numbers. */
      vector_json: c.json().nn,
    },
    indexes: [{ cols: ['code', 'model'], unique: true }],
  },
  {
    name: 'number_series',
    kind: 'tenant',
    cols: {
      document_type: c.text().nn,
      /** Shown in settings and the series picker; counters of one series share `series_key`. */
      name: c.text(),
      /** One logical series has a counter row per financial year (or one row if it never resets). */
      series_key: c.text(),
      /** Used when the editor does not pick a series. */
      is_default: c.bool().nn.default(false),
      /** A series that Books or Shop uses by default for this type (overrides `is_default` there). */
      shell_default: c.text().oneOf(['books', 'shop']),
      /** First number after a start or reset. */
      start_number: c.int().nn.default(1),
      prefix: c.text().nn.default(''),
      suffix: c.text().nn.default(''),
      padding: c.int().nn.default(4),
      reset: c.text().nn.default('fy').oneOf(['fy', 'never']),
      fy: c.text(),
      next_number: c.int().nn.default(1),
      reserved_ranges_json: c.json(),
    },
    indexes: [{ cols: ['business_id', 'document_type', 'prefix', 'fy'] }],
  },
  {
    name: 'number_reservations',
    kind: 'tenant',
    cols: {
      series_id: c.uuid().nn.ref('number_series'),
      /** The syncing device (the cloud's `sync_devices`; `devices` is local-only and holds LAN tablets). */
      device_id: c.text(),
      from_number: c.int().nn,
      to_number: c.int().nn,
      /** Numbers consumed from the start of the range. */
      used: c.int().nn.default(0),
      status: c.text().nn.default('active').oneOf(['active', 'used', 'released']),
    },
    indexes: [{ cols: ['series_id'] }],
  },
  {
    name: 'documents',
    kind: 'tenant',
    cols: {
      type: c.text().nn.oneOf(DOCUMENT_TYPES),
      status: c.text().nn.default('draft').oneOf(DOCUMENT_STATUSES),
      number: c.text(),
      series_id: c.uuid().ref('number_series'),
      date: c.date().nn,
      due_date: c.date(),
      party_id: c.uuid().ref('parties'),
      party_name: c.text(),
      place_of_supply_state: c.text(),
      supply_type: c.text().nn.default('intra').oneOf(SUPPLY_TYPES),
      reverse_charge: c.bool().nn.default(false),
      currency: c.text().nn.default('INR'),
      fx_rate_micros: c.big().nn.default(1000000),
      total_taxable_paise: money(),
      total_cgst_paise: money(),
      total_sgst_paise: money(),
      total_igst_paise: money(),
      total_utgst_paise: money(),
      total_cess_paise: money(),
      tcs_paise: money(),
      tds_paise: money(),
      round_off_paise: money(),
      total_paise: money(),
      notes: c.text(),
      terms: c.text(),
      template_id: c.uuid().ref('templates'),
      irn: c.text(),
      irn_ack_no: c.text(),
      irn_ack_date: c.text(),
      irn_signed_qr: c.text(),
      eway_bill_no: c.text(),
      eway_valid_until: c.ts(),
      cancelled_at: c.ts(),
      cancel_reason: c.text(),
      /** Bumped by every financial edit after issue; 1 means as first issued. */
      revision: c.int().nn.default(1),
      source_document_id: c.uuid().ref('documents'),
      metadata_json: c.json(),
    },
    indexes: [
      {
        cols: ['business_id', 'type', 'number'],
        unique: true,
        where: "status <> 'draft' AND number IS NOT NULL",
      },
      { cols: ['business_id', 'type', 'date'] },
      { cols: ['party_id'] },
    ],
  },
  {
    name: 'document_lines',
    kind: 'tenant',
    cols: {
      document_id: c.uuid().nn.ref('documents'),
      line_no: c.int().nn,
      item_id: c.uuid().ref('items'),
      description: c.text(),
      hsn: c.text(),
      qty_micros: c.big().nn.default(1000000),
      unit_id: c.uuid().ref('units'),
      rate_paise: money(),
      discount_mode: c.text().nn.default('none').oneOf(['none', 'percent', 'amount', 'per_unit']),
      /** basis points when mode = percent, paise when mode = amount (whole line) or per_unit (each unit) */
      discount_value: money(),
      /** The item's nominal GST rate, kept so a draft reopens with it even when no tax is charged. */
      gst_rate_bp: bp(),
      /** True when `rate_paise` already includes GST. */
      price_includes_tax: c.bool().nn.default(false),
      taxability: c
        .text()
        .nn.default('taxable')
        .oneOf(['taxable', 'exempt', 'nil_rated', 'non_gst']),
      note: c.text(),
      taxable_paise: money(),
      cgst_bp: bp(),
      sgst_bp: bp(),
      igst_bp: bp(),
      utgst_bp: bp(),
      cess_bp: bp(),
      cgst_paise: money(),
      sgst_paise: money(),
      igst_paise: money(),
      utgst_paise: money(),
      cess_paise: money(),
      total_paise: money(),
      batch_id: c.uuid().ref('batches'),
      serials_json: c.json(),
    },
    indexes: [{ cols: ['document_id'] }, { cols: ['item_id'] }],
  },
  {
    name: 'payments',
    kind: 'tenant',
    cols: {
      date: c.date().nn,
      /** received = from a customer, made = to a supplier. */
      direction: c.text().nn.default('received').oneOf(['received', 'made']),
      mode: c.text().nn.oneOf(['cash', 'upi', 'card', 'bank', 'cheque', 'other', 'adjustment']),
      account_id: c.uuid().ref('business_accounts'),
      party_id: c.uuid().ref('parties'),
      /** Everything received or paid, including `tcs_paise`. */
      amount_paise: c.big().nn,
      /** Cheque number, UPI or bank reference. */
      reference: c.text(),
      cheque_date: c.date(),
      notes: c.text(),
      /** TCS u/s 206C(1H) collected with a receipt (part of the amount; not a settlement). */
      tcs_paise: c.big().nn.default(0),
      /** The receipt voucher document made for this payment. */
      voucher_id: c.uuid().ref('documents'),
      status: c.text().nn.default('cleared').oneOf(['pending', 'cleared', 'bounced', 'cancelled']),
    },
    indexes: [{ cols: ['party_id'] }],
  },
  {
    name: 'payment_allocations',
    kind: 'tenant',
    cols: {
      /** Empty for credit applied from a credit note (no money moved). */
      payment_id: c.uuid().ref('payments'),
      document_id: c.uuid().nn.ref('documents'),
      amount_paise: c.big().nn,
      /** `write_off` is a round-off difference closed on the document, not money. */
      kind: c
        .text()
        .nn.default('payment')
        .oneOf(['payment', 'credit_applied', 'write_off', 'refund']),
      source_document_id: c.uuid().ref('documents'),
    },
    indexes: [{ cols: ['payment_id'] }, { cols: ['document_id'] }],
  },
  {
    name: 'gst_filings',
    kind: 'tenant',
    cols: {
      return_type: c.text().nn.oneOf(['gstr1', 'gstr3b']),
      /** MMYYYY, the period key used in the GSTN files (the last month of a quarter). */
      period_fp: c.text().nn,
      period_from: c.date().nn,
      period_to: c.date().nn,
      status: c.text().nn.default('open').oneOf(['open', 'exported', 'pushed', 'filed']),
      exported_at: c.ts(),
      /** The file layout version the last export used (`data/gstn-schemas`). */
      schema_version: c.text(),
      /** Acknowledgement number the portal gave when the person filed. */
      arn: c.text(),
      filed_on: c.date(),
      /** A due date the person set (an extension the government notified). */
      due_override: c.date(),
      note: c.text(),
    },
    indexes: [
      {
        cols: ['business_id', 'return_type', 'period_fp'],
        unique: true,
        where: 'deleted_at IS NULL',
      },
    ],
  },
  {
    name: 'tax_challans',
    kind: 'tenant',
    cols: {
      kind: c.text().nn.oneOf(['tds', 'tcs']),
      /** `2025-26`. */
      fy: c.text().nn,
      /** `Q1` to `Q4`. */
      quarter: c.text().nn.oneOf(['Q1', 'Q2', 'Q3', 'Q4']),
      section: c.text(),
      /** The 7-digit code of the bank branch that took the deposit. */
      bsr_code: c.text().nn,
      deposit_date: c.date().nn,
      /** The challan serial number the bank gave. */
      serial: c.text().nn,
      tax_paise: money(),
      interest_paise: money(),
      fee_paise: money(),
      note: c.text(),
    },
    indexes: [{ cols: ['business_id', 'fy', 'quarter'] }],
  },
  {
    name: 'tax_deductions',
    kind: 'tenant',
    cols: {
      /** `tds` we deducted when paying; `tcs` we collected when selling. */
      kind: c.text().nn.oneOf(['tds', 'tcs']),
      party_id: c.uuid().nn.ref('parties'),
      document_id: c.uuid().ref('documents'),
      /** `194C`, `206C(1)`, ... */
      section: c.text().nn,
      /** For TCS, which goods (`scrap`, `motor_vehicle`, ...). */
      nature: c.text(),
      /** The date of payment or credit (TDS) or of collection (TCS). */
      date: c.date().nn,
      fy: c.text().nn,
      quarter: c.text().nn.oneOf(['Q1', 'Q2', 'Q3', 'Q4']),
      base_paise: money(),
      rate_bp: bp(),
      tax_paise: money(),
      no_pan: c.bool().nn.default(false),
      lower_cert: c.bool().nn.default(false),
      challan_id: c.uuid().ref('tax_challans'),
      note: c.text(),
    },
    indexes: [
      { cols: ['business_id', 'fy', 'quarter', 'kind'] },
      { cols: ['business_id', 'party_id', 'fy'] },
      { cols: ['document_id'] },
    ],
  },
  {
    name: 'tds_receivable',
    kind: 'tenant',
    cols: {
      party_id: c.uuid().nn.ref('parties'),
      fy: c.text().nn,
      quarter: c.text().nn.oneOf(['Q1', 'Q2', 'Q3', 'Q4']),
      section: c.text().nn,
      date: c.date().nn,
      /** What the customer paid or credited, before their deduction. */
      gross_paise: money(),
      /** What they deducted and owe the government on our behalf. */
      tds_paise: money(),
      certificate_no: c.text(),
      certificate_date: c.date(),
      status: c
        .text()
        .nn.default('expected')
        .oneOf(['expected', 'certificate_received', 'claimed']),
      note: c.text(),
    },
    indexes: [{ cols: ['business_id', 'fy', 'quarter'] }, { cols: ['business_id', 'party_id'] }],
  },
  {
    name: 'gst_adjustments',
    kind: 'tenant',
    cols: {
      period_fp: c.text().nn,
      /** `itc.availableOther`, `itc.reversedRules`, ... (see `ITC_FIELDS` in the domain package). */
      field: c.text().nn,
      igst_paise: money(),
      cgst_paise: money(),
      sgst_paise: money(),
      cess_paise: money(),
      reason: c.text().nn,
      /** Who made the change: empty for a person, `reconcile` for the GSTR-2B outcome (replaced when it is applied again). */
      source: c.text(),
    },
    indexes: [{ cols: ['business_id', 'period_fp'] }],
  },
  {
    name: 'gstr2b_imports',
    kind: 'tenant',
    cols: {
      /** MMYYYY, the 2B period. Importing a period again replaces the earlier import. */
      period_fp: c.text().nn,
      gstin: c.text().nn,
      source: c.text().nn.oneOf(['json', 'xlsx']),
      parser_version: c.text(),
      file_hash: c.text(),
      entry_count: c.int().nn.default(0),
      problems_json: c.json(),
    },
    indexes: [{ cols: ['business_id', 'period_fp'] }],
  },
  {
    name: 'gstr2b_entries',
    kind: 'tenant',
    cols: {
      import_id: c.uuid().nn.ref('gstr2b_imports'),
      period_fp: c.text().nn,
      supplier_gstin: c.text().nn,
      supplier_name: c.text(),
      doc_type: c.text().nn.oneOf(['invoice', 'credit_note', 'debit_note']),
      number: c.text().nn,
      /** The number made comparable (`numberKey` in the domain package); decisions are kept against it. */
      number_key: c.text().nn,
      date: c.date().nn,
      taxable_paise: money(),
      igst_paise: money(),
      cgst_paise: money(),
      sgst_paise: money(),
      cess_paise: money(),
      itc_available: c.text(),
      reason: c.text(),
      supplier_period: c.text(),
    },
    indexes: [
      { cols: ['business_id', 'period_fp'] },
      { cols: ['business_id', 'supplier_gstin', 'number_key'] },
    ],
  },
  {
    name: 'gstr2b_decisions',
    kind: 'tenant',
    cols: {
      period_fp: c.text().nn,
      side: c.text().nn.oneOf(['entry', 'bill']),
      /** For a 2B line: `GSTIN|number key|type` (it survives a re-import). For a bill: the document id. */
      ref_key: c.text().nn,
      decision: c.text().nn.oneOf(['accept', 'link', 'supplier_to_file', 'ignore']),
      /** For a link: the bill the 2B line was tied to by hand. */
      linked_document_id: c.uuid().ref('documents'),
      note: c.text(),
    },
    indexes: [{ cols: ['business_id', 'period_fp'] }],
  },
  {
    name: 'gst_issue_acks',
    kind: 'tenant',
    cols: {
      period_fp: c.text().nn,
      /** `issueKey` in the domain package: the same problem always has the same key. */
      issue_key: c.text().nn,
      reason: c.text().nn,
    },
    indexes: [
      {
        cols: ['business_id', 'period_fp', 'issue_key'],
        unique: true,
        where: 'deleted_at IS NULL',
      },
    ],
  },
  {
    name: 'einvoices',
    kind: 'tenant',
    cols: {
      document_id: c.uuid().nn.ref('documents'),
      irn: c.text().nn,
      ack_no: c.text(),
      /** As the portal gives it, IST: `YYYY-MM-DD HH:mm:ss`. */
      ack_date: c.text(),
      signed_invoice: c.text(),
      signed_qr: c.text(),
      status: c.text().nn.default('active').oneOf(['active', 'cancelled']),
      /** The answer was a duplicate and the existing IRN was fetched. */
      recovered: c.bool().nn.default(false),
      cancel_reason: c.text(),
      cancel_remarks: c.text(),
      cancelled_at: c.text(),
    },
    indexes: [{ cols: ['business_id', 'document_id'], unique: true, where: 'deleted_at IS NULL' }],
  },
  {
    name: 'ewaybills',
    kind: 'tenant',
    cols: {
      /** Empty for an e-way bill made without a document of ours. */
      document_id: c.uuid().ref('documents'),
      ewb_no: c.text().nn,
      generated_at: c.text().nn,
      valid_until: c.text(),
      status: c.text().nn.default('active').oneOf(['active', 'cancelled']),
      distance_km: c.int(),
      trans_mode: c.text(),
      vehicle_no: c.text(),
      transporter_id: c.text(),
      from_place: c.text(),
      from_state: c.text(),
      from_pincode: c.text(),
      cancel_reason: c.text(),
      cancelled_at: c.text(),
      /** Vehicle changes and extensions, oldest first. */
      history_json: c.json(),
    },
    indexes: [{ cols: ['business_id', 'ewb_no'] }, { cols: ['document_id'] }],
  },
  {
    name: 'gsp_jobs',
    kind: 'tenant',
    cols: {
      kind: c
        .text()
        .nn.oneOf(['irn', 'irn_cancel', 'ewb', 'ewb_cancel', 'ewb_extend', 'ewb_vehicle']),
      document_id: c.uuid().ref('documents'),
      ewaybill_id: c.uuid().ref('ewaybills'),
      /** The same request is never sent twice: a second queue of it returns the first job. */
      idempotency_key: c.text().nn,
      payload_json: c.json(),
      args_json: c.json(),
      /** The document's revision when queued; a different one stops the job. */
      doc_revision: c.int(),
      status: c
        .text()
        .nn.default('queued')
        .oneOf(['queued', 'running', 'done', 'failed', 'stopped']),
      attempts: c.int().nn.default(0),
      next_at: c.ts(),
      last_code: c.text(),
      last_message: c.text(),
      result_json: c.json(),
    },
    indexes: [
      { cols: ['business_id', 'idempotency_key'], unique: true, where: 'deleted_at IS NULL' },
      { cols: ['business_id', 'status'] },
    ],
  },
  {
    name: 'gsp_log',
    kind: 'tenant',
    cols: {
      job_id: c.uuid().ref('gsp_jobs'),
      document_id: c.uuid().ref('documents'),
      portal: c.text().nn,
      action: c.text().nn,
      /** Secrets removed before it is written (`redact` in @gst/gsp). */
      request_json: c.json(),
      response_json: c.json(),
      ok: c.bool().nn.default(false),
      code: c.text(),
      message: c.text(),
      ms: c.int(),
    },
    indexes: [{ cols: ['business_id', 'document_id'] }, { cols: ['job_id'] }],
  },
  {
    name: 'ledger_accounts',
    kind: 'tenant',
    cols: {
      code: c.text().nn,
      name: c.text().nn,
      type: c.text().nn.oneOf(['asset', 'liability', 'income', 'expense', 'equity']),
      parent_id: c.uuid().ref('ledger_accounts'),
      is_system: c.bool().nn.default(false),
      /** A group under the type, as the balance sheet and P&L show them (prompt 50). */
      sub_group: c.text(),
      /** The ledger name in the Tally company this business exports to. */
      tally_name: c.text(),
      /** For a bank or cash ledger made from a business account: which one. */
      business_account_id: c.uuid().ref('business_accounts'),
    },
    indexes: [{ cols: ['business_id', 'code'], unique: true, where: 'deleted_at IS NULL' }],
  },
  {
    /** A journal template posted on a schedule (prompt 50): rent, salary, depreciation. */
    name: 'recurring_journals',
    kind: 'tenant',
    cols: {
      name: c.text().nn,
      every: c.text().nn.default('monthly').oneOf(['monthly', 'quarterly', 'yearly']),
      /** The day of the month the entry is dated. */
      day: c.int().nn.default(1),
      next_date: c.date().nn,
      end_date: c.date(),
      /** `[{ accountId, debitPaise, creditPaise, partyId? }]`, balanced. */
      lines_json: c.json(),
      narration: c.text(),
      active: c.bool().nn.default(true),
      last_posted_date: c.date(),
    },
    indexes: [{ cols: ['business_id', 'next_date'] }],
  },
  {
    /** A hand-made ledger entry (prompt 50): a journal, a contra, opening balances, a year-end close. */
    name: 'journal_vouchers',
    kind: 'tenant',
    cols: {
      number: c.text().nn,
      date: c.date().nn,
      kind: c
        .text()
        .nn.default('journal')
        .oneOf(['journal', 'contra', 'opening', 'closing', 'reversal', 'recurring', 'reclass']),
      narration: c.text(),
      status: c.text().nn.default('posted').oneOf(['posted', 'reversed']),
      /** The voucher that reversed this one, and the one this reverses. */
      reversed_by: c.uuid().ref('journal_vouchers'),
      reverses: c.uuid().ref('journal_vouchers'),
      recurring_id: c.uuid().ref('recurring_journals'),
      /** The debit side's total, for lists. */
      total_paise: money(),
    },
    indexes: [
      { cols: ['business_id', 'number'], unique: true, where: 'deleted_at IS NULL' },
      { cols: ['business_id', 'date'] },
    ],
  },
  {
    name: 'ledger_entries',
    kind: 'tenant',
    cols: {
      document_id: c.uuid().ref('documents'),
      payment_id: c.uuid().ref('payments'),
      voucher_id: c.uuid().ref('journal_vouchers'),
      party_id: c.uuid().ref('parties'),
      account_id: c.uuid().nn.ref('ledger_accounts'),
      debit_paise: money(),
      credit_paise: money(),
      date: c.date().nn,
      narration: c.text(),
    },
    indexes: [
      { cols: ['account_id', 'date'] },
      { cols: ['document_id'] },
      { cols: ['voucher_id'] },
    ],
  },
  {
    /** A financial year's close (prompt 50): the closing voucher, who closed it, who reopened it and why. */
    name: 'fiscal_years',
    kind: 'tenant',
    cols: {
      fy_start: c.date().nn,
      fy_end: c.date().nn,
      status: c.text().nn.default('open').oneOf(['open', 'closed']),
      closing_voucher_id: c.uuid().ref('journal_vouchers'),
      closed_at: c.ts(),
      closed_by: c.text(),
      reopened_at: c.ts(),
      reopened_by: c.text(),
      reopen_reason: c.text(),
    },
    indexes: [{ cols: ['business_id', 'fy_start'], unique: true, where: 'deleted_at IS NULL' }],
  },
  {
    name: 'reminders',
    kind: 'tenant',
    cols: {
      party_id: c.uuid().nn.ref('parties'),
      channel: c.text().nn.oneOf(['whatsapp', 'email', 'sms', 'call', 'manual']),
      message: c.text(),
      /** Amount outstanding when the reminder was sent. */
      amount_paise: money(),
      sent_at: c.ts().nn,
    },
    indexes: [{ cols: ['party_id', 'sent_at'] }],
  },
  {
    name: 'godowns',
    kind: 'tenant',
    cols: { name: c.text().nn, is_default: c.bool().nn.default(false) },
  },
  {
    name: 'batches',
    kind: 'tenant',
    cols: {
      item_id: c.uuid().nn.ref('items'),
      batch_no: c.text().nn,
      mfg_date: c.date(),
      expiry_date: c.date(),
    },
    indexes: [{ cols: ['item_id'] }],
  },
  {
    name: 'stock_movements',
    kind: 'tenant',
    cols: {
      item_id: c.uuid().nn.ref('items'),
      variant_id: c.uuid().ref('item_variants'),
      godown_id: c.uuid().ref('godowns'),
      batch_id: c.uuid().ref('batches'),
      kind: c.text().nn.oneOf(['in', 'out', 'adjust', 'transfer']),
      /** signed quantity in micro-units: positive adds stock */
      qty_micros: c.big().nn,
      rate_paise: c.big(),
      document_id: c.uuid().ref('documents'),
      date: c.date().nn,
      note: c.text(),
    },
    indexes: [{ cols: ['item_id', 'date'] }, { cols: ['document_id'] }],
  },
  {
    name: 'templates',
    kind: 'tenant',
    cols: {
      name: c.text().nn,
      kind: c.text().nn.default('document'),
      config_json: c.json(),
      is_default: c.bool().nn.default(false),
    },
  },
  {
    name: 'attachments',
    kind: 'tenant',
    cols: {
      owner_table: c.text().nn,
      owner_id: c.uuid().nn,
      file_name: c.text().nn,
      mime: c.text(),
      size_bytes: c.big().nn.default(0),
      sha256: c.text().nn,
      storage_path: c.text().nn,
    },
    indexes: [{ cols: ['owner_table', 'owner_id'] }],
  },
  {
    name: 'review_items',
    kind: 'tenant',
    cols: {
      kind: c.text().nn,
      status: c.text().nn.default('pending').oneOf(['pending', 'accepted', 'rejected', 'expired']),
      payload_json: c.json(),
      suggestion_json: c.json(),
      diff_json: c.json(),
      /** What the user changed before accepting (suggestion -> accepted value); feeds evals. */
      correction_json: c.json(),
      source: c.text(),
      model: c.text(),
      confidence: c.int(),
      accepted_by: c.text(),
      accepted_at: c.ts(),
      /** Hidden from the inbox, and from the counts, until this time. */
      snoozed_until: c.ts(),
      /** Why a person turned it down. */
      reject_reason: c.text(),
      /**
       * Names what the finding is about (`duplicate_party:<id>:<id>`), so the same finding is never
       * raised twice, even after it was accepted, rejected or snoozed.
       */
      dedupe_key: c.text(),
    },
    indexes: [{ cols: ['business_id', 'status'] }, { cols: ['business_id', 'kind', 'dedupe_key'] }],
  },
  {
    name: 'ai_calls',
    kind: 'tenant-lite',
    // metadata only: never the prompt or the response
    cols: {
      feature: c.text().nn,
      capability: c.text().nn,
      provider: c.text().nn,
      model: c.text(),
      input_tokens: c.int(),
      output_tokens: c.int(),
      latency_ms: c.int().nn.default(0),
      outcome: c.text().nn,
    },
    indexes: [{ cols: ['business_id', 'feature'] }],
  },
  {
    name: 'audit_log',
    kind: 'tenant-lite',
    cols: {
      table_name: c.text().nn,
      row_id: c.uuid().nn,
      action: c.text().nn.oneOf(['insert', 'update', 'soft_delete', 'purge']),
      before_json: c.json(),
      after_json: c.json(),
      actor: c.text().nn,
      device_id: c.text(),
      at: c.ts().nn,
    },
    indexes: [{ cols: ['table_name', 'row_id'] }],
  },
  {
    name: 'import_mappings',
    kind: 'tenant',
    cols: {
      entity: c.text().nn.oneOf(['items', 'parties']),
      /** Sorted, normalised header names: the same layout in any column order. */
      signature: c.text().nn,
      mapping_json: c.json(),
    },
    indexes: [
      { cols: ['business_id', 'entity', 'signature'], unique: true, where: 'deleted_at IS NULL' },
    ],
  },
  {
    name: 'settings',
    kind: 'tenant',
    cols: {
      key: c.text().nn,
      value_json: c.json(),
      scope: c.text().nn.default('business').oneOf(['business', 'org', 'user', 'device']),
    },
    indexes: [{ cols: ['business_id', 'scope', 'key'], unique: true, where: 'deleted_at IS NULL' }],
  },
  {
    name: 'sync_state',
    kind: 'org',
    cols: {
      device_id: c.uuid(),
      cursor: c.text(),
      last_synced_at: c.ts(),
    },
  },
];

/** Tables with an `org_id` column: RLS applies to these on Postgres. */
export const TENANT_TABLES = SPEC.filter((s) => s.kind !== 'plain').map((s) => s.name);
/** Tables whose rows are never hard-deleted. */
export const NO_DELETE_TABLES = SPEC.map((s) => s.name);
