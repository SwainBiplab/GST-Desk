import { PartyRepo, type Row } from '@gst/db';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  Button,
  RadioGroup,
  RadioGroupItem,
  toast,
} from '@gst/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAppDb } from '@/app/db';

/** Pick which of two parties to keep, merge, and offer an undo for the rest of the session. */
export function MergeDialog({ parties, onClose }: { parties: [Row, Row]; onClose: () => void }) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const [keep, setKeep] = useState(parties[0]['id'] as string);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!database || !ctx) return;
    const target = parties.find((p) => p['id'] === keep)!;
    const source = parties.find((p) => p['id'] !== keep)!;
    const repo = new PartyRepo(database);
    setBusy(true);
    try {
      const record = await repo.merge(ctx, source['id'], target['id']);
      toast(t('parties.merge.done', { source: source['name'], target: target['name'] }), {
        duration: 20_000,
        action: {
          label: t('parties.merge.undo'),
          onClick: () => {
            void repo
              .undoMerge(ctx, record)
              .then(() => toast.success(t('parties.merge.undone')))
              .catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)));
          },
        },
      });
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent data-testid="merge-dialog" className="w-[min(34rem,calc(100vw-2rem))]">
        <AlertDialogTitle className="text-lg font-semibold">
          {t('parties.merge.title')}
        </AlertDialogTitle>
        <AlertDialogDescription className="py-1 text-fg-muted">
          {t('parties.merge.body')}
        </AlertDialogDescription>
        <RadioGroup
          value={keep}
          onValueChange={setKeep}
          aria-label={t('parties.merge.keep')}
          className="flex flex-col gap-2 py-2"
        >
          {parties.map((p) => (
            <label
              key={p['id']}
              htmlFor={`keep-${p['id']}`}
              className="flex items-start gap-3 rounded-md border border-border p-2"
            >
              <RadioGroupItem id={`keep-${p['id']}`} value={p['id']} />
              <span>
                <span className="block font-medium">{p['name']}</span>
                <span className="block text-xs text-fg-muted">
                  {[p['gstin'], p['phone'], p['city']].filter(Boolean).join(' | ')}
                </span>
              </span>
            </label>
          ))}
        </RadioGroup>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('parties.form.cancel')}
          </Button>
          <Button disabled={busy} onClick={() => void run()} data-testid="confirm-merge">
            {t('parties.merge.confirm')}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
