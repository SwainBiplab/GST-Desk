import { Button } from '@gst/ui';
import { useTranslation } from 'react-i18next';
import { useRegisterSW } from 'virtual:pwa-register/react';

/** Shown when a new service worker is waiting. The app never reloads itself under the user. */
export function UpdateBar() {
  const { t } = useTranslation();
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();
  if (!needRefresh) return null;
  return (
    <div
      role="status"
      data-testid="update-bar"
      className="fixed inset-x-0 bottom-0 z-(--z-toast) flex items-center justify-center gap-3 bg-info p-2 text-info-fg"
    >
      <span>{t('update.available')}</span>
      <Button variant="outline" onClick={() => void updateServiceWorker(true)}>
        {t('update.reload')}
      </Button>
      <Button variant="ghost" onClick={() => setNeedRefresh(false)} className="text-info-fg">
        {t('update.later')}
      </Button>
    </div>
  );
}
