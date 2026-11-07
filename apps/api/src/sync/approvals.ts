/**
 * Approvals (prompt 42). A cancellation or a revision held by the organisation's policy waits as an
 * `approval_request` inbox item that carries the whole transaction. An approver lets it through: it is
 * applied as the person who made it (their role is checked again, now), with the gate passed and the
 * approver on the audit trail. Turning it down closes the item; the device already holds the server's
 * version again, because a held transaction is sent back like a conflict.
 */
import { runInTx, writeAudit, type Ctx, type Row } from '@gst/db';
import { can, type Module } from '@gst/domain';
import { and, eq, sql } from 'drizzle-orm';

import { membershipOf, type Membership } from '../auth/permissions';
import type { PgDatabase } from '../db/pool';
import { ApiError, forbidden, notFound } from '../errors';

import {
  Conflict,
  Rejected,
  applyOps,
  raiseConflict,
  type ClientTx,
  type SyncCaller,
} from './apply';

export interface ApprovalSuggestion {
  table: string;
  rowId: string;
  module: Module;
  change: 'cancel' | 'revise';
  label: string;
  reason: string;
  ops: ClientTx['ops'];
  deviceId: string;
  txId: number;
  byUser: string;
}

export type ApprovalResult =
  | { outcome: 'approved' }
  | { outcome: 'declined' }
  | { outcome: 'conflict'; reviewItemId: string; reason: string }
  | { outcome: 'refused'; reason: string };

async function loadItem(d: PgDatabase, orgId: string, id: string): Promise<Row> {
  const [row] = await d.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    return tx`SELECT * FROM review_items WHERE id = ${id} AND org_id = ${orgId} AND kind = 'approval_request'`;
  });
  if (!row) throw notFound('That approval request');
  return row as Row;
}

async function close(
  d: PgDatabase,
  tx: any,
  id: string,
  status: 'accepted' | 'rejected',
  by: string,
  reason?: string,
) {
  const t = d.schema.review_items;
  const now = Date.now();
  await tx
    .update(t)
    .set({
      status,
      accepted_by: by,
      accepted_at: now,
      reject_reason: reason ?? null,
      updated_at: now,
      updated_by: by,
      version: sql`${t.version} + 1`,
    })
    .where(and(eq(t.id, id), eq(t.status, 'pending')));
}

export async function decideApproval(
  d: PgDatabase,
  approver: Membership & { userId: string },
  itemId: string,
  decision: 'approve' | 'decline',
  note?: string,
): Promise<ApprovalResult> {
  const item = await loadItem(d, approver.id, itemId);
  // only the server raises these (the sync write path refuses them from devices)
  if (item['created_by'] !== 'system:sync') throw notFound('That approval request');
  if (item['status'] !== 'pending')
    throw new ApiError(409, 'decided', 'That request has already been decided.');
  const s = item['suggestion_json'] as ApprovalSuggestion;
  if (!can(approver.perms, s.module, 'approve'))
    throw forbidden(`Your role cannot approve changes to ${s.module}.`);
  if (s.byUser === approver.userId)
    throw forbidden('A change you asked for needs someone else to approve it.');
  const businessId = String(item['business_id']);
  const ctx: Ctx = {
    orgId: approver.id,
    businessId,
    actor: approver.userId,
    deviceId: 'api',
  };

  if (decision === 'decline') {
    await runInTx(d, ctx, async (tx) => {
      await close(d, tx, itemId, 'rejected', approver.userId, note);
      await writeAudit(d, tx, { ...ctx, tx }, 'review_items', itemId, 'update', null, {
        approval: 'declined',
        change: s.change,
        row: s.rowId,
        note: note ?? null,
      });
    });
    return { outcome: 'declined' };
  }

  // the person who asked must still be allowed to make the change, apart from the approval itself
  const requester = await membershipOf(d, s.byUser, approver.id);
  if (!requester) return refuse(d, ctx, itemId, approver.userId, 'they are no longer a member');
  const caller: SyncCaller = {
    orgId: approver.id,
    userId: s.byUser,
    deviceId: s.deviceId,
    perms: requester.perms,
    policy: requester.policy,
    approvedBy: approver.userId,
  };
  const tx0: ClientTx = { txId: s.txId, ops: s.ops };
  const asRequester: Ctx = { ...ctx, actor: s.byUser, deviceId: s.deviceId };
  try {
    await runInTx(
      d,
      asRequester,
      async (tx) => {
        await applyOps(d, tx, asRequester, caller, tx0);
        await close(d, tx, itemId, 'accepted', approver.userId, note);
        await writeAudit(d, tx, { ...ctx, tx }, s.table, s.rowId, 'update', null, {
          approval: 'approved',
          change: s.change,
          asked_by: s.byUser,
          note: note ?? null,
        });
      },
      { allowNoBusiness: true },
    );
    return { outcome: 'approved' };
  } catch (e) {
    if (e instanceof Conflict) {
      // someone changed the document since it was asked: the two versions go to the inbox instead
      const id = await raiseConflict(d, asRequester, caller, tx0, e);
      await runInTx(d, ctx, (tx) =>
        close(d, tx, itemId, 'rejected', approver.userId, 'changed since; see the conflict'),
      );
      return { outcome: 'conflict', reviewItemId: id, reason: e.message };
    }
    if (e instanceof Rejected) return refuse(d, ctx, itemId, approver.userId, e.message);
    throw e;
  }
}

async function refuse(
  d: PgDatabase,
  ctx: Ctx,
  itemId: string,
  by: string,
  reason: string,
): Promise<ApprovalResult> {
  await runInTx(d, ctx, (tx) => close(d, tx, itemId, 'rejected', by, `cannot apply: ${reason}`));
  return { outcome: 'refused', reason };
}
