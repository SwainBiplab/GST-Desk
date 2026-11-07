/**
 * The server's check on an uploaded document: rebuild it with the tax engine from what the rows say
 * (rates, quantities, discounts, place of supply) and compare every money field the device sent. A
 * device cannot change a total, a head of tax or a line amount without the engine agreeing.
 */
import { draftFromRows, draftToRows } from '@gst/domain';

import type { Row } from '../schema';

const DOC_MONEY = [
  'total_taxable_paise',
  'total_cgst_paise',
  'total_sgst_paise',
  'total_igst_paise',
  'total_utgst_paise',
  'total_cess_paise',
  'tcs_paise',
  'tds_paise',
  'round_off_paise',
  'total_paise',
] as const;

const LINE_MONEY = [
  'taxable_paise',
  'cgst_paise',
  'sgst_paise',
  'igst_paise',
  'utgst_paise',
  'cess_paise',
  'total_paise',
] as const;

/** Every money field that differs from the engine's, as `field: sent, expected` lines. Empty when it agrees. */
export function recomputeErrors(doc: Row, lines: readonly Row[]): string[] {
  const ordered = [...lines]
    .filter((l) => l['deleted_at'] == null)
    .sort((a, b) => Number(a['line_no']) - Number(b['line_no']));
  let n = 0;
  const draft = draftFromRows(doc, ordered, () => `k${n++}`);
  const rebuilt = draftToRows(draft);
  const errors: string[] = [];
  const doc2 = rebuilt.doc as unknown as Record<string, unknown>;
  for (const f of DOC_MONEY) {
    if (Number(doc[f] ?? 0) !== Number(doc2[f] ?? 0))
      errors.push(`document ${f}: sent ${doc[f] ?? 0}, expected ${doc2[f] ?? 0}`);
  }
  if (rebuilt.lines.length !== ordered.length) {
    errors.push(`document has ${ordered.length} lines, the engine prices ${rebuilt.lines.length}`);
    return errors;
  }
  rebuilt.lines.forEach((l, i) => {
    const sent = ordered[i]!;
    const want = l as unknown as Record<string, unknown>;
    for (const f of LINE_MONEY) {
      if (Number(sent[f] ?? 0) !== Number(want[f] ?? 0))
        errors.push(`line ${sent['line_no']} ${f}: sent ${sent[f] ?? 0}, expected ${want[f] ?? 0}`);
    }
  });
  return errors;
}
