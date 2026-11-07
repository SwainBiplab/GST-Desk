/** JSON with BigInt: money is paise in a bigint, which JSON cannot carry, so a bigint travels as `{"$big":"123"}`. */
const TAG = '$big';

export function encode(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    typeof v === 'bigint' ? { [TAG]: v.toString() } : v,
  );
}

export function decode<T = unknown>(text: string): T {
  return JSON.parse(text, (_k, v: unknown) => {
    if (
      v &&
      typeof v === 'object' &&
      TAG in (v as object) &&
      Object.keys(v as object).length === 1
    ) {
      const s = (v as Record<string, unknown>)[TAG];
      if (typeof s === 'string' && /^-?\d+$/.test(s)) return BigInt(s);
    }
    return v;
  }) as T;
}
