/**
 * The inbox card for a change waiting for approval (prompt 42): what was asked, by whom, and Approve or
 * Decline for someone whose role approves that module (the one who asked never can: they could not
 * approve it, or it would not have been held). The server holds the change, so the decision
 * goes to the cloud API; the result arrives back with the next sync.
 */
import type { ApprovalRequestItem } from '@gst/ai';
import { can, type Module } from '@gst/domain';
import { Button, toast } from '@gst/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { InboxRow } from '../inbox/model';

import { usePermissions } from './permissions';
import { browserStore } from './source';

import { useAppDb } from '@/app/db';
import { CloudClient, CloudError, readSession } from '@/features/cloud/client';
import { dyn } from '@/lib/dyn-key';

export function ApprovalDetail({ row }: { row: InboxRow }) {
  const { t } = useTranslation();
  const { ctx } = useAppDb();
  const { perms } = usePermissions();
  const v = row.suggestion as unknown as ApprovalRequestItem;
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const mayApprove = can(perms, v.module as Module, 'approve');

  const decide = async (decision: 'approve' | 'decline') => {
    const session = readSession(browserStore.get);
    if (!session || !ctx?.orgId) {
      toast.error(t('team.approval.signIn'));
      return;
    }
    setBusy(true);
    try {
      const r = await new CloudClient(session.baseUrl, session.token).decideApproval(
        ctx.orgId,
        row.id,
        decision,
      );
      setDone(r.outcome);
      if (r.outcome === 'approved' || r.outcome === 'declined')
        toast.success(t(dyn(`team.approval.${r.outcome}`)));
      else toast.error(t(dyn(`team.approval.${r.outcome}`), { reason: r.reason ?? '' }));
    } catch (e) {
      toast.error(e instanceof CloudError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="py-2" data-testid="approval-detail">
      <p className="text-sm">{v.reason}</p>
      <p className="pt-1 text-xs text-fg-muted">
        {t(dyn(`team.approval.change.${v.change}`), { label: v.label })}
      </p>
      {done ? (
        <p className="pt-2 text-sm" data-testid="approval-done">
          {t(dyn(`team.approval.${done}`), { reason: '' })}
        </p>
      ) : mayApprove ? (
        <div className="flex gap-2 pt-3">
          <Button
            data-testid="approval-approve"
            disabled={busy}
            onClick={() => void decide('approve')}
          >
            {t('team.approval.approve')}
          </Button>
          <Button
            variant="secondary"
            data-testid="approval-decline"
            disabled={busy}
            onClick={() => void decide('decline')}
          >
            {t('team.approval.decline')}
          </Button>
        </div>
      ) : (
        <p className="pt-2 text-sm text-fg-muted" data-testid="approval-waiting">
          {t('team.approval.waiting')}
        </p>
      )}
    </div>
  );
}
