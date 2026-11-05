# Export schema

GST Desk never locks your data in. This page says exactly what a backup and an export hold, so any program (or a person with a spreadsheet) can read them. It is generated from the database schema (`pnpm --filter @gst/db docs:export-schema`), and a test checks that it is up to date.

## Three ways out

- **Backup** (`.gstbk`, format `gstbk` version 1): everything on the device, every business, for restoring. A ZIP file you can open with any unzip tool: `manifest.json` (what is inside, the schema version, a checksum of every file), `data/<table>.jsonl` (one JSON object per line, rows in key order) and `attachments/<sha256>` (the attached files, named by their hash).
- **JSON export** (format `gst-desk-export` version 1): one business as one JSON document, for moving it to another install. Importing it makes a new business with new ids; every reference, including ids kept inside settings, is followed to the new ids.
- **CSV files**: one `.csv` per table of one business (every column, in the order below), the attached files in an `attachments` folder, and a `README.txt`. For opening in a spreadsheet.

None of them contains passwords, tokens or PINs: settings whose key starts with `secret`, `oauth`, `cloud.token`, `cloud.secret`, `cloud.credentials` or `pin` are left out, and the audit trail never records their values.

## Conventions

- **Money** is a whole number of **paise**: ₹1,234.50 is `123450`. Never a decimal.
- **Quantities** are whole numbers of **micro-units**: 2.5 is `2500000`.
- **Rates** are **basis points**: 18% is `1800`.
- **Dates** are `YYYY-MM-DD`; **times** are milliseconds since 1 January 1970 (UTC).
- **Ids** are UUID strings. Every row has `id`; rows of a business have `org_id` and `business_id`.
- **JSON columns** hold JSON values (objects, arrays), not text containing JSON, in the backup and JSON export.
- A row removed from view is not deleted: `deleted_at` holds the time. A cancelled document keeps its number and has `status` `cancelled`.

## JSON export layout

```json
{
  "format": "gst-desk-export",
  "formatVersion": 1,
  "exportedAt": "2025-03-01T09:30:00.000Z",
  "schemaVersion": 5,
  "business": { "id": "…", "legal_name": "…", "gstin": "…" },
  "tables": {
    "parties": [ { "id": "…", "name": "…" } ],
    "documents": [ { "id": "…", "type": "tax_invoice", "number": "INV/25-26/0001", "lines": [ { "id": "…" } ] } ],
    "payments": [ { "id": "…", "allocations": [ { "id": "…" } ] } ]
  }
}
```

## Tables

### `organisations`

The organisation (the account) that owns businesses. Not in a business export.

Kind: shared data. In a backup only.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `version` | integer | yes | default 1 |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `name` | text | yes |  |
| `plan` | text | yes | default "free" |

### `users`

People who can sign in. Not in a business export.

Kind: shared data. In a backup only.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `version` | integer | yes | default 1 |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `email` | text | yes |  |
| `name` | text | yes |  |
| `phone` | text |  |  |
| `locale` | text | yes | default "en" |

### `businesses`

The business itself: its name, GSTIN, address, financial-year start and settings.

Kind: belongs to an organisation. In a business export.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `org_id` | id (text) | yes | refers to `organisations` |
| `version` | integer | yes | default 1 |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `created_by` | text |  |  |
| `updated_by` | text |  |  |
| `gstin` | text |  |  |
| `legal_name` | text | yes |  |
| `trade_name` | text |  |  |
| `address` | JSON |  |  |
| `state_code` | text | yes |  |
| `pan` | text |  |  |
| `scheme` | text | yes | one of `regular`, `composition`; default "regular" |
| `fy_start_month` | integer | yes | default 4 |
| `preset` | text |  |  |
| `settings_json` | JSON |  |  |

### `memberships`

Which user belongs to which business, with a role. Not in a business export.

Kind: belongs to an organisation. In a backup only.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `org_id` | id (text) | yes | refers to `organisations` |
| `version` | integer | yes | default 1 |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `created_by` | text |  |  |
| `updated_by` | text |  |  |
| `user_id` | id (text) | yes | refers to `users` |
| `business_id` | id (text) |  | refers to `businesses` |
| `role` | text | yes | one of `owner`, `admin`, `accountant`, `staff`, `ca`, `viewer` |

### `devices`

The devices that use the business. Not in a business export.

Kind: belongs to a business. In a backup only.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `org_id` | id (text) | yes | refers to `organisations` |
| `business_id` | id (text) | yes | refers to `businesses` |
| `version` | integer | yes | default 1 |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `created_by` | text |  |  |
| `updated_by` | text |  |  |
| `name` | text | yes |  |
| `platform` | text |  |  |
| `last_seen_at` | time (epoch milliseconds) |  |  |

### `business_accounts`

Kind: belongs to a business. In a business export.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `org_id` | id (text) | yes | refers to `organisations` |
| `business_id` | id (text) | yes | refers to `businesses` |
| `version` | integer | yes | default 1 |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `created_by` | text |  |  |
| `updated_by` | text |  |  |
| `kind` | text | yes | one of `bank`, `upi`, `cash`, `wallet` |
| `name` | text | yes |  |
| `holder_name` | text |  |  |
| `account_no` | text |  |  |
| `ifsc` | text |  |  |
| `account_type` | text |  |  |
| `upi_id` | text |  |  |
| `is_default` | true or false | yes | default false |
| `show_on_documents` | true or false | yes | default true |

### `units`

Kind: belongs to a business. In a business export.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `org_id` | id (text) | yes | refers to `organisations` |
| `business_id` | id (text) | yes | refers to `businesses` |
| `version` | integer | yes | default 1 |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `created_by` | text |  |  |
| `updated_by` | text |  |  |
| `code` | text | yes |  |
| `name` | text | yes |  |
| `is_custom` | true or false | yes | default false |
| `uqc` | text |  |  |

### `parties`

Kind: belongs to a business. In a business export.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `org_id` | id (text) | yes | refers to `organisations` |
| `business_id` | id (text) | yes | refers to `businesses` |
| `version` | integer | yes | default 1 |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `created_by` | text |  |  |
| `updated_by` | text |  |  |
| `type` | text | yes | one of `customer`, `supplier`, `both` |
| `name` | text | yes |  |
| `trade_name` | text |  |  |
| `gstin` | text |  |  |
| `pan` | text |  |  |
| `phone` | text |  |  |
| `email` | text |  |  |
| `state_code` | text |  |  |
| `addresses_json` | JSON |  |  |
| `contacts_json` | JSON |  |  |
| `credit_days` | integer | yes | default 0 |
| `opening_balance_paise` | integer (paise, micro-units or a count) | yes | default 0 |
| `opening_balance_date` | date (`YYYY-MM-DD`) |  |  |
| `credit_limit_paise` | integer (paise, micro-units or a count) | yes | default 0 |
| `city` | text |  |  |
| `country` | text | yes | default "India" |
| `notes` | text |  |  |
| `tags_json` | JSON |  |  |
| `is_sez` | true or false | yes | default false |
| `is_export` | true or false | yes | default false |
| `is_unregistered` | true or false | yes | default false |
| `is_composition` | true or false | yes | default false |

### `items`

Kind: belongs to a business. In a business export.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `org_id` | id (text) | yes | refers to `organisations` |
| `business_id` | id (text) | yes | refers to `businesses` |
| `version` | integer | yes | default 1 |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `created_by` | text |  |  |
| `updated_by` | text |  |  |
| `kind` | text | yes | one of `goods`, `service`; default "goods" |
| `name` | text | yes |  |
| `description` | text |  |  |
| `sku` | text |  |  |
| `barcode` | text |  |  |
| `hsn` | text |  |  |
| `unit_id` | id (text) |  | refers to `units` |
| `secondary_unit_id` | id (text) |  | refers to `units` |
| `secondary_factor_micros` | integer (paise, micro-units or a count) |  |  |
| `sale_rate_paise` | integer (paise, micro-units or a count) | yes | default 0 |
| `purchase_rate_paise` | integer (paise, micro-units or a count) | yes | default 0 |
| `mrp_paise` | integer (paise, micro-units or a count) |  |  |
| `tax_inclusive` | true or false | yes | default false |
| `gst_rate_bp` | integer | yes | default 0 |
| `cess_bp` | integer | yes | default 0 |
| `gst_rate_overridden` | true or false | yes | default false |
| `track_stock` | true or false | yes | default false |
| `min_stock_micros` | integer (paise, micro-units or a count) | yes | default 0 |
| `opening_stock_micros` | integer (paise, micro-units or a count) | yes | default 0 |
| `opening_stock_value_paise` | integer (paise, micro-units or a count) | yes | default 0 |
| `images_json` | JSON |  |  |
| `tags_json` | JSON |  |  |
| `is_active` | true or false | yes | default true |

### `item_variants`

Kind: belongs to a business. In a business export.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `org_id` | id (text) | yes | refers to `organisations` |
| `business_id` | id (text) | yes | refers to `businesses` |
| `version` | integer | yes | default 1 |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `created_by` | text |  |  |
| `updated_by` | text |  |  |
| `item_id` | id (text) | yes | refers to `items` |
| `name` | text | yes |  |
| `sku` | text |  |  |
| `barcode` | text |  |  |
| `sale_rate_paise` | integer (paise, micro-units or a count) |  |  |
| `attrs_json` | JSON |  |  |

### `hsn_master`

The HSN and SAC code list that ships with the app. Not in a business export.

Kind: shared data. In a backup only.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `version` | integer | yes | default 1 |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `code` | text | yes |  |
| `description` | text | yes |  |
| `rate_bp` | integer | yes | default 0 |
| `cess_bp` | integer | yes | default 0 |
| `effective_from` | date (`YYYY-MM-DD`) | yes |  |
| `effective_to` | date (`YYYY-MM-DD`) |  |  |
| `source_version` | text |  |  |

### `rate_master_versions`

Versions of that list. Not in a business export.

Kind: shared data. In a backup only.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `version` | text | yes |  |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `effective_from` | date (`YYYY-MM-DD`) | yes |  |
| `source` | text |  |  |
| `notes` | text |  |  |
| `published_at` | time (epoch milliseconds) |  |  |
| `as_of` | date (`YYYY-MM-DD`) |  |  |
| `row_count` | integer |  |  |
| `sha256` | text |  |  |
| `imported_at` | time (epoch milliseconds) |  |  |

### `number_series`

Kind: belongs to a business. In a business export.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `org_id` | id (text) | yes | refers to `organisations` |
| `business_id` | id (text) | yes | refers to `businesses` |
| `version` | integer | yes | default 1 |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `created_by` | text |  |  |
| `updated_by` | text |  |  |
| `document_type` | text | yes |  |
| `name` | text |  |  |
| `series_key` | text |  |  |
| `is_default` | true or false | yes | default false |
| `shell_default` | text |  | one of `books`, `shop` |
| `start_number` | integer | yes | default 1 |
| `prefix` | text | yes | default "" |
| `suffix` | text | yes | default "" |
| `padding` | integer | yes | default 4 |
| `reset` | text | yes | one of `fy`, `never`; default "fy" |
| `fy` | text |  |  |
| `next_number` | integer | yes | default 1 |
| `reserved_ranges_json` | JSON |  |  |

### `number_reservations`

Number ranges handed to a device. Not in a business export.

Kind: belongs to a business. In a backup only.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `org_id` | id (text) | yes | refers to `organisations` |
| `business_id` | id (text) | yes | refers to `businesses` |
| `version` | integer | yes | default 1 |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `created_by` | text |  |  |
| `updated_by` | text |  |  |
| `series_id` | id (text) | yes | refers to `number_series` |
| `device_id` | id (text) |  | refers to `devices` |
| `from_number` | integer | yes |  |
| `to_number` | integer | yes |  |
| `used` | integer | yes | default 0 |
| `status` | text | yes | one of `active`, `used`, `released`; default "active" |

### `documents`

Invoices, bills, notes, quotations and the rest. In the JSON export each document carries its `lines`.

Kind: belongs to a business. In a business export.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `org_id` | id (text) | yes | refers to `organisations` |
| `business_id` | id (text) | yes | refers to `businesses` |
| `version` | integer | yes | default 1 |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `created_by` | text |  |  |
| `updated_by` | text |  |  |
| `type` | text | yes | one of `tax_invoice`, `bill_of_supply`, `proforma`, `quotation`, `credit_note`, `debit_note`, `delivery_challan`, `receipt_voucher`, `purchase_bill`, `purchase_return`, `expense`, `rcm_self_invoice` |
| `status` | text | yes | one of `draft`, `issued`, `cancelled`; default "draft" |
| `number` | text |  |  |
| `series_id` | id (text) |  | refers to `number_series` |
| `date` | date (`YYYY-MM-DD`) | yes |  |
| `due_date` | date (`YYYY-MM-DD`) |  |  |
| `party_id` | id (text) |  | refers to `parties` |
| `party_name` | text |  |  |
| `place_of_supply_state` | text |  |  |
| `supply_type` | text | yes | one of `intra`, `inter`, `export`, `sez`; default "intra" |
| `reverse_charge` | true or false | yes | default false |
| `currency` | text | yes | default "INR" |
| `fx_rate_micros` | integer (paise, micro-units or a count) | yes | default 1000000 |
| `total_taxable_paise` | integer (paise, micro-units or a count) | yes | default 0 |
| `total_cgst_paise` | integer (paise, micro-units or a count) | yes | default 0 |
| `total_sgst_paise` | integer (paise, micro-units or a count) | yes | default 0 |
| `total_igst_paise` | integer (paise, micro-units or a count) | yes | default 0 |
| `total_utgst_paise` | integer (paise, micro-units or a count) | yes | default 0 |
| `total_cess_paise` | integer (paise, micro-units or a count) | yes | default 0 |
| `tcs_paise` | integer (paise, micro-units or a count) | yes | default 0 |
| `tds_paise` | integer (paise, micro-units or a count) | yes | default 0 |
| `round_off_paise` | integer (paise, micro-units or a count) | yes | default 0 |
| `total_paise` | integer (paise, micro-units or a count) | yes | default 0 |
| `notes` | text |  |  |
| `terms` | text |  |  |
| `template_id` | id (text) |  | refers to `templates` |
| `irn` | text |  |  |
| `irn_ack_no` | text |  |  |
| `irn_ack_date` | text |  |  |
| `irn_signed_qr` | text |  |  |
| `eway_bill_no` | text |  |  |
| `eway_valid_until` | time (epoch milliseconds) |  |  |
| `cancelled_at` | time (epoch milliseconds) |  |  |
| `cancel_reason` | text |  |  |
| `revision` | integer | yes | default 1 |
| `source_document_id` | id (text) |  | refers to `documents` |
| `metadata_json` | JSON |  |  |

### `document_lines`

The lines of a document. In the JSON export they sit inside their document as `lines`.

Kind: belongs to a business. In a business export.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `org_id` | id (text) | yes | refers to `organisations` |
| `business_id` | id (text) | yes | refers to `businesses` |
| `version` | integer | yes | default 1 |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `created_by` | text |  |  |
| `updated_by` | text |  |  |
| `document_id` | id (text) | yes | refers to `documents` |
| `line_no` | integer | yes |  |
| `item_id` | id (text) |  | refers to `items` |
| `description` | text |  |  |
| `hsn` | text |  |  |
| `qty_micros` | integer (paise, micro-units or a count) | yes | default 1000000 |
| `unit_id` | id (text) |  | refers to `units` |
| `rate_paise` | integer (paise, micro-units or a count) | yes | default 0 |
| `discount_mode` | text | yes | one of `none`, `percent`, `amount`, `per_unit`; default "none" |
| `discount_value` | integer (paise, micro-units or a count) | yes | default 0 |
| `gst_rate_bp` | integer | yes | default 0 |
| `price_includes_tax` | true or false | yes | default false |
| `taxability` | text | yes | one of `taxable`, `exempt`, `nil_rated`, `non_gst`; default "taxable" |
| `note` | text |  |  |
| `taxable_paise` | integer (paise, micro-units or a count) | yes | default 0 |
| `cgst_bp` | integer | yes | default 0 |
| `sgst_bp` | integer | yes | default 0 |
| `igst_bp` | integer | yes | default 0 |
| `utgst_bp` | integer | yes | default 0 |
| `cess_bp` | integer | yes | default 0 |
| `cgst_paise` | integer (paise, micro-units or a count) | yes | default 0 |
| `sgst_paise` | integer (paise, micro-units or a count) | yes | default 0 |
| `igst_paise` | integer (paise, micro-units or a count) | yes | default 0 |
| `utgst_paise` | integer (paise, micro-units or a count) | yes | default 0 |
| `cess_paise` | integer (paise, micro-units or a count) | yes | default 0 |
| `total_paise` | integer (paise, micro-units or a count) | yes | default 0 |
| `batch_id` | id (text) |  | refers to `batches` |
| `serials_json` | JSON |  |  |

### `payments`

Money received or paid. In the JSON export each payment carries its `allocations`.

Kind: belongs to a business. In a business export.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `org_id` | id (text) | yes | refers to `organisations` |
| `business_id` | id (text) | yes | refers to `businesses` |
| `version` | integer | yes | default 1 |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `created_by` | text |  |  |
| `updated_by` | text |  |  |
| `date` | date (`YYYY-MM-DD`) | yes |  |
| `direction` | text | yes | one of `received`, `made`; default "received" |
| `mode` | text | yes | one of `cash`, `upi`, `card`, `bank`, `cheque`, `other`, `adjustment` |
| `account_id` | id (text) |  | refers to `business_accounts` |
| `party_id` | id (text) |  | refers to `parties` |
| `amount_paise` | integer (paise, micro-units or a count) | yes |  |
| `reference` | text |  |  |
| `cheque_date` | date (`YYYY-MM-DD`) |  |  |
| `notes` | text |  |  |
| `tcs_paise` | integer (paise, micro-units or a count) | yes | default 0 |
| `voucher_id` | id (text) |  | refers to `documents` |
| `status` | text | yes | one of `pending`, `cleared`, `bounced`, `cancelled`; default "cleared" |

### `payment_allocations`

What a payment (or applied credit) settles. In the JSON export they sit inside their payment as `allocations`.

Kind: belongs to a business. In a business export.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `org_id` | id (text) | yes | refers to `organisations` |
| `business_id` | id (text) | yes | refers to `businesses` |
| `version` | integer | yes | default 1 |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `created_by` | text |  |  |
| `updated_by` | text |  |  |
| `payment_id` | id (text) |  | refers to `payments` |
| `document_id` | id (text) | yes | refers to `documents` |
| `amount_paise` | integer (paise, micro-units or a count) | yes |  |
| `kind` | text | yes | one of `payment`, `credit_applied`, `write_off`; default "payment" |
| `source_document_id` | id (text) |  | refers to `documents` |

### `ledger_accounts`

Kind: belongs to a business. In a business export.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `org_id` | id (text) | yes | refers to `organisations` |
| `business_id` | id (text) | yes | refers to `businesses` |
| `version` | integer | yes | default 1 |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `created_by` | text |  |  |
| `updated_by` | text |  |  |
| `code` | text | yes |  |
| `name` | text | yes |  |
| `type` | text | yes | one of `asset`, `liability`, `income`, `expense`, `equity` |
| `parent_id` | id (text) |  | refers to `ledger_accounts` |
| `is_system` | true or false | yes | default false |

### `ledger_entries`

Kind: belongs to a business. In a business export.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `org_id` | id (text) | yes | refers to `organisations` |
| `business_id` | id (text) | yes | refers to `businesses` |
| `version` | integer | yes | default 1 |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `created_by` | text |  |  |
| `updated_by` | text |  |  |
| `document_id` | id (text) |  | refers to `documents` |
| `payment_id` | id (text) |  | refers to `payments` |
| `party_id` | id (text) |  | refers to `parties` |
| `account_id` | id (text) | yes | refers to `ledger_accounts` |
| `debit_paise` | integer (paise, micro-units or a count) | yes | default 0 |
| `credit_paise` | integer (paise, micro-units or a count) | yes | default 0 |
| `date` | date (`YYYY-MM-DD`) | yes |  |
| `narration` | text |  |  |

### `reminders`

Kind: belongs to a business. In a business export.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `org_id` | id (text) | yes | refers to `organisations` |
| `business_id` | id (text) | yes | refers to `businesses` |
| `version` | integer | yes | default 1 |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `created_by` | text |  |  |
| `updated_by` | text |  |  |
| `party_id` | id (text) | yes | refers to `parties` |
| `channel` | text | yes | one of `whatsapp`, `email`, `sms`, `call`, `manual` |
| `message` | text |  |  |
| `amount_paise` | integer (paise, micro-units or a count) | yes | default 0 |
| `sent_at` | time (epoch milliseconds) | yes |  |

### `godowns`

Kind: belongs to a business. In a business export.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `org_id` | id (text) | yes | refers to `organisations` |
| `business_id` | id (text) | yes | refers to `businesses` |
| `version` | integer | yes | default 1 |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `created_by` | text |  |  |
| `updated_by` | text |  |  |
| `name` | text | yes |  |
| `is_default` | true or false | yes | default false |

### `batches`

Kind: belongs to a business. In a business export.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `org_id` | id (text) | yes | refers to `organisations` |
| `business_id` | id (text) | yes | refers to `businesses` |
| `version` | integer | yes | default 1 |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `created_by` | text |  |  |
| `updated_by` | text |  |  |
| `item_id` | id (text) | yes | refers to `items` |
| `batch_no` | text | yes |  |
| `mfg_date` | date (`YYYY-MM-DD`) |  |  |
| `expiry_date` | date (`YYYY-MM-DD`) |  |  |

### `stock_movements`

Stock in and out, one row each. An item's stock is the sum of its movements.

Kind: belongs to a business. In a business export.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `org_id` | id (text) | yes | refers to `organisations` |
| `business_id` | id (text) | yes | refers to `businesses` |
| `version` | integer | yes | default 1 |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `created_by` | text |  |  |
| `updated_by` | text |  |  |
| `item_id` | id (text) | yes | refers to `items` |
| `variant_id` | id (text) |  | refers to `item_variants` |
| `godown_id` | id (text) |  | refers to `godowns` |
| `batch_id` | id (text) |  | refers to `batches` |
| `kind` | text | yes | one of `in`, `out`, `adjust`, `transfer` |
| `qty_micros` | integer (paise, micro-units or a count) | yes |  |
| `rate_paise` | integer (paise, micro-units or a count) |  |  |
| `document_id` | id (text) |  | refers to `documents` |
| `date` | date (`YYYY-MM-DD`) | yes |  |
| `note` | text |  |  |

### `templates`

Kind: belongs to a business. In a business export.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `org_id` | id (text) | yes | refers to `organisations` |
| `business_id` | id (text) | yes | refers to `businesses` |
| `version` | integer | yes | default 1 |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `created_by` | text |  |  |
| `updated_by` | text |  |  |
| `name` | text | yes |  |
| `kind` | text | yes | default "document" |
| `config_json` | JSON |  |  |
| `is_default` | true or false | yes | default false |

### `attachments`

File names and hashes. The files themselves are in the `attachments` folder of a backup or CSV bundle.

Kind: belongs to a business. In a business export.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `org_id` | id (text) | yes | refers to `organisations` |
| `business_id` | id (text) | yes | refers to `businesses` |
| `version` | integer | yes | default 1 |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `created_by` | text |  |  |
| `updated_by` | text |  |  |
| `owner_table` | text | yes |  |
| `owner_id` | id (text) | yes |  |
| `file_name` | text | yes |  |
| `mime` | text |  |  |
| `size_bytes` | integer (paise, micro-units or a count) | yes | default 0 |
| `sha256` | text | yes |  |
| `storage_path` | text | yes |  |

### `review_items`

Kind: belongs to a business. In a business export.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `org_id` | id (text) | yes | refers to `organisations` |
| `business_id` | id (text) | yes | refers to `businesses` |
| `version` | integer | yes | default 1 |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `created_by` | text |  |  |
| `updated_by` | text |  |  |
| `kind` | text | yes |  |
| `status` | text | yes | one of `pending`, `accepted`, `rejected`, `expired`; default "pending" |
| `payload_json` | JSON |  |  |
| `suggestion_json` | JSON |  |  |
| `diff_json` | JSON |  |  |
| `correction_json` | JSON |  |  |
| `source` | text |  |  |
| `model` | text |  |  |
| `confidence` | integer |  |  |
| `accepted_by` | text |  |  |
| `accepted_at` | time (epoch milliseconds) |  |  |
| `snoozed_until` | time (epoch milliseconds) |  |  |
| `reject_reason` | text |  |  |
| `dedupe_key` | text |  |  |

### `ai_calls`

A log of assistant requests. Not in a business export.

Kind: belongs to a business. In a backup only.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `org_id` | id (text) | yes | refers to `organisations` |
| `business_id` | id (text) | yes | refers to `businesses` |
| `created_at` | time (epoch milliseconds) | yes |  |
| `feature` | text | yes |  |
| `capability` | text | yes |  |
| `provider` | text | yes |  |
| `model` | text |  |  |
| `input_tokens` | integer |  |  |
| `output_tokens` | integer |  |  |
| `latency_ms` | integer | yes | default 0 |
| `outcome` | text | yes |  |

### `audit_log`

Who changed what, and when. In a backup; in a business export only when asked for.

Kind: belongs to a business. In a backup only.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `org_id` | id (text) | yes | refers to `organisations` |
| `business_id` | id (text) | yes | refers to `businesses` |
| `created_at` | time (epoch milliseconds) | yes |  |
| `table_name` | text | yes |  |
| `row_id` | id (text) | yes |  |
| `action` | text | yes | one of `insert`, `update`, `soft_delete`, `purge` |
| `before_json` | JSON |  |  |
| `after_json` | JSON |  |  |
| `actor` | text | yes |  |
| `device_id` | text |  |  |
| `at` | time (epoch milliseconds) | yes |  |

### `import_mappings`

Kind: belongs to a business. In a business export.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `org_id` | id (text) | yes | refers to `organisations` |
| `business_id` | id (text) | yes | refers to `businesses` |
| `version` | integer | yes | default 1 |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `created_by` | text |  |  |
| `updated_by` | text |  |  |
| `entity` | text | yes | one of `items`, `parties` |
| `signature` | text | yes |  |
| `mapping_json` | JSON |  |  |

### `settings`

Settings by key. Rows whose key marks a secret (tokens, credentials, PINs) are never exported.

Kind: belongs to a business. In a business export.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `org_id` | id (text) | yes | refers to `organisations` |
| `business_id` | id (text) | yes | refers to `businesses` |
| `version` | integer | yes | default 1 |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `created_by` | text |  |  |
| `updated_by` | text |  |  |
| `key` | text | yes |  |
| `value_json` | JSON |  |  |
| `scope` | text | yes | one of `business`, `org`, `user`, `device`; default "business" |

### `sync_state`

Sync bookkeeping. Not in a business export.

Kind: belongs to an organisation. In a backup only.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | id (text) | yes |  |
| `org_id` | id (text) | yes | refers to `organisations` |
| `version` | integer | yes | default 1 |
| `created_at` | time (epoch milliseconds) | yes |  |
| `updated_at` | time (epoch milliseconds) | yes |  |
| `deleted_at` | time (epoch milliseconds) |  |  |
| `created_by` | text |  |  |
| `updated_by` | text |  |  |
| `device_id` | id (text) |  |  |
| `cursor` | text |  |  |
| `last_synced_at` | time (epoch milliseconds) |  |  |
