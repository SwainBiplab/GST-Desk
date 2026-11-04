import { useBlocker } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirm } from './components/confirm';

/**
 * Warn before leaving a form with unsaved changes: in-app navigation shows a confirm dialog and a
 * tab close or reload shows the browser's own prompt.
 */
export function useUnsavedGuard(dirty: boolean): void {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: () => dirty,
    withResolver: true,
  });

  useEffect(() => {
    if (blocker.status !== 'blocked') return;
    void confirm({
      title: t('unsaved.title'),
      description: t('unsaved.body'),
      confirmLabel: t('unsaved.leave'),
      cancelLabel: t('unsaved.stay'),
    }).then((leave) => (leave ? blocker.proceed() : blocker.reset()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocker.status]);
}
