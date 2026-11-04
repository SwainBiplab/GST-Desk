/**
 * Change notifications. Repositories record which tables a transaction wrote; `runInTx` announces them
 * after the transaction commits, so UI queries can refetch exactly what changed.
 */
import type { Database } from './database';

export type ChangeListener = (tables: ReadonlySet<string>) => void;

const listeners = new WeakMap<Database, Set<ChangeListener>>();
/** Tables written inside an open transaction, keyed by the transaction object. */
const pending = new WeakMap<object, Set<string>>();

/** Subscribe to committed writes. Returns an unsubscribe function. */
export function onChange(d: Database, listener: ChangeListener): () => void {
  let set = listeners.get(d);
  if (!set) listeners.set(d, (set = new Set()));
  set.add(listener);
  return () => set.delete(listener);
}

/** Record that `table` was written in `tx`. Called by repositories. */
export function noteWrite(tx: object, table: string): void {
  let set = pending.get(tx);
  if (!set) pending.set(tx, (set = new Set()));
  set.add(table);
}

/** Announce (and clear) the tables written in `tx`. Call once, after commit. */
export function flushWrites(d: Database, tx: object): void {
  const tables = pending.get(tx);
  pending.delete(tx);
  if (!tables || tables.size === 0) return;
  for (const l of listeners.get(d) ?? []) {
    try {
      l(tables);
    } catch {
      /* a failing listener must not break a write */
    }
  }
}

/** Drop recorded writes after a rollback. */
export function discardWrites(tx: object): void {
  pending.delete(tx);
}

/** Announce changes made outside a repository (bulk seed, restore). */
export function announce(d: Database, tables: string[]): void {
  const set = new Set(tables);
  for (const l of listeners.get(d) ?? []) l(set);
}
