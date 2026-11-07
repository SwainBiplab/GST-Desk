/**
 * Which payment reminders are due (prompt 44, FR-055). A pure rule engine: documents, the rules, who has
 * opted out and what has been sent go in; the reminders to make come out. Nothing here sends anything.
 *
 * Rules are days from the due date: -3 is three days before, 0 on the day, 7 and 15 days after. A rule is
 * due from its day for a short grace (an outage must not lose a reminder, a business that switches reminders
 * on must not be buried under old ones). Of the rules due for a document, only the latest unsent one is made;
 * the earlier ones are marked passed.
 */
import { addDays, afterQuiet, daysBetween, DEFAULT_QUIET, istDate, type QuietHours } from './time';

export const DEFAULT_OFFSETS = [-3, 0, 7, 15] as const;
/** Days after its day that a rule may still fire. */
export const GRACE_DAYS = 2;

/** Sale documents money is owed on. Quotations, challans and purchases are never chased. */
export const CHASED_TYPES = new Set(['tax_invoice', 'bill_of_supply', 'debit_note']);

export interface ReminderDocument {
  id: string;
  partyId: string | null;
  type: string;
  status: string;
  number: string | null;
  /** `YYYY-MM-DD`. */
  dueDate: string | null;
  outstandingPaise: bigint;
  deletedAt?: number | null;
}

export interface ReminderParty {
  id: string;
  /** Opted out of reminders (any channel the party was reachable on). */
  optedOut: boolean;
  /** Has an address to send to on at least one channel. */
  reachable: boolean;
}

export interface ReminderInput {
  now: number;
  documents: readonly ReminderDocument[];
  parties: ReadonlyMap<string, ReminderParty>;
  offsets: readonly number[];
  /** `documentId:offset` of reminders already made (sent, queued or turned down). */
  made: ReadonlySet<string>;
  quiet?: QuietHours;
}

export interface DueReminder {
  documentId: string;
  partyId: string;
  offset: number;
  /** The key that makes the reminder happen once. */
  key: string;
  /** Not before this instant (quiet hours push it to the morning). */
  notBefore: number;
  /** Days past due (negative before). */
  daysFromDue: number;
}

export const reminderKey = (documentId: string, offset: number): string =>
  `${documentId}:${offset}`;

export function dueReminders(i: ReminderInput): { due: DueReminder[]; passed: string[] } {
  const today = istDate(i.now);
  const offsets = [...new Set(i.offsets)].sort((a, b) => a - b);
  const due: DueReminder[] = [];
  const passed: string[] = [];
  for (const d of i.documents) {
    if (d.status !== 'issued' || d.deletedAt != null) continue;
    if (!CHASED_TYPES.has(d.type) || !d.dueDate || d.outstandingPaise <= 0n || !d.partyId) continue;
    const party = i.parties.get(d.partyId);
    if (!party || party.optedOut || !party.reachable) continue;
    const eligible: { offset: number; fromDue: number }[] = [];
    for (const o of offsets) {
      const day = addDays(d.dueDate, o);
      const late = daysBetween(day, today);
      if (late >= 0 && late <= GRACE_DAYS)
        eligible.push({ offset: o, fromDue: daysBetween(d.dueDate, today) });
    }
    if (eligible.length === 0) continue;
    const unsent = eligible.filter((e) => !i.made.has(reminderKey(d.id, e.offset)));
    // every rule that has come due and is not the latest is passed over, so it is never made later
    for (const e of eligible.slice(0, -1))
      if (!i.made.has(reminderKey(d.id, e.offset))) passed.push(reminderKey(d.id, e.offset));
    const latest = eligible[eligible.length - 1]!;
    if (!unsent.some((e) => e.offset === latest.offset)) continue;
    due.push({
      documentId: d.id,
      partyId: d.partyId,
      offset: latest.offset,
      key: reminderKey(d.id, latest.offset),
      notBefore: afterQuiet(i.now, i.quiet ?? DEFAULT_QUIET),
      daysFromDue: latest.fromDue,
    });
  }
  return { due, passed };
}
