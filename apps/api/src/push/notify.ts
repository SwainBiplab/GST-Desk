/**
 * When the server raises something for a person (a sync conflict, a change waiting for approval), the
 * phones of the organisation's members who can act on it get a push (prompt 43). Without FCM
 * configured nothing is sent; nothing ever waits on it.
 */
import type { Logger } from 'pino';

import type { PgDatabase } from '../db/pool';

import { FcmSender, type PushData } from './fcm';

export async function tokensOfOrg(
  d: PgDatabase,
  orgId: string,
  o: { roles?: readonly string[]; exceptUser?: string } = {},
): Promise<string[]> {
  const rows = await d.sql`SELECT p.token FROM push_tokens p
    JOIN auth_member m ON m.user_id = p.user_id
    WHERE m.organization_id = ${orgId}
      AND (${o.roles ? d.sql`m.role = ANY(${o.roles as string[]})` : d.sql`true`})
      AND (${o.exceptUser ? d.sql`p.user_id <> ${o.exceptUser}` : d.sql`true`})`;
  return rows.map((r) => String(r['token']));
}

export function makeNotifier(d: PgDatabase, sender: FcmSender | null, log: Logger) {
  return {
    /** Fire and forget: the request that raised the item never waits for the push. */
    org(orgId: string, data: PushData, o: { roles?: readonly string[]; exceptUser?: string } = {}) {
      if (!sender) return;
      void (async () => {
        const tokens = await tokensOfOrg(d, orgId, o);
        if (tokens.length === 0) return;
        const r = await sender.send(tokens, data);
        if (r.gone.length) await d.sql`DELETE FROM push_tokens WHERE token = ANY(${r.gone})`;
        log.info({ orgId, kind: data.kind, sent: r.sent, gone: r.gone.length }, 'push sent');
      })().catch((e: unknown) => log.warn({ err: e }, 'push failed'));
    },
  };
}
export type Notifier = ReturnType<typeof makeNotifier>;
