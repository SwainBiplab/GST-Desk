import { pairingUri, type Device, type PairingOffer, type Role } from '@gst/lan';
import { qrMatrix } from '@gst/print';
import {
  Button,
  Card,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  toast,
} from '@gst/ui';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  LAN_ON_KEY,
  LAN_PORT_KEY,
  readLanPort,
  startLan,
  stopLan,
  useLanStatus,
  lanBridge,
} from './service';

import { useAppDb } from '@/app/db';
import { useFeatureFlags } from '@/features/business/hooks';

const ROLES: Role[] = ['full', 'counter', 'view'];

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage may be blocked */
    }
  },
};

function Qr({ data, label }: { data: string; label: string }) {
  const m = qrMatrix(data);
  const quiet = 2;
  const n = m.size + quiet * 2;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${n} ${n}`}
      className="h-44 w-44 rounded bg-white"
      shapeRendering="crispEdges"
    >
      {m.dark.map((on, i) =>
        on ? (
          <rect
            key={i}
            x={(i % m.size) + quiet}
            y={Math.floor(i / m.size) + quiet}
            width="1"
            height="1"
            fill="#000"
          />
        ) : null,
      )}
    </svg>
  );
}

/** Settings, Tablets and phones: switch it on, pair a device with a code, see and remove paired devices. */
export function LanTab() {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const flags = useFeatureFlags();
  const status = useLanStatus();
  const inventory = useRef(flags.inventory);
  useEffect(() => {
    inventory.current = flags.inventory;
  });
  const [port, setPort] = useState(() => String(readLanPort(store.get)));
  const [role, setRole] = useState<Role>('counter');
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [now, setNow] = useState(() => Date.now());

  // the list and the code's countdown refresh while the tab is open
  useEffect(() => {
    let alive = true;
    const tick = () => {
      setNow(Date.now());
      void lanBridge()
        ?.devices()
        .then((v) => alive && setDevices(v));
    };
    tick();
    const h = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [status.running]);

  const toggle = async (on: boolean) => {
    store.set(LAN_ON_KEY, on ? '1' : '0');
    if (!on) {
      setOffer(null);
      await stopLan();
      return;
    }
    if (!database || !ctx) return;
    const p = readLanPort((k) => (k === LAN_PORT_KEY ? port : null));
    store.set(LAN_PORT_KEY, String(p));
    await startLan(database, ctx, { port: p, inventoryEnabled: () => inventory.current });
  };

  const refresh = async () => setDevices((await lanBridge()?.devices()) ?? []);
  const act = async (fn: () => Promise<unknown> | undefined) => {
    try {
      await fn();
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const info = status.info;
  const host = info?.addresses[0] ?? 'gstdesk.local';
  const secondsLeft = offer ? Math.max(0, Math.round((offer.expiresAt - now) / 1000)) : 0;
  const live = offer && secondsLeft > 0 && info;
  const notBuilt = status.error?.startsWith('not_built');

  return (
    <div className="flex max-w-3xl flex-col gap-4" data-testid="lan-tab">
      <Card>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-medium">{t('lan.title')}</h2>
            <p className="text-sm text-fg-muted">{t('lan.intro')}</p>
          </div>
          <Switch
            checked={status.running}
            disabled={status.starting || !!notBuilt}
            onCheckedChange={(v) => void toggle(v)}
            aria-label={t('lan.title')}
            data-testid="lan-switch"
          />
        </div>
        {notBuilt && <p className="pt-2 text-sm text-fg-muted">{t('lan.notBuilt')}</p>}
        {status.error && !notBuilt && (
          <p role="alert" className="pt-2 text-sm text-danger">
            {t('lan.failed', { message: status.error })}
          </p>
        )}
        {!status.running && !notBuilt && (
          <div className="flex items-center gap-3 pt-3">
            <label className="text-sm" htmlFor="lan-port">
              {t('lan.port')}
            </label>
            <Input
              id="lan-port"
              className="w-28"
              inputMode="numeric"
              value={port}
              onChange={(e) => setPort(e.target.value)}
            />
          </div>
        )}
        {info && (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 pt-3 text-sm">
            <dt className="text-fg-muted">{t('lan.address')}</dt>
            <dd data-testid="lan-address">
              {info.addresses.map((a) => `https://${a}:${info.port}`).join('   ')}
            </dd>
            <dt className="text-fg-muted">{t('lan.fingerprint')}</dt>
            <dd className="break-all font-mono text-xs">{info.fingerprint}</dd>
          </dl>
        )}
        <p className="pt-3 text-xs text-fg-muted">{t('lan.firewall')}</p>
      </Card>

      {info && (
        <Card>
          <h2 className="font-medium">{t('lan.pair.title')}</h2>
          <div className="flex flex-wrap items-center gap-3 py-2">
            <label className="text-sm" htmlFor="lan-role">
              {t('lan.pair.role')}
            </label>
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger id="lan-role" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {t(`lan.roles.${r}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={() => setOffer(lanBridge()?.startPairing(role) ?? null)}>
              {t('lan.pair.show')}
            </Button>
          </div>
          {live && (
            <div className="flex flex-wrap items-center gap-6 py-2" data-testid="lan-offer">
              <Qr
                label={t('lan.pair.qr')}
                data={pairingUri({
                  host,
                  port: info.port,
                  code: offer.code,
                  fingerprint: info.fingerprint,
                })}
              />
              <div>
                <p className="text-sm text-fg-muted">{t('lan.pair.code')}</p>
                <p className="font-mono text-3xl tracking-widest" data-testid="lan-code">
                  {offer.code}
                </p>
                <p className="text-sm text-fg-muted">
                  {t('lan.pair.expires', { seconds: secondsLeft })}
                </p>
              </div>
            </div>
          )}
          {offer && !live && <p className="text-sm text-fg-muted">{t('lan.pair.expired')}</p>}
          <p className="text-xs text-fg-muted">{t('lan.pair.help')}</p>
        </Card>
      )}

      <Card>
        <h2 className="font-medium">{t('lan.devices.title')}</h2>
        {devices.length === 0 ? (
          <p className="py-2 text-sm text-fg-muted">{t('lan.devices.none')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {devices.map((d) => (
              <li
                key={d.id}
                className="flex flex-wrap items-center gap-3 py-2"
                data-testid="lan-device"
              >
                <Input
                  className="w-48"
                  defaultValue={d.name}
                  aria-label={t('lan.devices.name')}
                  disabled={d.revokedAt !== null}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== d.name) void act(() => lanBridge()?.rename(d.id, v));
                  }}
                />
                <Select
                  value={d.role}
                  disabled={d.revokedAt !== null}
                  onValueChange={(v) => void act(() => lanBridge()?.setRole(d.id, v as Role))}
                >
                  <SelectTrigger className="w-48" aria-label={t('lan.pair.role')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLES.map((r) => (
                      <SelectItem key={r} value={r}>
                        {t(`lan.roles.${r}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-xs text-fg-muted">
                  {d.revokedAt !== null
                    ? t('lan.devices.removed')
                    : d.lastSeenAt === null
                      ? t('lan.devices.never')
                      : t('lan.devices.seen', { when: new Date(d.lastSeenAt).toLocaleString() })}
                </span>
                {d.revokedAt === null && (
                  <Button
                    variant="outline"
                    onClick={() => void act(() => lanBridge()?.revoke(d.id))}
                  >
                    {t('lan.devices.remove')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
