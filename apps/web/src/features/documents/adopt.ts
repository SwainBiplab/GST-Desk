/**
 * Ids the editor wrote into the address itself (a new draft's first save). The route keeps the
 * mounted editor for these, instead of treating the address change as opening another document.
 */
export const adoptedIds = new Set<string>();
