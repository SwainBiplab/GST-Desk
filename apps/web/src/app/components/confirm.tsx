import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@gst/ui';
import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { rememberFocus, restoreFocus } from '../focus';

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

type Confirm = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Confirm>(() => Promise.resolve(false));

/** `const confirm = useConfirm(); if (await confirm({ title: 'Delete?' })) ...` */
export const useConfirm = () => useContext(ConfirmContext);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback<Confirm>(
    (o) =>
      new Promise<boolean>((resolve) => {
        resolver.current?.(false);
        resolver.current = resolve;
        rememberFocus();
        setOpts(o);
      }),
    [],
  );

  const settle = (value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setOpts(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog open={opts !== null} onOpenChange={(o) => !o && settle(false)}>
        <AlertDialogContent data-testid="confirm-dialog" onCloseAutoFocus={restoreFocus}>
          <AlertDialogTitle className="text-lg font-semibold">{opts?.title}</AlertDialogTitle>
          <AlertDialogDescription className="py-2 text-fg-muted">
            {opts?.description}
          </AlertDialogDescription>
          <div className="flex justify-end gap-2 pt-2">
            <AlertDialogCancel onClick={() => settle(false)}>
              {opts?.cancelLabel ?? t('confirm.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => settle(true)}>
              {opts?.confirmLabel ?? t('confirm.yes')}
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}
