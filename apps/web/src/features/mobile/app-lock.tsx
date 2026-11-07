/**
 * The app lock (prompt 43): when on, the screen is covered whenever the app comes to the foreground
 * until the person proves it is them with the phone's biometrics or PIN. Only the phone app has it.
 */
import { Button } from '@gst/ui';
import { Lock } from '@gst/ui/icons';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { onForeground } from '@/platform/app';
import { readAppLock, unlock } from '@/platform/biometrics';

export function AppLock() {
  const { t } = useTranslation();
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);

  const tryUnlock = async () => {
    setBusy(true);
    try {
      if (await unlock(t('mobile.lock.reason'))) setLocked(false);
    } finally {
      setBusy(false);
    }
  };

  const off = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    void readAppLock().then((on) => {
      if (!on) return;
      setLocked(true);
      void tryUnlock();
      void onForeground((active) => {
        if (active) {
          setLocked(true);
          void tryUnlock();
        }
      }).then((o) => (off.current = o));
    });
    return () => void off.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!locked) return null;
  return (
    <div
      className="fixed inset-0 z-(--z-toast) flex flex-col items-center justify-center gap-4 bg-bg"
      data-testid="app-lock"
    >
      <Lock size={40} aria-hidden />
      <p className="text-lg font-medium">{t('mobile.lock.title')}</p>
      <Button className="min-h-12 px-6" disabled={busy} onClick={() => void tryUnlock()}>
        {t('mobile.lock.unlock')}
      </Button>
    </div>
  );
}
