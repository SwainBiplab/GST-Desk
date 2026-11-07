/**
 * The CA's board (prompt 46): every business of every organisation the signed-in account belongs to, and every
 * business shared with it (prompt 47), one row each,
 * a cell per period and return (filed, saved on the portal, exported, late, not yet due), and the exceptions that
 * need a look: overdue returns, problems waiting before a return can go, and input credit not yet reconciled.
 * Only organisations where the caller's role may view GST returns are read, and each is read under its own
 * row-level security. Late fees are estimates (see `@gst/domain` filing rules).
 */
import { Gstr2bRepo, GstrRepo, SettingsRepo, type Ctx, type Row } from '@gst/db';
import {
  addDaysIso,
  can,
  dueDate,
  lateFee,
  monthPeriod,
  periodsBetween,
  total,
  type Return,
} from '@gst/domain';
import { istDate } from '@gst/messaging';

import { orgsOf } from '../auth/mirror';
import { membershipOf, inOrg, type Membership } from '../auth/permissions';
import type { PgDatabase } from '../db/pool';
import { sharesOf } from '../portals/access';

export type CellStatus = 'filed' | 'pushed' | 'exported' | 'late' | 'open';

export interface BoardCell {
  fp: string;
  ret: Return;
  status: CellStatus;
  due: string;
  overdueDays: number;
  /** An estimate in paise; 0 when not late. */
  lateFeePaise: number;
}

export interface BoardException {
  kind: 'overdue' | 'blockers' | 'itc';
  message: string;
  /** A number to sort by: days, problems, or paise. */
  amount: number;
}

export interface BoardRow {
  orgId: string;
  orgName: string;
  businessId: string;
  businessName: string;
  gstin: string;
  cells: BoardCell[];
  exceptions: BoardException[];
}

export const DEFAULT_ITC_THRESHOLD_PAISE = 1_000_000; // Rs 10,000
const PERIODS_SHOWN = 6;

/** One business's row: its cells over the last periods and the exceptions that need a look. */
export async function boardRow(
  db: PgDatabase,
  orgId: string,
  orgName: string,
  b: Row,
  now: number,
  ctx: Ctx,
  opts: { itcThresholdPaise?: number; fps?: Set<string> } = {},
): Promise<BoardRow> {
  const today = istDate(now);
  const threshold = opts.itcThresholdPaise ?? DEFAULT_ITC_THRESHOLD_PAISE;
  const gstin = String(b['gstin'] ?? '');
  const gr = new GstrRepo(db);
  const kindSetting = await new SettingsRepo(db).getValue<string>(ctx, 'gst.filing.kind');
  const kind = kindSetting === 'quarter' ? 'quarter' : 'month';
  const filings = await gr.listFilings(ctx);
  const periods = gstin
    ? periodsBetween(gstin, addDaysIso(today, -31 * (PERIODS_SHOWN + 2)), today, kind)
        .filter((p) => p.to < today)
        .slice(-PERIODS_SHOWN)
    : [];
  const cells: BoardCell[] = [];
  for (const p of periods) {
    opts.fps?.add(p.fp);
    for (const ret of ['gstr1', 'gstr3b'] as const) {
      const rec = filings.find((f) => f.returnType === ret && f.fp === p.fp);
      const due = dueDate(
        ret,
        p,
        String(b['state_code'] ?? gstin.slice(0, 2)),
        rec?.dueOverride ? { [`${ret}:${p.fp}`]: rec.dueOverride } : {},
      ).date;
      const filed = rec?.status === 'filed';
      const overdueDays =
        !filed && today > due ? Math.round((Date.parse(today) - Date.parse(due)) / 86_400_000) : 0;
      const status: CellStatus = filed
        ? 'filed'
        : overdueDays > 0
          ? 'late'
          : rec?.status === 'pushed'
            ? 'pushed'
            : rec?.status === 'exported'
              ? 'exported'
              : 'open';
      cells.push({
        fp: p.fp,
        ret,
        status,
        due,
        overdueDays,
        lateFeePaise:
          overdueDays > 0 ? Number(lateFee({ due, on: today, nil: false }).feePaise) : 0,
      });
    }
  }
  const exceptions: BoardException[] = [];
  const late = cells.filter((c) => c.status === 'late');
  if (late.length)
    exceptions.push({
      kind: 'overdue',
      message: `${late.length} return${late.length === 1 ? '' : 's'} overdue, the oldest by ${Math.max(...late.map((c) => c.overdueDays))} days`,
      amount: Math.max(...late.map((c) => c.overdueDays)),
    });
  const [bl] = await inOrg(
    db,
    orgId,
    (tx) =>
      tx`SELECT count(*)::int AS n FROM review_items WHERE kind = 'prefiling_issue' AND status = 'pending' AND business_id = ${String(b['id'])} AND deleted_at IS NULL`,
  );
  if (Number(bl?.['n'] ?? 0) > 0)
    exceptions.push({
      kind: 'blockers',
      message: `${bl!['n']} problems waiting before a return can go`,
      amount: Number(bl!['n']),
    });
  // credit not yet reconciled, for the latest month with a 2B imported
  if (gstin) {
    const imports = await new Gstr2bRepo(db).listImports(ctx);
    const latest = imports
      .map((i) => i.period)
      .sort((a, c) => (a.slice(2) + a.slice(0, 2)).localeCompare(c.slice(2) + c.slice(0, 2)))
      .at(-1);
    if (latest) {
      const ws = await new Gstr2bRepo(db).workspace(
        ctx,
        monthPeriod(gstin, Number(latest.slice(2)), Number(latest.slice(0, 2))),
      );
      const open =
        total(ws.summary.only2b) + total(ws.summary.toDefer) + total(ws.summary.toReverse);
      if (open >= threshold)
        exceptions.push({
          kind: 'itc',
          message: `Rs ${(open / 100).toLocaleString('en-IN')} of input credit not reconciled for ${latest}`,
          amount: open,
        });
    }
  }
  return {
    orgId,
    orgName,
    businessId: String(b['id']),
    businessName: String(b['trade_name'] || b['legal_name']),
    gstin,
    cells,
    exceptions,
  };
}

/**
 * Every business the account may see GST returns of: those of the organisations it belongs to, and those
 * shared with it by an owner (prompt 47) when the share includes the GST module.
 */
export async function filingBoard(
  db: PgDatabase,
  userId: string,
  now: number,
  opts: { itcThresholdPaise?: number } = {},
): Promise<{ rows: BoardRow[]; today: string; periods: string[] }> {
  const today = istDate(now);
  const rows: BoardRow[] = [];
  const fps = new Set<string>();
  const seen = new Set<string>();
  const rowOpts = { fps, ...(opts.itcThresholdPaise === undefined ? {} : opts) };
  for (const o of await orgsOf(db, userId)) {
    const m: Membership | null = await membershipOf(db, userId, o.id);
    if (!m || !can(m.perms, 'gst', 'view')) continue;
    const businesses = await inOrg(
      db,
      o.id,
      (tx) =>
        tx`SELECT id, trade_name, legal_name, gstin, state_code FROM businesses WHERE deleted_at IS NULL ORDER BY legal_name`,
    );
    for (const b of businesses) {
      if (!String(b['gstin'] ?? '')) continue;
      const ctx: Ctx = { orgId: o.id, businessId: String(b['id']), actor: userId, deviceId: 'api' };
      rows.push(await boardRow(db, o.id, o.name, b as Row, now, ctx, rowOpts));
      seen.add(String(b['id']));
    }
  }
  for (const s of await sharesOf(db, userId, now)) {
    if (!s.perms.gst || seen.has(s.businessId)) continue;
    const [b] = await inOrg(
      db,
      s.orgId,
      (tx) =>
        tx`SELECT id, trade_name, legal_name, gstin, state_code FROM businesses WHERE id = ${s.businessId} AND deleted_at IS NULL`,
    );
    if (!b || !String(b['gstin'] ?? '')) continue;
    const ctx: Ctx = { orgId: s.orgId, businessId: s.businessId, actor: userId, deviceId: 'api' };
    rows.push(await boardRow(db, s.orgId, s.orgName, b as Row, now, ctx, rowOpts));
    seen.add(s.businessId);
  }
  const ordered = [...fps].sort((a, b) =>
    (a.slice(2) + a.slice(0, 2)).localeCompare(b.slice(2) + b.slice(0, 2)),
  );
  return { rows, today, periods: ordered };
}
