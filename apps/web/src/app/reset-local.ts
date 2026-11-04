/**
 * Delete everything this app keeps in the browser for this site: the database and stored images
 * (the origin-private file system), plus saved preferences. Used when the local database cannot be
 * opened. Nothing leaves the device; nothing here can be undone.
 */
export async function resetLocalData(): Promise<void> {
  const failures: string[] = [];
  try {
    const root = await navigator.storage.getDirectory();
    const names: string[] = [];
    // `entries()` is not in every TS lib; it exists in every browser that has OPFS
    for await (const [name] of (
      root as unknown as { entries(): AsyncIterable<[string, unknown]> }
    ).entries())
      names.push(name);
    for (const name of names) {
      try {
        await root.removeEntry(name, { recursive: true });
      } catch (e) {
        failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    failures.push(e instanceof Error ? e.message : String(e));
  }
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    // storage may be blocked; there is nothing to clear then
  }
  if (failures.length > 0) throw new Error(failures.join('; '));
}

/** Can this browser delete app data from the page? (The desktop app keeps its file elsewhere.) */
export const canResetLocalData = (): boolean =>
  typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
