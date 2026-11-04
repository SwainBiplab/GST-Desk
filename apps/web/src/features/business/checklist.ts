/**
 * Getting-started checklist. Each step is computed from data, so it ticks itself; dismissing records
 * what was done at that moment, and the list returns if one of those steps regresses.
 */
import type { OnboardingFacts, Row } from '@gst/db';
import { checkGstin } from '@gst/domain';

import { readAddress, readSettings } from './profile';

import type { PageId } from '@/app/nav';

export type StepId = 'profile' | 'logo' | 'party' | 'item' | 'invoice' | 'payment' | 'backup';

export interface Step {
  id: StepId;
  done: boolean;
  /** Where to go to do it. */
  page: PageId;
  /** Search params for that page, e.g. `{ new: '1' }`. */
  search?: Record<string, string>;
}

export interface Dismissed {
  /** Step ids that were done when the user dismissed the list. */
  done: StepId[];
}

/** Name, state, address, and either a valid GSTIN or "not registered yet". */
export function isProfileComplete(b: Row | null): boolean {
  if (!b) return false;
  const address = readAddress(b);
  const registered = typeof b['gstin'] === 'string' && checkGstin(b['gstin']).valid;
  const settled = registered || readSettings(b).notRegisteredYet === true;
  return Boolean(
    String(b['legal_name'] ?? '').trim() && b['state_code'] && address.line1?.trim() && settled,
  );
}

export function computeChecklist(i: {
  business: Row | null;
  facts: OnboardingFacts;
  backupFolderSet: boolean;
}): Step[] {
  return [
    { id: 'profile', done: isProfileComplete(i.business), page: 'settings' },
    {
      id: 'logo',
      done: Boolean(readSettings(i.business).logoAttachmentId),
      page: 'settings',
      search: { tab: 'branding' },
    },
    { id: 'party', done: i.facts.parties > 0, page: 'parties', search: { new: '1' } },
    { id: 'item', done: i.facts.items > 0, page: 'items', search: { new: '1' } },
    { id: 'invoice', done: i.facts.issuedSales > 0, page: 'sell' },
    { id: 'payment', done: i.facts.payments > 0, page: 'payments', search: { intent: 'receive' } },
    { id: 'backup', done: i.backupFolderSet, page: 'settings', search: { tab: 'backup' } },
  ];
}

/**
 * Show the list while anything is left, unless the user dismissed it and nothing they had finished
 * has since become unfinished.
 */
export function checklistVisible(steps: Step[], dismissed: Dismissed | null): boolean {
  if (steps.every((s) => s.done)) return false;
  if (!dismissed) return true;
  return steps.some((s) => dismissed.done.includes(s.id) && !s.done);
}

export const doneIds = (steps: Step[]): StepId[] => steps.filter((s) => s.done).map((s) => s.id);
