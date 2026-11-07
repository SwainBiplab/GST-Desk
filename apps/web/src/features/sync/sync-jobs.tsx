/**
 * The sync client's runtime (prompt 43): when the open book is a synced one, connect while online and
 * in the foreground, feed the status store the pill reads, keep this device's number blocks topped up,
 * sync at once in a background window or when a push says there is something new, and register for
 * push. Renders nothing. The browser has no sync client yet (B-167), so this does nothing there.
 */
import { announce, onChange } from '@gst/db';
import { today } from '@gst/domain';
import { ensureRanges } from '@gst/sync';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { registerSyncNow, resetSyncStatus, setSyncStatus } from './status';

import { useAppDb } from '@/app/db';
import { deviceId } from '@/app/store';
import { CloudClient, readSession } from '@/features/cloud/client';
import { browserStore } from '@/features/team/source';
import { onForeground } from '@/platform/app';
import { onSyncWindow, scheduleBackgroundSync } from '@/platform/background-sync';
import { onPushMessage, registerForPush } from '@/platform/push';

const PENDING_POLL_MS = 3_000;
const RANGES_EVERY_MS = 10 * 60_000;

export function SyncJobs() {
  const { synced, database, ctx } = useAppDb();
  const queryClient = useQueryClient();
  const busy = useRef(false);

  useEffect(() => {
    if (!synced || !database) {
      resetSyncStatus();
      return;
    }
    let live = true;
    const offs: (() => Promise<void> | void)[] = [];
    setSyncStatus({ attached: true });

    const pending = async () => {
      try {
        const n = await synced.pending();
        if (live) setSyncStatus({ pending: n });
      } catch {
        /* the book is closing */
      }
    };
    const syncNow = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        if (!synced.ps.currentStatus.connected) await synced.connect();
        await pending();
      } finally {
        busy.current = false;
      }
    };
    registerSyncNow(syncNow);

    offs.push(
      synced.ps.registerListener({
        statusChanged: (s) => {
          const p = s.downloadProgress;
          setSyncStatus({
            connected: s.connected,
            uploading: s.dataFlowStatus.uploading,
            downloading: s.dataFlowStatus.downloading,
            lastSyncedAt: s.lastSyncedAt?.getTime() ?? null,
            progress: p
              ? {
                  done: p.downloadedOperations,
                  total: p.totalOperations,
                  fraction: p.downloadedFraction,
                }
              : null,
          });
        },
      }),
    );
    // the server's answers: a refusal is an error the sheet shows; conflicts are in the inbox already
    synced.connector.listen((results) => {
      const refused = results.filter((r) => r.outcome === 'rejected');
      if (refused.length)
        setSyncStatus({
          errors: refused
            .map((r) => ({ at: Date.now(), message: r.reason ?? r.outcome }))
            .slice(0, 5),
        });
      else setSyncStatus({ errors: [] });
      void pending();
    });
    const timer = setInterval(() => {
      void pending();
      if (synced.connector.lastError) setSyncStatus({ errors: [synced.connector.lastError] });
    }, PENDING_POLL_MS);
    offs.push(() => clearInterval(timer));
    offs.push(onChange(database, () => void pending()));
    // rows PowerSync writes (the download) bypass the repositories: tell the live queries ourselves
    offs.push(synced.ps.onChange({ onChange: (ev) => announce(database, ev.changedTables) }));
    offs.push(
      synced.ps.registerListener({
        statusChanged: (s) => {
          // the first download of a book: everything on screen is new once it has landed
          if (s.hasSynced) void queryClient.invalidateQueries();
        },
      }),
    );

    void syncNow();
    void onForeground((active) => {
      if (active) void syncNow();
    }).then((off) => offs.push(off));
    void onSyncWindow(() => void syncNow()).then((off) => offs.push(off));
    void scheduleBackgroundSync();

    // push: the token goes to the API; a message means the inbox or a reminder changed on the server
    const session = readSession(browserStore.get);
    if (session) {
      const client = new CloudClient(session.baseUrl, session.token);
      void registerForPush((token) => {
        void client.registerPushToken({ token, deviceId: deviceId() }).catch(() => undefined);
      }).then((h) => h && offs.push(() => h.remove()));
      void onPushMessage(() => void syncNow()).then((h) => h && offs.push(() => h.remove()));
    }

    return () => {
      live = false;
      registerSyncNow(null);
      synced.connector.listen(null);
      for (const off of offs) void off();
      void synced.disconnect().catch(() => undefined);
    };
  }, [synced, database, queryClient]);

  // number blocks for issuing offline: topped up on connect and every ten minutes
  useEffect(() => {
    if (!synced || !database || !ctx) return;
    let live = true;
    const top = async () => {
      if (!synced.ps.currentStatus.connected) return;
      try {
        await ensureRanges(
          database,
          ctx,
          synced.connector,
          today(() => new Date()),
        );
      } catch {
        /* offline, or the server refused: provisional numbers take over */
      }
    };
    const off = synced.ps.registerListener({
      statusChanged: (s) => {
        if (live && s.connected) void top();
      },
    });
    const timer = setInterval(() => void top(), RANGES_EVERY_MS);
    return () => {
      live = false;
      off();
      clearInterval(timer);
    };
  }, [synced, database, ctx]);

  return null;
}
