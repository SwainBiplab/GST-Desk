/**
 * Speech to a draft without a model: numbers in Hindi, Marathi, Tamil and English words, units, prices and
 * the party. Deliberately simple: it handles "Ramesh ko do bori cement teen sau pachas rupaye" and
 * "3 kg sugar at 42", and a model takes over for anything longer.
 */
import type { VoiceDraft } from '../../schemas';

const ONES: Record<string, number> = {
  // English
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  // Hindi / Hinglish (Latin)
  ek: 1,
  do: 2,
  teen: 3,
  tin: 3,
  char: 4,
  chaar: 4,
  paanch: 5,
  panch: 5,
  chhe: 6,
  che: 6,
  saat: 7,
  sat: 7,
  aath: 8,
  ath: 8,
  nau: 9,
  das: 10,
  dus: 10,
  gyarah: 11,
  barah: 12,
  terah: 13,
  chaudah: 14,
  pandrah: 15,
  solah: 16,
  satrah: 17,
  atharah: 18,
  unnis: 19,
  bees: 20,
  bis: 20,
  tees: 30,
  tis: 30,
  chalis: 40,
  chaalis: 40,
  pachas: 50,
  sath: 60,
  saath: 60,
  sattar: 70,
  assi: 80,
  nabbe: 90,
  // Marathi (Latin)
  don: 2,
  chaar_m: 4,
  paach: 5,
  saha: 6,
  daha: 10,
  vees: 20,
  tees_m: 30,
  chalees: 40,
  pannas: 50,
  sahe: 60,
  sattar_m: 70,
  ainshi: 80,
  navvad: 90,
  // Tamil (Latin)
  ondru: 1,
  onnu: 1,
  irandu: 2,
  rendu: 2,
  moondru: 3,
  moonu: 3,
  naangu: 4,
  naalu: 4,
  ainthu: 5,
  anju: 5,
  aaru: 6,
  aru: 6,
  ezhu: 7,
  yezhu: 7,
  ettu: 8,
  onbathu: 9,
  onbadhu: 9,
  pathu: 10,
  pattu: 10,
  irupathu: 20,
  muppathu: 30,
  naarpathu: 40,
  aimbathu: 50,
  arupathu: 60,
  ezhupathu: 70,
  enbathu: 80,
  thonnooru: 90,
  // Devanagari and Tamil script numerals spelled out
  एक: 1,
  दो: 2,
  तीन: 3,
  चार: 4,
  पांच: 5,
  पाँच: 5,
  छह: 6,
  सात: 7,
  आठ: 8,
  नौ: 9,
  दस: 10,
  बीस: 20,
  तीस: 30,
  चालीस: 40,
  पचास: 50,
  साठ: 60,
  सत्तर: 70,
  अस्सी: 80,
  नब्बे: 90,
  दोन: 2,
  पाच: 5,
  सहा: 6,
  दहा: 10,
  वीस: 20,
  पन्नास: 50,
  ஒன்று: 1,
  இரண்டு: 2,
  மூன்று: 3,
  நான்கு: 4,
  ஐந்து: 5,
  ஆறு: 6,
  ஏழு: 7,
  எட்டு: 8,
  ஒன்பது: 9,
  பத்து: 10,
  இருபது: 20,
  ஐம்பது: 50,
};
const SCALES: Record<string, number> = {
  hundred: 100,
  sau: 100,
  so: 100,
  शौ: 100,
  सौ: 100,
  noor: 100,
  nooru: 100,
  நூறு: 100,
  thousand: 1000,
  hazaar: 1000,
  hazar: 1000,
  hajar: 1000,
  हज़ार: 1000,
  हजार: 1000,
  aayiram: 1000,
  ayiram: 1000,
  ஆயிரம்: 1000,
  lakh: 100_000,
  lac: 100_000,
  लाख: 100_000,
  latcham: 100_000,
  lakshan: 100_000,
};
const HALF = new Set(['adha', 'aadha', 'half', 'ardha', 'आधा', 'अर्धा', 'arai', 'அரை']);
const UNITS: Record<string, string> = {
  kg: 'KGS',
  kilo: 'KGS',
  kilos: 'KGS',
  kilogram: 'KGS',
  kilograms: 'KGS',
  किलो: 'KGS',
  கிலோ: 'KGS',
  gram: 'GMS',
  grams: 'GMS',
  gm: 'GMS',
  g: 'GMS',
  ग्राम: 'GMS',
  litre: 'LTR',
  litres: 'LTR',
  liter: 'LTR',
  liters: 'LTR',
  ltr: 'LTR',
  लीटर: 'LTR',
  லிட்டர்: 'LTR',
  piece: 'PCS',
  pieces: 'PCS',
  pcs: 'PCS',
  pc: 'PCS',
  nos: 'NOS',
  number: 'NOS',
  nag: 'NOS',
  नग: 'NOS',
  பீஸ்: 'PCS',
  dozen: 'DOZ',
  darjan: 'DOZ',
  दर्जन: 'DOZ',
  box: 'BOX',
  boxes: 'BOX',
  peti: 'BOX',
  पेटी: 'BOX',
  carton: 'CTN',
  cartons: 'CTN',
  bag: 'BAG',
  bags: 'BAG',
  bori: 'BAG',
  बोरी: 'BAG',
  packet: 'PAC',
  packets: 'PAC',
  pack: 'PAC',
  packs: 'PAC',
  पैकेट: 'PAC',
  metre: 'MTR',
  metres: 'MTR',
  meter: 'MTR',
  meters: 'MTR',
  मीटर: 'MTR',
  மீட்டர்: 'MTR',
  bottle: 'BTL',
  bottles: 'BTL',
  बोतल: 'BTL',
  set: 'SET',
  sets: 'SET',
  pair: 'PRS',
  pairs: 'PRS',
  jodi: 'PRS',
};
const PRICE_MARK = /^(rupaye|rupee|rupees|rs|rs\.|₹|rupay|rupaya|रुपये|रुपए|रुपया|ரூபாய்|ரூ|inr)$/i;
const RATE_MARK =
  /^(at|ka|ke|wala|wale|wali|rate|each|per|हर|प्रति|का|के|वाला|கு|ஆக|vīdham|veedham|per)$/i;
const PARTY_MARK =
  /^(ko|se|को|से|कडून|kadun|kadoon|ला|க்கு|kku|kitta|கிட்ட|sahab|saheb|ji|जी|साहब)$/i;
const PRE_MARK = /^(for|to|from)$/i;
const INTENT_PURCHASE =
  /\b(kharid|kharida|kharidi|purchase|bought|buy|liya|liye|khareed|vaanginen|vaangi|वाङ्गि|खरीद|खरीदा|खरेदी|லிருந்து|vangunen)\b/i;
const INTENT_PAYMENT =
  /\b(payment|paid|diya|diye|received|mila|mile|paisa|paise|jama|जमा|मिला|दिया|கொடுத்த|kodutha|vaangiya)\b/i;
const INTENT_SALE =
  /\b(bech|becha|bechi|sold|sale|sell|bill|bill banao|invoice|विक्री|बेच|बेचा|விற்ற|vithen|bikri)\b/i;
const NOISE = new Set([
  'aur',
  'and',
  'or',
  'ka',
  'ki',
  'ke',
  'ko',
  'hai',
  'hain',
  'ho',
  'tha',
  'the',
  'a',
  'an',
  'of',
  'bill',
  'banao',
  'bana',
  'do',
  'karo',
  'likho',
  'और',
  'का',
  'की',
  'के',
  'है',
  'हैं',
  'बनाओ',
  'um',
  'uh',
]);

interface Tok {
  raw: string;
  lower: string;
}

const tokenise = (s: string): Tok[] =>
  (s.match(/[\p{L}\p{M}\p{N}.₹]+/gu) ?? []).map((raw) => ({
    raw,
    lower: raw.toLowerCase().replace(/\.$/, ''),
  }));

/** Read a number out of words or digits starting at `i`; returns the value and how many tokens it used. */
export function readNumber(toks: Tok[], i: number): { value: number; used: number } | null {
  let value = 0;
  let current = 0;
  let used = 0;
  let any = false;
  for (let j = i; j < toks.length; j++) {
    const t = toks[j]!.lower;
    const digits = t.match(/^(\d+(?:\.\d+)?)$/);
    if (digits) {
      if (any && current) break;
      current = Number(digits[1]);
      any = true;
      used++;
      continue;
    }
    if (HALF.has(t)) {
      current += 0.5;
      any = true;
      used++;
      continue;
    }
    if (t in SCALES) {
      if (!any) current = 1;
      value += (current || 1) * SCALES[t]!;
      current = 0;
      any = true;
      used++;
      continue;
    }
    if (t in ONES) {
      current += ONES[t]!;
      any = true;
      used++;
      continue;
    }
    break;
  }
  if (!any) return null;
  return { value: value + current, used };
}

export interface ParsedSpeech extends VoiceDraft {
  /** 0..1: how much of the sentence was understood. */
  confidence: number;
}

export function parseSpeech(text: string): ParsedSpeech {
  const toks = tokenise(text);
  const intent: VoiceDraft['intent'] = INTENT_PURCHASE.test(text)
    ? 'purchase'
    : INTENT_PAYMENT.test(text) && !INTENT_SALE.test(text)
      ? 'payment'
      : INTENT_SALE.test(text)
        ? 'sale'
        : 'unknown';
  let party: string | null = null;
  const lines: VoiceDraft['lines'] = [];
  let amountPaise: number | null = null;
  let used = 0;

  // the party: the word(s) after "for/to/from" ...
  for (let i = 0; i < toks.length - 1 && !party; i++) {
    if (!PRE_MARK.test(toks[i]!.lower)) continue;
    const name: string[] = [];
    for (let j = i + 1; j < toks.length && name.length < 3; j++) {
      const t = toks[j]!;
      if (
        readNumber(toks, j) ||
        NOISE.has(t.lower) ||
        t.lower in UNITS ||
        PRICE_MARK.test(t.lower) ||
        PARTY_MARK.test(t.lower)
      )
        break;
      name.push(t.raw);
    }
    if (name.length) {
      party = name.join(' ');
      used += name.length + 1;
    }
  }
  // ... or the word(s) right before a marker such as "ko" or "se"
  for (let i = 1; i < toks.length && !party; i++) {
    if (PARTY_MARK.test(toks[i]!.lower) && !readNumber(toks, i - 1)) {
      const name: string[] = [];
      for (let j = i - 1; j >= 0 && name.length < 3; j--) {
        const t = toks[j]!;
        if (
          readNumber(toks, j) ||
          NOISE.has(t.lower) ||
          t.lower in UNITS ||
          PRICE_MARK.test(t.lower) ||
          /^(bill|invoice|sale|purchase)$/i.test(t.lower)
        )
          break;
        name.unshift(t.raw);
      }
      if (name.length) {
        party = name.join(' ');
        used += name.length + 1;
        break;
      }
    }
  }

  // lines: [qty] [unit] description ... [rate marker] price [price marker]
  let i = 0;
  let pendingDesc: string[] = [];
  let pendingQty: number | null = null;
  let pendingUnit: string | null = null;
  const flush = (rate: number | null) => {
    const desc = pendingDesc
      .filter((w) => !NOISE.has(w.toLowerCase()))
      .join(' ')
      .trim();
    if (desc)
      lines.push({
        description: desc,
        qty: pendingQty ?? 1,
        unit: pendingUnit,
        ratePaise: rate === null ? null : Math.round(rate * 100),
      });
    pendingDesc = [];
    pendingQty = null;
    pendingUnit = null;
  };
  const partyWords = new Set((party ?? '').toLowerCase().split(' '));
  while (i < toks.length) {
    const t = toks[i]!;
    if (partyWords.has(t.lower) || PARTY_MARK.test(t.lower) || PRE_MARK.test(t.lower)) {
      i++;
      continue;
    }
    const n = readNumber(toks, i);
    if (n) {
      const after = toks[i + n.used];
      const before = toks[i - 1];
      if (after && PRICE_MARK.test(after.lower)) {
        // a price: for the line in hand, or the whole amount
        if (pendingDesc.length) flush(n.value);
        else if (lines.length && lines[lines.length - 1]!.ratePaise === null)
          lines[lines.length - 1]!.ratePaise = Math.round(n.value * 100);
        else amountPaise = Math.round(n.value * 100);
        i += n.used + 1;
        used += n.used + 1;
        continue;
      }
      if (before && RATE_MARK.test(before.lower)) {
        if (pendingDesc.length) flush(n.value);
        else if (lines.length) lines[lines.length - 1]!.ratePaise = Math.round(n.value * 100);
        i += n.used;
        used += n.used;
        continue;
      }
      if (after && after.lower in UNITS) {
        if (pendingDesc.length) flush(null);
        pendingQty = n.value;
        pendingUnit = UNITS[after.lower]!;
        i += n.used + 1;
        used += n.used + 1;
        continue;
      }
      if (pendingDesc.length && pendingQty === null && !(after && PRICE_MARK.test(after.lower))) {
        // "sugar 3" style: the quantity after the item
        pendingQty = n.value;
        i += n.used;
        used += n.used;
        continue;
      }
      if (pendingDesc.length) flush(null);
      pendingQty = n.value;
      i += n.used;
      used += n.used;
      continue;
    }
    if (t.lower in UNITS && pendingQty !== null && !pendingUnit) {
      pendingUnit = UNITS[t.lower]!;
      i++;
      used++;
      continue;
    }
    if (RATE_MARK.test(t.lower) || PRICE_MARK.test(t.lower)) {
      i++;
      continue;
    }
    if (INTENT_SALE.test(t.raw) || INTENT_PURCHASE.test(t.raw) || INTENT_PAYMENT.test(t.raw)) {
      used++;
      i++;
      continue;
    }
    if (NOISE.has(t.lower)) {
      if (/^(aur|and|और)$/i.test(t.lower) && pendingDesc.length) flush(null);
      i++;
      continue;
    }
    pendingDesc.push(t.raw);
    used++;
    i++;
  }
  if (pendingDesc.length) flush(null);

  const confidence = toks.length
    ? Math.min(0.9, 0.3 + 0.6 * (used / toks.length)) * (lines.length || amountPaise ? 1 : 0.4)
    : 0;
  return { intent, party, lines, amountPaise, confidence: Math.round(confidence * 100) / 100 };
}
