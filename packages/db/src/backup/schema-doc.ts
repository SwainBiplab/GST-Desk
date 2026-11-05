/**
 * `docs/export-schema.md`, written from the schema itself so the document cannot drift from what a
 * backup or an export really holds. `pnpm --filter @gst/db docs:export-schema` rewrites the file; a
 * test fails when the file and the schema disagree.
 */
import { EXPORT_FORMAT, EXPORT_FORMAT_VERSION, businessTables } from './business-data';
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION } from './format';
import { TABLES, type TableInfo } from './tables';

const KIND_TEXT: Record<string, string> = {
  uuid: 'id (text)',
  text: 'text',
  int: 'integer',
  big: 'integer (paise, micro-units or a count)',
  bool: 'true or false',
  json: 'JSON',
  ts: 'time (epoch milliseconds)',
  date: 'date (`YYYY-MM-DD`)',
};

const KIND_NOTE: Record<string, string> = {
  organisations: 'The organisation (the account) that owns businesses. Not in a business export.',
  users: 'People who can sign in. Not in a business export.',
  businesses: 'The business itself: its name, GSTIN, address, financial-year start and settings.',
  memberships: 'Which user belongs to which business, with a role. Not in a business export.',
  devices: 'The devices that use the business. Not in a business export.',
  hsn_master: 'The HSN and SAC code list that ships with the app. Not in a business export.',
  rate_master_versions: 'Versions of that list. Not in a business export.',
  number_reservations: 'Number ranges handed to a device. Not in a business export.',
  sync_state: 'Sync bookkeeping. Not in a business export.',
  ai_calls: 'A log of assistant requests. Not in a business export.',
  audit_log: 'Who changed what, and when. In a backup; in a business export only when asked for.',
  settings:
    'Settings by key. Rows whose key marks a secret (tokens, credentials, PINs) are never exported.',
  documents:
    'Invoices, bills, notes, quotations and the rest. In the JSON export each document carries its `lines`.',
  document_lines:
    'The lines of a document. In the JSON export they sit inside their document as `lines`.',
  payments: 'Money received or paid. In the JSON export each payment carries its `allocations`.',
  payment_allocations:
    'What a payment (or applied credit) settles. In the JSON export they sit inside their payment as `allocations`.',
  stock_movements: "Stock in and out, one row each. An item's stock is the sum of its movements.",
  attachments:
    'File names and hashes. The files themselves are in the `attachments` folder of a backup or CSV bundle.',
};

function columnRows(t: TableInfo): string {
  const rows = Object.entries(t.columns).map(([name, col]) => {
    const o = col.o;
    const bits: string[] = [];
    if (o.enum) bits.push(`one of ${o.enum.map((e) => `\`${e}\``).join(', ')}`);
    if (o.ref) bits.push(`refers to \`${o.ref}\``);
    if (o.def !== undefined && typeof o.def !== 'object')
      bits.push(`default ${JSON.stringify(o.def)}`);
    return `| \`${name}\` | ${KIND_TEXT[col.kind] ?? col.kind} | ${o.nn ? 'yes' : ''} | ${bits.join('; ')} |`;
  });
  return ['| Column | Type | Required | Notes |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

export function exportSchemaDoc(): string {
  const inBusiness = new Set(['businesses', ...businessTables(false).map((t) => t.name)]);
  const lines: string[] = [
    '# Export schema',
    '',
    'GST Desk never locks your data in. This page says exactly what a backup and an export hold, so any program (or a person with a spreadsheet) can read them. It is generated from the database schema (`pnpm --filter @gst/db docs:export-schema`), and a test checks that it is up to date.',
    '',
    '## Three ways out',
    '',
    `- **Backup** (\`.gstbk\`, format \`${BACKUP_FORMAT}\` version ${BACKUP_FORMAT_VERSION}): everything on the device, every business, for restoring. A ZIP file you can open with any unzip tool: \`manifest.json\` (what is inside, the schema version, a checksum of every file), \`data/<table>.jsonl\` (one JSON object per line, rows in key order) and \`attachments/<sha256>\` (the attached files, named by their hash).`,
    `- **JSON export** (format \`${EXPORT_FORMAT}\` version ${EXPORT_FORMAT_VERSION}): one business as one JSON document, for moving it to another install. Importing it makes a new business with new ids; every reference, including ids kept inside settings, is followed to the new ids.`,
    '- **CSV files**: one `.csv` per table of one business (every column, in the order below), the attached files in an `attachments` folder, and a `README.txt`. For opening in a spreadsheet.',
    '',
    'None of them contains passwords, tokens or PINs: settings whose key starts with `secret`, `oauth`, `cloud.token`, `cloud.secret`, `cloud.credentials` or `pin` are left out, and the audit trail never records their values.',
    '',
    '## Conventions',
    '',
    '- **Money** is a whole number of **paise**: ₹1,234.50 is `123450`. Never a decimal.',
    '- **Quantities** are whole numbers of **micro-units**: 2.5 is `2500000`.',
    '- **Rates** are **basis points**: 18% is `1800`.',
    '- **Dates** are `YYYY-MM-DD`; **times** are milliseconds since 1 January 1970 (UTC).',
    '- **Ids** are UUID strings. Every row has `id`; rows of a business have `org_id` and `business_id`.',
    '- **JSON columns** hold JSON values (objects, arrays), not text containing JSON, in the backup and JSON export.',
    '- A row removed from view is not deleted: `deleted_at` holds the time. A cancelled document keeps its number and has `status` `cancelled`.',
    '',
    '## JSON export layout',
    '',
    '```json',
    '{',
    `  "format": "${EXPORT_FORMAT}",`,
    `  "formatVersion": ${EXPORT_FORMAT_VERSION},`,
    '  "exportedAt": "2025-03-01T09:30:00.000Z",',
    '  "schemaVersion": 5,',
    '  "business": { "id": "…", "legal_name": "…", "gstin": "…" },',
    '  "tables": {',
    '    "parties": [ { "id": "…", "name": "…" } ],',
    '    "documents": [ { "id": "…", "type": "tax_invoice", "number": "INV/25-26/0001", "lines": [ { "id": "…" } ] } ],',
    '    "payments": [ { "id": "…", "allocations": [ { "id": "…" } ] } ]',
    '  }',
    '}',
    '```',
    '',
    '## Tables',
    '',
  ];
  for (const t of TABLES) {
    lines.push(`### \`${t.name}\``, '');
    const note = KIND_NOTE[t.name];
    if (note) lines.push(note, '');
    lines.push(
      `Kind: ${t.kind === 'plain' ? 'shared data' : t.kind === 'org' ? 'belongs to an organisation' : 'belongs to a business'}. ${inBusiness.has(t.name) ? 'In a business export.' : 'In a backup only.'}`,
      '',
      columnRows(t),
      '',
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
