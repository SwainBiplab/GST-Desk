/**
 * For a key built at run time (`inbox.kinds.${kind}`): the type check cannot see through it, so the
 * call says so out loud. `pnpm i18n:extract` still treats the literal prefix as using every key under
 * it, and the tests check that each value such a call can take has a string in English.
 */
export const dyn = (key: string): never => key as never;
