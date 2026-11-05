/**
 * Rule-based Roman to Indian-script typing (ITRANS-like), with no network and no dictionary.
 *
 * A person types "sharma" and is offered शर्म, शर्मा and so on; the field keeps the native text and the
 * Roman text they typed (the "Latin key"), so a name is found by either. Rules, in short:
 *
 * - vowels: a aa i ii u uu e ai o au, and RRi; capitals A I U are long; ee and oo are long i and u.
 * - consonants: kh gh ch chh jh th dh ph bh sh, and capitals for retroflex T Th D Dh N, S for ष, L for ळ;
 *   ksh is क्ष.
 * - a consonant followed by a consonant is joined with a halant; one followed by a vowel takes its vowel
 *   sign; one at the end of a word keeps its inherent a (Hindi style), except in Tamil, which closes it
 *   with a pulli.
 * - M is the anusvara and H the visarga.
 * - Bengali and Gujarati follow the same layout as Devanagari in Unicode, so they are produced by
 *   converting the Devanagari result (with the few letters that differ handled by hand).
 * - Tamil has no aspirated or voiced letters, so ka kha ga gha are all க.
 *
 * It cannot know a word's spelling: it gives the likeliest reading first and the other plausible ones
 * after it (long final vowel, retroflex t and d), and the person chooses.
 */
import type { PrintLanguage } from './print';

export type Script = 'deva' | 'tamil' | 'bengali' | 'gujarati';

/** The script a language is written in, or null for English. */
export function scriptOf(lang: string): Script | null {
  switch (lang) {
    case 'hi':
    case 'mr':
      return 'deva';
    case 'ta':
      return 'tamil';
    case 'bn':
      return 'bengali';
    case 'gu':
      return 'gujarati';
    default:
      return null;
  }
}

export const SCRIPT_NAMES: Record<Script, string> = {
  deva: 'देवनागरी',
  tamil: 'தமிழ்',
  bengali: 'বাংলা',
  gujarati: 'ગુજરાતી',
};

/** A language to show first for a script (used to pick a default for a field). */
export function languageOfScript(s: Script): PrintLanguage {
  return s === 'deva' ? 'hi' : s === 'tamil' ? 'ta' : s === 'bengali' ? 'bn' : 'gu';
}

type Vowel = [latin: string, independent: string, sign: string];
type Cons = [latin: string, letters: string];

interface Table {
  vowels: Vowel[];
  cons: Cons[];
  halant: string;
  anusvara: string;
  visarga: string;
  /** A consonant that ends a word is closed with a halant (Tamil) instead of keeping its inherent a. */
  closeFinal: boolean;
}

const DEVA: Table = {
  vowels: [
    ['aa', 'आ', 'ा'],
    ['ai', 'ऐ', 'ै'],
    ['au', 'औ', 'ौ'],
    ['ii', 'ई', 'ी'],
    ['ee', 'ई', 'ी'],
    ['uu', 'ऊ', 'ू'],
    ['oo', 'ऊ', 'ू'],
    ['RRi', 'ऋ', 'ृ'],
    ['a', 'अ', ''],
    ['A', 'आ', 'ा'],
    ['i', 'इ', 'ि'],
    ['I', 'ई', 'ी'],
    ['u', 'उ', 'ु'],
    ['U', 'ऊ', 'ू'],
    ['e', 'ए', 'े'],
    ['o', 'ओ', 'ो'],
  ],
  cons: [
    ['ksh', 'क्ष'],
    ['kSh', 'क्ष'],
    ['chh', 'छ'],
    ['ch', 'च'],
    ['Ch', 'छ'],
    ['kh', 'ख'],
    ['gh', 'घ'],
    ['jh', 'झ'],
    ['Th', 'ठ'],
    ['Dh', 'ढ'],
    ['th', 'थ'],
    ['dh', 'ध'],
    ['ph', 'फ'],
    ['bh', 'भ'],
    ['sh', 'श'],
    ['Sh', 'ष'],
    ['GY', 'ज्ञ'],
    ['k', 'क'],
    ['g', 'ग'],
    ['c', 'क'],
    ['j', 'ज'],
    ['T', 'ट'],
    ['D', 'ड'],
    ['N', 'ण'],
    ['t', 'त'],
    ['d', 'द'],
    ['n', 'न'],
    ['p', 'प'],
    ['b', 'ब'],
    ['m', 'म'],
    ['y', 'य'],
    ['r', 'र'],
    ['l', 'ल'],
    ['L', 'ळ'],
    ['v', 'व'],
    ['w', 'व'],
    ['s', 'स'],
    ['S', 'ष'],
    ['h', 'ह'],
    ['f', 'फ़'],
    ['z', 'ज़'],
    ['q', 'क़'],
    ['x', 'क्स'],
  ],
  halant: '्',
  anusvara: 'ं',
  visarga: 'ः',
  closeFinal: false,
};

const TAMIL: Table = {
  vowels: [
    ['aa', 'ஆ', 'ா'],
    ['ai', 'ஐ', 'ை'],
    ['au', 'ஔ', 'ௌ'],
    ['ii', 'ஈ', 'ீ'],
    ['uu', 'ஊ', 'ூ'],
    ['ee', 'ஏ', 'ே'],
    ['oo', 'ஓ', 'ோ'],
    ['a', 'அ', ''],
    ['A', 'ஆ', 'ா'],
    ['i', 'இ', 'ி'],
    ['I', 'ஈ', 'ீ'],
    ['u', 'உ', 'ு'],
    ['U', 'ஊ', 'ூ'],
    ['e', 'எ', 'ெ'],
    ['E', 'ஏ', 'ே'],
    ['o', 'ஒ', 'ொ'],
    ['O', 'ஓ', 'ோ'],
  ],
  cons: [
    ['ksh', 'க்ஷ'],
    ['kSh', 'க்ஷ'],
    ['chh', 'ச'],
    ['ch', 'ச'],
    ['Ch', 'ச'],
    ['zh', 'ழ'],
    ['kh', 'க'],
    ['gh', 'க'],
    ['jh', 'ஜ'],
    ['Th', 'ட'],
    ['Dh', 'ட'],
    ['th', 'த'],
    ['dh', 'த'],
    ['ph', 'ப'],
    ['bh', 'ப'],
    ['sh', 'ஷ'],
    ['Sh', 'ஷ'],
    ['k', 'க'],
    ['g', 'க'],
    ['c', 'க'],
    ['j', 'ஜ'],
    ['T', 'ட'],
    ['D', 'ட'],
    ['N', 'ண'],
    ['t', 'த'],
    ['d', 'த'],
    ['n', 'ன'],
    ['p', 'ப'],
    ['b', 'ப'],
    ['m', 'ம'],
    ['y', 'ய'],
    ['r', 'ர'],
    ['R', 'ற'],
    ['l', 'ல'],
    ['L', 'ள'],
    ['v', 'வ'],
    ['w', 'வ'],
    ['s', 'ச'],
    ['S', 'ஸ'],
    ['h', 'ஹ'],
    ['f', 'ஃப'],
    ['z', 'ஜ'],
    ['x', 'க்ஸ'],
  ],
  halant: '்',
  anusvara: 'ஂ',
  visarga: 'ஃ',
  closeFinal: true,
};

const sortLongestFirst = <T extends [string, ...unknown[]]>(rows: T[]): T[] =>
  [...rows].sort((a, b) => b[0].length - a[0].length);

interface Compiled {
  table: Table;
  vowels: Map<string, Vowel>;
  cons: Map<string, string>;
  /** Token lengths to try, longest first. */
  lengths: number[];
}

function compile(table: Table): Compiled {
  const vowels = new Map(sortLongestFirst(table.vowels).map((v) => [v[0], v] as const));
  const cons = new Map(sortLongestFirst(table.cons).map((c) => [c[0], c[1]] as const));
  const lengths = [...new Set([...vowels.keys(), ...cons.keys()].map((k) => k.length))].sort(
    (a, b) => b - a,
  );
  return { table, vowels, cons, lengths };
}

const COMPILED = { deva: compile(DEVA), tamil: compile(TAMIL) };

type Token =
  | { kind: 'v'; v: Vowel }
  | { kind: 'c'; letters: string; latin: string }
  | { kind: 'm' }
  | { kind: 'h' }
  | { kind: 'other'; text: string };

function tokenise(word: string, c: Compiled): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < word.length) {
    let hit: Token | null = null;
    let size = 1;
    const rest = word.slice(i);
    // "R^i" is the vowel ऋ in ITRANS; plain "RRi" is handled by the table
    if (rest.startsWith('R^i')) {
      hit = { kind: 'v', v: c.vowels.get('RRi') ?? ['RRi', '', ''] };
      size = 3;
    } else
      for (const len of c.lengths) {
        const piece = rest.slice(0, len);
        if (piece.length < len) continue;
        const v = c.vowels.get(piece);
        if (v) {
          hit = { kind: 'v', v };
          size = len;
          break;
        }
        const k = c.cons.get(piece);
        if (k) {
          hit = { kind: 'c', letters: k, latin: piece };
          size = len;
          break;
        }
      }
    if (!hit) {
      const ch = word[i]!;
      hit = ch === 'M' ? { kind: 'm' } : ch === 'H' ? { kind: 'h' } : { kind: 'other', text: ch };
    }
    out.push(hit);
    i += size;
  }
  return out;
}

function convertWord(word: string, c: Compiled, tamil: boolean): string {
  const t = c.table;
  const toks = tokenise(word, c);
  let out = '';
  /** A consonant has been written and has not yet been given a vowel. */
  let pending = false;
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i]!;
    if (tok.kind === 'c') {
      if (pending) out += t.halant;
      let letters = tok.letters;
      if (tamil && tok.latin === 'n') {
        const next = toks[i + 1];
        const nextLatin = next?.kind === 'c' ? next.latin : '';
        if (i === 0 || /^(t|d|th|dh)$/.test(nextLatin)) letters = 'ந';
        else if (/^(k|g|kh|gh)$/.test(nextLatin)) letters = 'ங';
        else if (/^(ch|j|jh)$/.test(nextLatin)) letters = 'ஞ';
      }
      out += letters;
      pending = true;
    } else if (tok.kind === 'v') {
      out += pending ? tok.v[2] : tok.v[1];
      pending = false;
    } else if (tok.kind === 'm') {
      out += t.anusvara;
      pending = false;
    } else if (tok.kind === 'h') {
      out += t.visarga;
      pending = false;
    } else {
      if (pending && t.closeFinal) out += t.halant;
      out += tok.text;
      pending = false;
    }
  }
  if (pending && t.closeFinal) out += t.halant;
  return out;
}

/** Devanagari code point to the same letter in Bengali or Gujarati, by Unicode layout. */
function shift(text: string, script: 'bengali' | 'gujarati'): string {
  const offset = script === 'bengali' ? 0x80 : 0x180;
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x0900 || cp > 0x097f) {
      out += ch;
      continue;
    }
    if (script === 'bengali') {
      // Bengali has no separate va or retroflex la, and no nukta letters of its own for z and f here
      if (ch === 'व') {
        out += 'ব';
        continue;
      }
      if (ch === 'ळ') {
        out += 'ল';
        continue;
      }
    }
    out += String.fromCodePoint(cp + offset);
  }
  return out;
}

function normaliseCase(word: string): string {
  if (/^[A-Z][a-z]*$/.test(word) || (word.length > 1 && word === word.toUpperCase()))
    return word.toLowerCase();
  return word;
}

const WORD = /[A-Za-z^]+/g;

/** Convert every Roman word in `text` into `script`, leaving everything else (spaces, digits, native text) alone. */
export function transliterate(text: string, script: Script): string {
  return text.replace(WORD, (w) => convertWord1(normaliseCase(w), script));
}

function convertWord1(word: string, script: Script): string {
  if (script === 'tamil') return convertWord(word, COMPILED.tamil, true);
  const deva = convertWord(word, COMPILED.deva, false);
  return script === 'deva' ? deva : shift(deva, script);
}

/** Lengthen a final short vowel: sharma to sharmaa, lakshmi to lakshmii. */
function lengthenFinal(word: string): string {
  return word.replace(/([aiu])$/, '$1$1');
}

/** The readings of one Roman word, likeliest first: as typed, with a long final vowel, with retroflex t and d. */
export function suggest(word: string, script: Script, max = 4): string[] {
  const base = normaliseCase(word.trim());
  if (!/[A-Za-z]/.test(base)) return [];
  // Hindi and Marathi names ending in a consonant and "a" nearly always mean a long final vowel
  // (शर्मा, गुप्ता, प्रिया), so that reading goes first; elsewhere the literal reading does
  const longFirst = script !== 'tamil' && /[^aeiou]a$/.test(base) && base.length >= 4;
  const candidates = longFirst ? [lengthenFinal(base), base] : [base, lengthenFinal(base)];
  const retro = base
    .replace(/th/g, 'Th')
    .replace(/dh/g, 'Dh')
    .replace(/t(?!h)/g, 'T')
    .replace(/d(?!h)/g, 'D');
  candidates.push(...(longFirst ? [lengthenFinal(retro), retro] : [retro, lengthenFinal(retro)]));
  if (script === 'tamil') {
    // Tamil's short and long e and o
    const longer = base.replace(/e(?!e)/g, 'ee').replace(/o(?!o)/g, 'oo');
    candidates.push(longer);
  }
  const out: string[] = [];
  for (const c of candidates) {
    const native = convertWord1(c, script);
    if (native && !out.includes(native)) out.push(native);
    if (out.length >= max) break;
  }
  return out;
}

/* ------------------------------------------------------------------ the other way */

const REVERSE_CONS = new Map<string, string>();
const REVERSE_VOWEL = new Map<string, string>();
const REVERSE_SIGN = new Map<string, string>();

function buildReverse() {
  if (REVERSE_CONS.size > 0) return;
  const prefer = [
    'ksh',
    'chh',
    'kh',
    'gh',
    'ch',
    'jh',
    'Th',
    'Dh',
    'th',
    'dh',
    'ph',
    'bh',
    'sh',
    'Sh',
    'GY',
  ];
  for (const [latin, letters] of DEVA.cons) {
    if (latin === 'c' || latin === 'w' || latin === 'S' || latin === 'kSh' || latin === 'Ch')
      continue;
    if (!REVERSE_CONS.has(letters) || prefer.includes(latin)) REVERSE_CONS.set(letters, latin);
  }
  for (const [latin, independent, sign] of DEVA.vowels) {
    if (['A', 'I', 'U', 'ee', 'oo'].includes(latin)) continue;
    REVERSE_VOWEL.set(independent, latin);
    if (sign) REVERSE_SIGN.set(sign, latin);
  }
}

const TAMIL_REVERSE: Record<string, string> = {
  க: 'k',
  ச: 'ch',
  ட: 't',
  த: 'th',
  ப: 'p',
  ங: 'ng',
  ஞ: 'nj',
  ண: 'n',
  ந: 'n',
  ன: 'n',
  ம: 'm',
  ய: 'y',
  ர: 'r',
  ற: 'r',
  ல: 'l',
  ள: 'l',
  ழ: 'zh',
  வ: 'v',
  ஜ: 'j',
  ஷ: 'sh',
  ஸ: 's',
  ஹ: 'h',
};
const TAMIL_VOWEL: Record<string, string> = {
  அ: 'a',
  ஆ: 'aa',
  இ: 'i',
  ஈ: 'ii',
  உ: 'u',
  ஊ: 'uu',
  எ: 'e',
  ஏ: 'ee',
  ஐ: 'ai',
  ஒ: 'o',
  ஓ: 'oo',
  ஔ: 'au',
};
const TAMIL_SIGN: Record<string, string> = {
  'ா': 'aa',
  'ி': 'i',
  'ீ': 'ii',
  'ு': 'u',
  'ூ': 'uu',
  'ெ': 'e',
  'ே': 'ee',
  'ை': 'ai',
  'ொ': 'o',
  'ோ': 'oo',
  'ௌ': 'au',
};

function toDeva(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x0a80 && cp <= 0x0aff) out += String.fromCodePoint(cp - 0x180);
    else if (cp >= 0x0980 && cp <= 0x09ff)
      out += ch === 'ব' ? 'ब' : String.fromCodePoint(cp - 0x80);
    else out += ch;
  }
  return out;
}

/**
 * A rough Roman spelling of a native word, for the search key when the Roman text that was typed is
 * not at hand (a name pasted in, or one typed on a native keyboard). A final inherent a is dropped, as
 * Hindi, Marathi, Bengali and Gujarati speakers do not say it.
 */
export function romanise(text: string, script: Script): string {
  if (script === 'tamil') {
    let out = '';
    const chars = [...text];
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i]!;
      const c = TAMIL_REVERSE[ch];
      if (c !== undefined) {
        const next = chars[i + 1];
        if (next === '்') {
          out += c;
          i += 1;
        } else if (next && TAMIL_SIGN[next]) {
          out += c + TAMIL_SIGN[next];
          i += 1;
        } else {
          out += c + 'a';
        }
      } else if (TAMIL_VOWEL[ch]) out += TAMIL_VOWEL[ch];
      else if (ch === 'ஃ') out += 'h';
      else out += ch;
    }
    return out.replace(/a(?=\s|$)/g, '');
  }
  buildReverse();
  const chars = [...(script === 'deva' ? text : toDeva(text))];
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const c = REVERSE_CONS.get(ch);
    if (c !== undefined) {
      const next = chars[i + 1];
      if (next === DEVA.halant) {
        out += c;
        i += 1;
      } else if (next && REVERSE_SIGN.has(next)) {
        out += c + REVERSE_SIGN.get(next);
        i += 1;
      } else out += c + 'a';
    } else if (REVERSE_VOWEL.has(ch)) out += REVERSE_VOWEL.get(ch);
    else if (ch === DEVA.anusvara) out += 'n';
    else if (ch === DEVA.visarga) out += 'h';
    else if (/[ऀ-ॿ]/.test(ch)) out += '';
    else out += ch;
  }
  // ksh-type clusters keep their letters; drop the inherent a of the last consonant of each word
  return out.replace(/a(?=\s|$)/g, '');
}

/** What to store for search: the Roman text typed, or a spelling worked out from the native text. */
export function latinKey(
  native: string,
  typed: string | null | undefined,
  script: Script | null,
): string {
  const t = (typed ?? '').trim();
  if (t) return t.toLowerCase();
  if (!script) return native.toLowerCase();
  return romanise(native, script).toLowerCase();
}

/** The Indian script a text is written in, judged by its first native letter (null for Roman text). */
export function scriptInText(text: string): Script | null {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x0900 && cp <= 0x097f) return 'deva';
    if (cp >= 0x0980 && cp <= 0x09ff) return 'bengali';
    if (cp >= 0x0a80 && cp <= 0x0aff) return 'gujarati';
    if (cp >= 0x0b80 && cp <= 0x0bff) return 'tamil';
  }
  return null;
}

/**
 * The Roman key for a whole field value: words typed in this session keep the Roman text that was typed
 * (`typed`: native word to Roman word), others are worked out; text with no native letters needs no key.
 */
export function latinKeyOf(value: string, typed: Readonly<Record<string, string>> = {}): string {
  const words = value.split(/\s+/).filter(Boolean);
  if (!words.some((w) => scriptInText(w))) return '';
  return words
    .map((w) => {
      const own = typed[w];
      if (own) return own.toLowerCase();
      const s = scriptInText(w);
      return s ? romanise(w, s).toLowerCase() : w.toLowerCase();
    })
    .join(' ');
}
