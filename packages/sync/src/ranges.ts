/**
 * Numbers for working offline (FR-044). While connected, a device keeps a block of numbers of each series
 * it issues from: when what is left of its block runs low it asks the server for the next block. Offline
 * it issues from the block; with the block gone it issues provisional numbers that the server replaces.
 */
import { NumberingRepo, type Ctx, type Database } from '@gst/db';

import type { SyncConnector } from './connector';

export interface RangePolicy {
  /** Ask for more when fewer than this many are left. */
  low: number;
  /** How many to ask for. */
  size: number;
  /** The document types this device issues. */
  types: readonly string[];
}

export const DEFAULT_RANGE_POLICY: RangePolicy = {
  low: 10,
  size: 50,
  types: ['tax_invoice', 'bill_of_supply', 'credit_note', 'debit_note', 'delivery_challan'],
};

/**
 * Make sure this device holds enough numbers of each type it issues, in the default series for the date's
 * year. The server makes the series and the year's counter if they are missing, so two devices never
 * invent two "default" series. Returns the ranges asked for.
 */
export async function ensureRanges(
  database: Database,
  ctx: Ctx,
  connector: SyncConnector,
  date: string,
  policy: RangePolicy = DEFAULT_RANGE_POLICY,
): Promise<{ documentType: string; from: number; to: number }[]> {
  const n = new NumberingRepo(database);
  const asked: { documentType: string; from: number; to: number }[] = [];
  for (const type of policy.types) {
    let left = 0;
    for (const s of await n.listSeries(ctx, type)) {
      for (const r of await n.listRanges(ctx, s.key))
        if (r['device_id'] === ctx.deviceId && r['status'] === 'active')
          left += Number(r['to_number']) - Number(r['from_number']) + 1 - Number(r['used']);
    }
    if (left >= policy.low) continue;
    const r = await connector.reserveRange({
      businessId: ctx.businessId,
      documentType: type,
      date,
      size: policy.size,
    });
    asked.push({ documentType: type, from: r.from, to: r.to });
  }
  return asked;
}
