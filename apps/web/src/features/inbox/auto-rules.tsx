import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@gst/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

const OFF = 'off';

/** The one automatic rule that exists: accept HSN suggestions that are very sure. Off until chosen. */
export function AutoRulesDialog(props: {
  value: number | null;
  onClose: () => void;
  onSave: (value: number | null) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [v, setV] = useState(props.value == null ? OFF : String(props.value));
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog open onOpenChange={(o) => !o && props.onClose()}>
      <AlertDialogContent data-testid="auto-dialog">
        <AlertDialogTitle>{t('inbox.auto.title')}</AlertDialogTitle>
        <AlertDialogDescription>{t('inbox.auto.body')}</AlertDialogDescription>
        <div className="flex items-center gap-2 py-3 text-sm">
          <span>{t('inbox.auto.hsn')}</span>
          <Select value={v} onValueChange={setV}>
            <SelectTrigger className="w-28" aria-label={t('inbox.auto.hsn')} data-testid="auto-hsn">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={OFF}>{t('inbox.auto.off')}</SelectItem>
              {[99, 95, 90].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n}%
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={props.onClose}>
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            data-testid="auto-save"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void props.onSave(v === OFF ? null : Number(v)).finally(() => setBusy(false));
            }}
          >
            OK
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
