/** Amount in words (Indian numbering: thousand, lakh, crore) in English and Hindi. */

const EN_ONES = [
  'Zero',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const EN_TENS = [
  '',
  '',
  'Twenty',
  'Thirty',
  'Forty',
  'Fifty',
  'Sixty',
  'Seventy',
  'Eighty',
  'Ninety',
];

function enBelow100(n: number): string {
  if (n < 20) return EN_ONES[n]!;
  const t = EN_TENS[Math.floor(n / 10)]!;
  return n % 10 === 0 ? t : `${t} ${EN_ONES[n % 10]!}`;
}

function enBelow1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h > 0) parts.push(`${EN_ONES[h]!} Hundred`);
  if (r > 0) parts.push(enBelow100(r));
  return parts.join(' ');
}

/** Whole number words in Indian grouping, e.g. 123456 -> "One Lakh Twenty Three Thousand Four Hundred Fifty Six". */
export function integerToWordsEn(n: bigint): string {
  if (n < 0n) throw new RangeError('negative amounts are not supported');
  if (n === 0n) return 'Zero';
  const units: [bigint, string][] = [
    [10_000_000n, 'Crore'],
    [100_000n, 'Lakh'],
    [1_000n, 'Thousand'],
  ];
  let rest = n;
  const parts: string[] = [];
  for (const [size, name] of units) {
    const q = rest / size;
    rest %= size;
    if (q > 0n) {
      // crores can themselves exceed 99: recurse for the multiplier
      parts.push(`${size === 10_000_000n ? integerToWordsEn(q) : enBelow100(Number(q))} ${name}`);
    }
  }
  if (rest > 0n) parts.push(enBelow1000(Number(rest)));
  return parts.join(' ');
}

/** "Rupees One Thousand Two Hundred Thirty Four and Fifty Paise Only". `amount` is integer paise >= 0. */
export function amountToWordsEn(amount: bigint): string {
  if (amount < 0n) throw new RangeError('negative amounts are not supported');
  const rupees = amount / 100n;
  // 0..99: a table index, not a money value
  const ps = Number(amount % 100n);
  const r = `Rupees ${integerToWordsEn(rupees)}`;
  return ps > 0 ? `${r} and ${enBelow100(ps)} Paise Only` : `${r} Only`;
}

const HI_0_99 = [
  'शून्य',
  'एक',
  'दो',
  'तीन',
  'चार',
  'पाँच',
  'छह',
  'सात',
  'आठ',
  'नौ',
  'दस',
  'ग्यारह',
  'बारह',
  'तेरह',
  'चौदह',
  'पंद्रह',
  'सोलह',
  'सत्रह',
  'अठारह',
  'उन्नीस',
  'बीस',
  'इक्कीस',
  'बाईस',
  'तेईस',
  'चौबीस',
  'पच्चीस',
  'छब्बीस',
  'सत्ताईस',
  'अट्ठाईस',
  'उनतीस',
  'तीस',
  'इकतीस',
  'बत्तीस',
  'तैंतीस',
  'चौंतीस',
  'पैंतीस',
  'छत्तीस',
  'सैंतीस',
  'अड़तीस',
  'उनतालीस',
  'चालीस',
  'इकतालीस',
  'बयालीस',
  'तैंतालीस',
  'चौवालीस',
  'पैंतालीस',
  'छियालीस',
  'सैंतालीस',
  'अड़तालीस',
  'उनचास',
  'पचास',
  'इक्यावन',
  'बावन',
  'तिरपन',
  'चौवन',
  'पचपन',
  'छप्पन',
  'सत्तावन',
  'अट्ठावन',
  'उनसठ',
  'साठ',
  'इकसठ',
  'बासठ',
  'तिरसठ',
  'चौंसठ',
  'पैंसठ',
  'छियासठ',
  'सड़सठ',
  'अड़सठ',
  'उनहत्तर',
  'सत्तर',
  'इकहत्तर',
  'बहत्तर',
  'तिहत्तर',
  'चौहत्तर',
  'पचहत्तर',
  'छिहत्तर',
  'सतहत्तर',
  'अठहत्तर',
  'उनासी',
  'अस्सी',
  'इक्यासी',
  'बयासी',
  'तिरासी',
  'चौरासी',
  'पचासी',
  'छियासी',
  'सत्तासी',
  'अट्ठासी',
  'नवासी',
  'नब्बे',
  'इक्यानवे',
  'बानवे',
  'तिरानवे',
  'चौरानवे',
  'पंचानवे',
  'छियानवे',
  'सत्तानवे',
  'अट्ठानवे',
  'निन्यानवे',
];

function hiBelow1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h > 0) parts.push(`${HI_0_99[h]!} सौ`);
  if (r > 0) parts.push(HI_0_99[r]!);
  return parts.join(' ');
}

export function integerToWordsHi(n: bigint): string {
  if (n < 0n) throw new RangeError('negative amounts are not supported');
  if (n === 0n) return HI_0_99[0]!;
  const units: [bigint, string][] = [
    [10_000_000n, 'करोड़'],
    [100_000n, 'लाख'],
    [1_000n, 'हज़ार'],
  ];
  let rest = n;
  const parts: string[] = [];
  for (const [size, name] of units) {
    const q = rest / size;
    rest %= size;
    if (q > 0n) {
      parts.push(`${size === 10_000_000n ? integerToWordsHi(q) : HI_0_99[Number(q)]!} ${name}`);
    }
  }
  if (rest > 0n) parts.push(hiBelow1000(Number(rest)));
  return parts.join(' ');
}

/** "एक हज़ार दो सौ चौंतीस रुपये और पचास पैसे मात्र". */
export function amountToWordsHi(amount: bigint): string {
  if (amount < 0n) throw new RangeError('negative amounts are not supported');
  const rupees = amount / 100n;
  // 0..99: a table index, not a money value
  const ps = Number(amount % 100n);
  const r = `${integerToWordsHi(rupees)} रुपये`;
  return ps > 0 ? `${r} और ${HI_0_99[ps]!} पैसे मात्र` : `${r} मात्र`;
}
