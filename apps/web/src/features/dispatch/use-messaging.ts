/**
 * The cloud organisation and business messaging works against (prompt 44). Messaging runs on the server, so it
 * needs a signed-in session and a business the server knows: the synced book of the phone, or (in demo mode,
 * for the tests) the open one. Everywhere else the screens say what is missing and the share sheet stays.
 */
import { useEffect, useState } from 'react';

import { DEMO_REQUESTED, useAppDb } from '@/app/db';
import { CloudClient, readSession } from '@/features/cloud/client';
import { browserStore } from '@/features/team/source';

export interface Messaging {
  client: CloudClient;
  orgId: string;
  businessId: string;
}

export type MessagingState =
  | { kind: 'ready'; m: Messaging }
  | { kind: 'signed_out' }
  | { kind: 'local_book' }
  | { kind: 'loading' };

export function useMessaging(): MessagingState {
  const { cloudBook, ctx } = useAppDb();
  const session = readSession(browserStore.get);
  const [orgId, setOrgId] = useState<string | null>(null);
  const wantsMe = !!session && !cloudBook && DEMO_REQUESTED;

  useEffect(() => {
    if (!session || !wantsMe) return;
    let live = true;
    void new CloudClient(session.baseUrl, session.token)
      .me()
      .then((me) => live && setOrgId(me.organisations[0]?.id ?? null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [session?.baseUrl, session?.token, wantsMe]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!session) return { kind: 'signed_out' };
  const client = new CloudClient(session.baseUrl, session.token);
  if (cloudBook)
    return {
      kind: 'ready',
      m: { client, orgId: cloudBook.orgId, businessId: cloudBook.businessId },
    };
  if (!DEMO_REQUESTED || !ctx) return { kind: 'local_book' };
  if (!orgId) return { kind: 'loading' };
  return { kind: 'ready', m: { client, orgId, businessId: ctx.businessId } };
}
