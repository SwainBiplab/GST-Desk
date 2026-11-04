import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Textarea } from '@gst/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Cancel an issued document with a reason. Says what a cancellation does, and that a credit note is
 * the better path once the document has been shared.
 */
export function CancelDialog({
  number,
  busy,
  canCreditNote,
  onConfirm,
  onCreditNote,
  onClose,
}: {
  number: string;
  busy: boolean;
  canCreditNote: boolean;
  onConfirm: (reason: string) => void;
  onCreditNote: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [error, setError] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="cancel-dialog">
        <DialogTitle className="text-lg font-semibold">
          {t('docs.cancel.title', { number })}
        </DialogTitle>
        <DialogDescription className="text-sm text-fg-muted">
          {t('docs.cancel.explain')}
        </DialogDescription>
        <p
          className="rounded-md border border-border bg-surface-1 p-3 text-sm"
          data-testid="cancel-credit-hint"
        >
          {t('docs.cancel.creditNote')}
        </p>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('docs.cancel.reason')}
          <Textarea
            rows={3}
            data-testid="cancel-reason"
            value={reason}
            aria-invalid={error}
            onChange={(e) => {
              setReason(e.target.value);
              setError(false);
            }}
          />
          {error && (
            <span role="alert" className="text-xs text-danger" data-testid="cancel-reason-error">
              {t('docs.cancel.reasonRequired')}
            </span>
          )}
        </label>
        <div className="flex flex-wrap justify-end gap-2">
          {canCreditNote && (
            <Button variant="outline" data-testid="cancel-use-credit-note" onClick={onCreditNote}>
              {t('docs.cancel.useCreditNote')}
            </Button>
          )}
          <Button variant="outline" data-testid="cancel-keep" onClick={onClose}>
            {t('docs.cancel.keep')}
          </Button>
          <Button
            variant="danger"
            data-testid="cancel-confirm"
            disabled={busy}
            onClick={() => {
              if (!reason.trim()) setError(true);
              else onConfirm(reason.trim());
            }}
          >
            {t('docs.cancel.confirm')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
