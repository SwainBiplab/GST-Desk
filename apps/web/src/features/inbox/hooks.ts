import type { InboxKind } from '@gst/ai';
import { runTier0, type Tier0Result } from '@gst/ai/db';
import { ReviewRepo, SettingsRepo, announce, type Ctx, type Database } from '@gst/db';

import { toInboxRow, type InboxRow } from './model';

import { useLiveQuery } from '@/app/db';

export interface InboxData {
  open: InboxRow[];
  snoozed: InboxRow[];
  done: InboxRow[];
  /** The time the lists were read, so "back on" dates and snooze ends line up with them. */
  at: number;
}

const DONE_LIMIT = 500;

/** The inbox in three lists. Re-read whenever review items change (the job runner announces each tick). */
export function useInbox() {
  return useLiveQuery<InboxData>({
    tables: ['review_items'],
    key: ['inbox'],
    fn: async (d, c) => {
      const repo = new ReviewRepo(d);
      const at = Date.now();
      const [open, snoozed, done] = await Promise.all([
        repo.inbox(c, { view: 'open', now: at }),
        repo.inbox(c, { view: 'snoozed', now: at }),
        repo.inbox(c, { view: 'done', now: at, limit: DONE_LIMIT }),
      ]);
      return {
        open: open.map(toInboxRow),
        snoozed: snoozed.map(toInboxRow),
        done: done.map(toInboxRow),
        at,
      };
    },
  });
}

export interface AutoRules {
  /** Accept HSN suggestions at or above this percent; null means off (the default). */
  hsnMinConfidence: number | null;
}

const RULES_KEY = 'inbox.autoRules';
const OFF: AutoRules = { hsnMinConfidence: null };

export function useAutoRules() {
  return useLiveQuery<AutoRules>({
    tables: ['settings'],
    key: ['inbox-rules'],
    fn: async (d, c) => ({
      ...OFF,
      ...((await new SettingsRepo(d).getValue<Partial<AutoRules>>(c, RULES_KEY)) ?? {}),
    }),
  });
}

export async function saveAutoRules(d: Database, c: Ctx, rules: AutoRules): Promise<void> {
  await new SettingsRepo(d).set(c, RULES_KEY, rules);
}

export async function readAutoRules(d: Database, c: Ctx): Promise<AutoRules> {
  return {
    ...OFF,
    ...((await new SettingsRepo(d).getValue<Partial<AutoRules>>(c, RULES_KEY)) ?? {}),
  };
}

export interface CheckInputs {
  inventoryEnabled: boolean;
  backup: { failedAt: number | null; message: string | null; ok: boolean } | null;
}

/** Run the Tier 0 rules now. Honours an auto-rule only if the person switched it on. */
export async function runChecks(
  d: Database,
  c: Ctx,
  inputs: CheckInputs,
  kinds?: readonly InboxKind[],
): Promise<Tier0Result> {
  const rules = await readAutoRules(d, c);
  const result = await runTier0(d, c, {
    inventoryEnabled: inputs.inventoryEnabled,
    backup: inputs.backup && !inputs.backup.ok ? inputs.backup : null,
    autoHsnMinConfidence: rules.hsnMinConfidence,
    ...(kinds ? { kinds } : {}),
  });
  // snoozed items come back by the clock, not by a write: re-read every list after a run
  announce(d, ['review_items']);
  return result;
}
