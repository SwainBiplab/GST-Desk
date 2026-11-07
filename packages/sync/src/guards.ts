/** Local guard triggers and PowerSync (prompt 41): shared by the Node and the phone book openers. */
/**
 * The guards that stop a person's hard delete or an edit of the audit trail must not stop PowerSync: when
 * the server refuses something this device wrote, PowerSync puts the server's state back, which can mean
 * removing a row the device made. Each guard is rewritten to stand aside during a sync operation only.
 */
export async function relaxGuardsForSync(ps: {
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<unknown>;
}): Promise<number> {
  const guards = await ps.getAll<{ name: string; sql: string }>(
    "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%RAISE(ABORT%' AND sql NOT LIKE '%powersync_in_sync_operation%'",
  );
  for (const g of guards) {
    const m = g.sql.match(
      /^([\s\S]*?\bON\s+\S+)(\s+FOR EACH ROW)?(\s+WHEN\s+([\s\S]*?))?\s+BEGIN\b([\s\S]*)$/i,
    );
    if (!m) continue;
    const when = m[4]
      ? `NOT powersync_in_sync_operation() AND (${m[4]})`
      : 'NOT powersync_in_sync_operation()';
    await ps.execute(`DROP TRIGGER IF EXISTS "${g.name}"`);
    await ps.execute(`${m[1]}${m[2] ?? ''} WHEN ${when} BEGIN${m[5]}`);
  }
  return guards.length;
}
