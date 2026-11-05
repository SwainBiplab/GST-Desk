/**
 * A pseudo-locale for layout checks: English made about 40 percent longer, with accented letters so
 * text that was never put through `t()` stands out. Placeholders such as {{count}} and markup are kept
 * intact. It is never shown to a customer; it exists so a long Tamil or Bengali label cannot be the
 * first time a screen sees a long string.
 */
const ACCENT: Record<string, string> = {
  a: 'á',
  e: 'é',
  i: 'í',
  o: 'ó',
  u: 'ú',
  y: 'ý',
  A: 'Á',
  E: 'É',
  I: 'Í',
  O: 'Ó',
  U: 'Ú',
  Y: 'Ý',
  c: 'ç',
  n: 'ñ',
  s: 'š',
  z: 'ž',
};

const KEEP = /(\{\{[^}]*\}\}|<[^>]*>|\$t\([^)]*\))/g;

export function pseudo(text: string, growth = 0.4): string {
  const parts = text.split(KEEP);
  let visible = 0;
  const out = parts
    .map((p, i) => {
      if (i % 2 === 1) return p;
      visible += p.length;
      return p.replace(/[A-Za-z]/g, (ch) => ACCENT[ch] ?? ch);
    })
    .join('');
  const extra = Math.max(0, Math.round(visible * growth));
  if (extra === 0) return out;
  // padding in word-sized pieces so it wraps like text does
  const pad = ' ·'.repeat(Math.ceil(extra / 2)).slice(0, extra);
  return `${out}${pad}`;
}
