/**
 * Team members' names for showing who did what (prompt 42): read from the cloud once per organisation
 * when signed in and allowed to see the team, else empty (ids then show as they are).
 */
import { useEffect, useState } from 'react';

import { browserStore } from './source';

import { CloudClient, readSession } from '@/features/cloud/client';

export interface TeamNames {
  names: ReadonlyMap<string, string>;
  /** user id -> member id, for a member's sign-ins */
  members: ReadonlyMap<string, string>;
}

const EMPTY: TeamNames = { names: new Map(), members: new Map() };
const cache = new Map<string, TeamNames>();

export function useTeamNames(orgId: string | null | undefined): TeamNames {
  const [v, setV] = useState<TeamNames>(() => (orgId && cache.get(orgId)) || EMPTY);
  useEffect(() => {
    const session = readSession(browserStore.get);
    if (!orgId || !session) return;
    let live = true;
    new CloudClient(session.baseUrl, session.token)
      .team(orgId)
      .then((t) => {
        const next: TeamNames = {
          names: new Map(t.members.map((m) => [m.userId, m.name])),
          members: new Map(t.members.map((m) => [m.userId, m.memberId])),
        };
        cache.set(orgId, next);
        if (live) setV(next);
      })
      .catch(() => undefined); // not allowed, or offline: ids show as they are
    return () => {
      live = false;
    };
  }, [orgId]);
  return v;
}
