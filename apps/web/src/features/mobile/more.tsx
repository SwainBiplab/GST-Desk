/**
 * The More tab (prompt 43): the account and sync, the pages that are not tabs, the app lock, the
 * Bluetooth printer, the full settings, and (in a browser) the way back to the desktop layout.
 */
import { Button, Card, Switch, toast } from '@gst/ui';
import { ChevronRight } from '@gst/ui/icons';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { MORE_PAGES } from './logic';

import { useAppDb } from '@/app/db';
import { useAppNavigate } from '@/app/hooks';
import { readSession } from '@/features/cloud/client';
import { pillState, useSyncStatus } from '@/features/sync/status';
import { pageAllowed, usePermissions } from '@/features/team/permissions';
import { browserStore } from '@/features/team/source';
import { dyn } from '@/lib/dyn-key';
import { isNativeApp, setMobileLayout } from '@/platform';
import { appLockAvailable, readAppLock, writeAppLock } from '@/platform/biometrics';
import {
  btPrintingSupported,
  choosePrinter,
  chosenPrinter,
  pairedPrinters,
  type PairedPrinter,
} from '@/platform/printer';

declare const __APP_VERSION__: string;

export function MobileMore() {
  const { t } = useTranslation();
  const navigate = useAppNavigate();
  const { cloudBook, business } = useAppDb();
  const { perms } = usePermissions();
  const session = readSession(browserStore.get);
  const sync = useSyncStatus();
  const [lockAvailable, setLockAvailable] = useState(false);
  const [lock, setLock] = useState(false);
  const [printers, setPrinters] = useState<PairedPrinter[]>([]);
  const [printer, setPrinter] = useState<PairedPrinter | null>(null);

  useEffect(() => {
    void appLockAvailable().then(setLockAvailable);
    void readAppLock().then(setLock);
    void chosenPrinter().then(setPrinter);
  }, []);

  const pill = pillState(cloudBook ? 'synced' : 'local', sync, 0);
  const row = (label: string, onClick: () => void, testId: string) => (
    <button
      type="button"
      className="flex min-h-12 w-full items-center justify-between px-3 text-left text-sm"
      data-testid={testId}
      onClick={onClick}
    >
      {label}
      <ChevronRight size={18} aria-hidden className="text-fg-muted" />
    </button>
  );

  return (
    <div className="flex flex-col gap-3" data-testid="mobile-more">
      <Card className="p-3">
        <h2 className="text-sm font-medium">{t('mobile.more.account')}</h2>
        <p className="text-sm text-fg-muted" data-testid="more-account-state">
          {session
            ? cloudBook
              ? t('mobile.more.syncingBusiness', {
                  name: cloudBook.businessName,
                  org: cloudBook.orgName,
                })
              : t('mobile.more.signedInAs', { who: session.email })
            : t('mobile.more.signedOut')}
        </p>
        {cloudBook && (
          <p className="text-xs text-fg-muted" data-testid="more-sync-state">
            {t(dyn(`sync.pill.${pill.kind}`), pill.count ? { count: pill.count } : {})}
          </p>
        )}
        <Button
          variant="secondary"
          className="mt-2 min-h-12 w-full"
          data-testid="more-open-account"
          onClick={() => navigate('/shop/settings', { screen: 'account' })}
        >
          {t('mobile.more.openAccount')}
        </Button>
      </Card>

      <Card className="divide-y divide-border p-0">
        {MORE_PAGES.filter((p) => pageAllowed(p, perms)).map((p) =>
          row(
            t(dyn(`nav.${p}`)),
            () => navigate(`/shop/${p}`, p === 'settings' ? { full: '1' } : {}),
            `more-${p}`,
          ),
        )}
      </Card>

      {(lockAvailable || btPrintingSupported()) && (
        <Card className="flex flex-col gap-3 p-3">
          {lockAvailable && (
            <label className="flex items-center justify-between text-sm" htmlFor="more-lock">
              <span>
                {t('mobile.more.appLock')}
                <span className="block text-xs text-fg-muted">{t('mobile.more.appLockHelp')}</span>
              </span>
              <Switch
                id="more-lock"
                data-testid="more-lock"
                checked={lock}
                onCheckedChange={(v) => {
                  setLock(v);
                  void writeAppLock(v);
                }}
              />
            </label>
          )}
          {btPrintingSupported() && (
            <div className="text-sm">
              <div className="flex items-center justify-between">
                <span>
                  {t('mobile.more.printer')}
                  <span className="block text-xs text-fg-muted">
                    {printer ? printer.name : t('mobile.more.noPrinter')}
                  </span>
                </span>
                <Button
                  variant="outline"
                  data-testid="more-printers"
                  onClick={() =>
                    void pairedPrinters().then((list) => {
                      setPrinters(list);
                      if (list.length === 0) toast.info(t('mobile.more.noPrinters'));
                    })
                  }
                >
                  {t('mobile.more.choosePrinter')}
                </Button>
              </div>
              {printers.length > 0 && (
                <ul className="pt-2">
                  {printers.map((p) => (
                    <li key={p.address}>
                      <button
                        type="button"
                        className="min-h-11 w-full text-left"
                        onClick={() => {
                          setPrinter(p);
                          setPrinters([]);
                          void choosePrinter(p);
                        }}
                      >
                        {p.name} <span className="text-xs text-fg-muted">{p.address}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Card>
      )}

      {!isNativeApp() && (
        <Button
          variant="ghost"
          data-testid="more-desktop-layout"
          onClick={() => {
            setMobileLayout(false);
            window.location.reload();
          }}
        >
          {t('mobile.more.desktopLayout')}
        </Button>
      )}
      <p className="text-center text-xs text-fg-muted">
        {t('mobile.more.version', { version: __APP_VERSION__ })}
        {business ? ` · ${String(business['legal_name'])}` : ''}
      </p>
    </div>
  );
}
