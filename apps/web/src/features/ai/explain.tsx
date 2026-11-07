/**
 * "Explain" on a reconciliation row (prompt 48): the cloud model says, in plain words, why the portal's entry
 * and the book's bill disagree and what to do. Shown only when cloud AI is on for the business; asks first when
 * the settings say so. Nothing is changed by it.
 */
import type { ReconRow } from '@gst/db';
import { Button, Dialog, DialogContent, DialogTitle, toast } from '@gst/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CloudError, type AiExplanation } from '../cloud/client';
import { useMessaging } from '../dispatch/use-messaging';

import { useAiSettings } from './settings';

import { useConfirm } from '@/app/components/confirm';
import { dyn } from '@/lib/dyn-key';

const errText = (e: unknown) =>
  e instanceof CloudError ? e.message : e instanceof Error ? e.message : String(e);

/** What the model is sent: the two sides and the classification, never ids of other rows. */
export const rowForModel = (row: ReconRow) => ({
  match: row.match,
  entry: row.entry,
  bill: row.bill,
  carried: row.carried,
  explanation: row.explanation,
});

export function ExplainButton({ row }: { row: ReconRow }) {
  const { t } = useTranslation();
  const settings = useAiSettings();
  const cloud = useMessaging();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AiExplanation | null>(null);
  const s = settings.data;
  if (!s?.cloud.enabled || s.cloud.mode !== 'gateway' || cloud.kind !== 'ready') return null;
  const m = cloud.m;
  const explain = async () => {
    if (
      s.cloud.askEachTime &&
      !(await confirm({ title: t('ai.cloud.askTitle'), description: t('ai.cloud.askBody') }))
    )
      return;
    setBusy(true);
    try {
      setResult(
        await m.client.aiExplainMismatch(m.orgId, {
          businessId: m.businessId,
          row: rowForModel(row),
        }),
      );
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        variant="ghost"
        disabled={busy}
        onClick={() => void explain()}
        data-testid="recon-explain"
      >
        {busy ? t('ai.explain.busy') : t('ai.explain.button')}
      </Button>
      {result && (
        <Dialog open onOpenChange={(o) => !o && setResult(null)}>
          <DialogContent data-testid="recon-explanation">
            <DialogTitle>{t('ai.explain.title')}</DialogTitle>
            <p className="text-sm">{result.explanation}</p>
            <p className="text-sm">
              <span className="font-medium">{t('ai.explain.cause')}</span>{' '}
              {t(dyn(`ai.explain.causes.${result.likelyCause}`))}
            </p>
            <p className="text-sm">
              <span className="font-medium">{t('ai.explain.next')}</span> {result.suggestedAction}
            </p>
            <p className="text-xs text-fg-muted">
              {t('ai.explain.footer', { model: result.model })}
              {result.quota.warning ? ` ${t('ai.cloud.quotaWarning')}` : ''}
            </p>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
