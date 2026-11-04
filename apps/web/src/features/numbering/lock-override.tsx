import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Textarea } from '@gst/ui';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Ask an owner why a locked period is being changed. `ask(until)` resolves with the reason, or null
 * when they decline. Render `dialog` once in the page that calls it.
 */
export function useLockOverride(): {
  ask: (until: string) => Promise<string | null>;
  dialog: ReactNode;
} {
  const { t } = useTranslation();
  const [open, setOpen] = useState<{ until: string } | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState(false);
  const resolver = useRef<((reason: string | null) => void) | null>(null);

  const ask = useCallback(
    (until: string) =>
      new Promise<string | null>((resolve) => {
        resolver.current = resolve;
        setReason('');
        setError(false);
        setOpen({ until });
      }),
    [],
  );

  const finish = (value: string | null) => {
    resolver.current?.(value);
    resolver.current = null;
    setOpen(null);
  };

  const dialog = open && (
    <Dialog open onOpenChange={(o) => !o && finish(null)}>
      <DialogContent
        data-testid="lock-override"
        // opened by a click that is still finishing: only Escape or the buttons close it
        onInteractOutside={(e) => e.preventDefault()}
        onFocusOutside={(e) => e.preventDefault()}
      >
        <DialogTitle className="text-lg font-semibold">{t('lock.title')}</DialogTitle>
        <DialogDescription className="text-sm text-fg-muted">
          {t('lock.body', { until: open.until })}
        </DialogDescription>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('lock.reason')}
          <Textarea
            rows={3}
            data-testid="lock-reason"
            value={reason}
            aria-invalid={error}
            onChange={(e) => {
              setReason(e.target.value);
              setError(false);
            }}
          />
          {error && (
            <span role="alert" className="text-xs text-danger">
              {t('lock.reasonRequired')}
            </span>
          )}
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="outline" data-testid="lock-cancel" onClick={() => finish(null)}>
            {t('lock.cancel')}
          </Button>
          <Button
            data-testid="lock-confirm"
            onClick={() => {
              if (!reason.trim()) setError(true);
              else finish(reason.trim());
            }}
          >
            {t('lock.confirm')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
  return { ask, dialog };
}
