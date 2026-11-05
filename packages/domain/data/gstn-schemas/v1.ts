/**
 * GSTN offline-tool JSON layout, version "v1".
 *
 * STATUS: reconstructed, NOT verified. The GST Network does not publish a machine-readable schema for
 * the GSTR-1 and GSTR-3B upload files that we could download and check against. These key names, codes
 * and limits come from the structure widely documented for the offline tool and the returns. Before a
 * real filing, a chartered accountant must load an export into the offline tool and confirm it opens
 * without errors (acceptance criterion of prompt 30; see docs/compliance/gstr-review.md). Where the
 * tool rejects something, fix it HERE and add a golden-fixture test; no builder needs to change.
 *
 * To add a version, see README.md in this folder.
 */
export interface GstnSchema {
  /** Stored with every export so a file can be traced to the layout that produced it. */
  version: string;
  verified: boolean;
  /** Return period key in the JSON ("fp" / "ret_period"): MMYYYY. */
  periodFormat: 'MMYYYY';
  /** Dates inside the file: DD-MM-YYYY. */
  dateFormat: 'DD-MM-YYYY';
  /** Largest invoice value to an unregistered inter-state buyer that stays in B2CS, in paise. */
  b2clLimitPaise: number;
  /** Invoice types ("inv_typ") of a B2B invoice. */
  invoiceTypes: {
    regular: string;
    sezWithPay: string;
    sezWithoutPay: string;
    deemedExport: string;
  };
  noteTypes: { credit: string; debit: string };
  /** Table 8 supply types ("sply_ty"). */
  nilTypes: { interB2B: string; intraB2B: string; interB2C: string; intraB2C: string };
  /** Export types ("exp_typ") and unregistered-note types ("typ"). */
  exportTypes: { withPay: string; withoutPay: string };
  urTypes: { b2cl: string; exportWithPay: string; exportWithoutPay: string };
  /** Table 13 document nature codes ("doc_num"). */
  docNature: Record<string, { code: number; label: string }>;
  /** Top-level keys a GSTR-1 file may carry, and the ones every file must carry. */
  gstr1Keys: { required: string[]; optional: string[] };
  gstr3bKeys: { required: string[]; optional: string[] };
}

export const GSTN_V1: GstnSchema = {
  version: 'v1',
  verified: false,
  periodFormat: 'MMYYYY',
  dateFormat: 'DD-MM-YYYY',
  // INR 1,00,000 (the limit applies from 1 August 2024; it was INR 2,50,000 before)
  b2clLimitPaise: 100_000 * 100,
  invoiceTypes: { regular: 'R', sezWithPay: 'SEWP', sezWithoutPay: 'SEWOP', deemedExport: 'DE' },
  noteTypes: { credit: 'C', debit: 'D' },
  nilTypes: {
    interB2B: 'INTRB2B',
    intraB2B: 'INTRAB2B',
    interB2C: 'INTRB2C',
    intraB2C: 'INTRAB2C',
  },
  exportTypes: { withPay: 'WPAY', withoutPay: 'WOPAY' },
  urTypes: { b2cl: 'B2CL', exportWithPay: 'EXPWP', exportWithoutPay: 'EXPWOP' },
  docNature: {
    invoice: { code: 1, label: 'Invoices for outward supply' },
    debit_note: { code: 4, label: 'Debit Note' },
    credit_note: { code: 5, label: 'Credit Note' },
    receipt_voucher: { code: 6, label: 'Receipt Voucher' },
    delivery_challan: { code: 12, label: 'Others' },
  },
  gstr1Keys: {
    required: ['gstin', 'fp'],
    optional: [
      'gt',
      'cur_gt',
      'b2b',
      'b2cl',
      'b2cs',
      'cdnr',
      'cdnur',
      'exp',
      'nil',
      'hsn',
      'doc_issue',
    ],
  },
  gstr3bKeys: {
    required: ['gstin', 'ret_period', 'sup_details', 'inter_sup', 'itc_elg', 'inward_sup'],
    optional: ['intr_ltfee'],
  },
};
