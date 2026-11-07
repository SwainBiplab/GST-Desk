/**
 * Message templates (prompt 44): the three messages a business sends (an invoice, a receipt, a payment
 * reminder) in six languages, the variables they take and how those are read from a document and a party.
 * WhatsApp business-started messages must use a template Meta has approved; these are the texts submitted.
 * The non-English texts are first drafts for a native speaker to review (like the app's own strings).
 */
import { istDate } from './time';

export const KINDS = ['invoice', 'receipt', 'reminder'] as const;
export type MessageKind = (typeof KINDS)[number];

export const LANGUAGES = ['en', 'hi', 'ta', 'mr', 'bn', 'gu'] as const;
export type Language = (typeof LANGUAGES)[number];
export const isLanguage = (v: unknown): v is Language => LANGUAGES.includes(v as Language);

/** The variables of each message, in the order of {{1}}, {{2}}... */
export const VARIABLES: Record<MessageKind, readonly VariableKey[]> = {
  invoice: ['party', 'number', 'amount', 'business'],
  receipt: ['party', 'amount', 'number', 'business'],
  reminder: ['party', 'number', 'amount', 'due', 'business'],
};
export type VariableKey = 'party' | 'number' | 'amount' | 'business' | 'due';

export const DEFAULT_BODIES: Record<MessageKind, Record<Language, string>> = {
  invoice: {
    en: 'Dear {{1}}, your invoice {{2}} for {{3}} from {{4}} is attached. Thank you for your business.',
    hi: 'प्रिय {{1}}, {{4}} की ओर से आपका चालान {{2}} ({{3}}) संलग्न है। आपके व्यापार के लिए धन्यवाद।',
    ta: 'அன்புள்ள {{1}}, {{4}} இடமிருந்து உங்கள் விலைப்பட்டியல் {{2}} ({{3}}) இணைக்கப்பட்டுள்ளது. நன்றி.',
    mr: 'प्रिय {{1}}, {{4}} कडून तुमचे बिल {{2}} ({{3}}) सोबत जोडले आहे. धन्यवाद.',
    bn: 'প্রিয় {{1}}, {{4}} থেকে আপনার চালান {{2}} ({{3}}) সংযুক্ত করা হয়েছে। ধন্যবাদ।',
    gu: 'પ્રિય {{1}}, {{4}} તરફથી તમારું બિલ {{2}} ({{3}}) જોડેલ છે. આભાર.',
  },
  receipt: {
    en: 'Dear {{1}}, we received {{2}} against {{3}}. The receipt from {{4}} is attached. Thank you.',
    hi: 'प्रिय {{1}}, {{3}} के विरुद्ध {{2}} प्राप्त हुए। {{4}} की रसीद संलग्न है। धन्यवाद।',
    ta: 'அன்புள்ள {{1}}, {{3}} க்கு எதிராக {{2}} பெற்றோம். {{4}} இடமிருந்து ரசீது இணைக்கப்பட்டுள்ளது. நன்றி.',
    mr: 'प्रिय {{1}}, {{3}} साठी {{2}} मिळाले. {{4}} ची पावती सोबत जोडली आहे. धन्यवाद.',
    bn: 'প্রিয় {{1}}, {{3}} এর বিপরীতে {{2}} পেয়েছি। {{4}} এর রসিদ সংযুক্ত। ধন্যবাদ।',
    gu: 'પ્રિય {{1}}, {{3}} સામે {{2}} મળ્યા. {{4}} ની રસીદ જોડેલ છે. આભાર.',
  },
  reminder: {
    en: 'Dear {{1}}, a gentle reminder from {{5}}: invoice {{2}} for {{3}} has the due date {{4}}. Please ignore this if you have already paid.',
    hi: 'प्रिय {{1}}, {{5}} की ओर से एक विनम्र अनुस्मारक: चालान {{2}} ({{3}}) की देय तिथि {{4}} है। यदि आप भुगतान कर चुके हैं तो कृपया इसे अनदेखा करें।',
    ta: 'அன்புள்ள {{1}}, {{5}} இடமிருந்து நினைவூட்டல்: விலைப்பட்டியல் {{2}} ({{3}}) செலுத்த வேண்டிய தேதி {{4}}. ஏற்கனவே செலுத்தியிருந்தால் புறக்கணிக்கவும்.',
    mr: 'प्रिय {{1}}, {{5}} कडून नम्र आठवण: बिल {{2}} ({{3}}) ची देय तारीख {{4}} आहे. आधीच भरले असल्यास दुर्लक्ष करा.',
    bn: 'প্রিয় {{1}}, {{5}} এর পক্ষ থেকে বিনীত অনুস্মারক: চালান {{2}} ({{3}}) এর শেষ তারিখ {{4}}। ইতিমধ্যে পরিশোধ করে থাকলে উপেক্ষা করুন।',
    gu: 'પ્રિય {{1}}, {{5}} તરફથી નમ્ર યાદ: બિલ {{2}} ({{3}}) ની ચૂકવણીની તારીખ {{4}} છે. જો ચૂકવી દીધું હોય તો અવગણો.',
  },
};

/** Email subjects, `{number}` and `{business}` filled in. */
export const SUBJECTS: Record<MessageKind, Record<Language, string>> = {
  invoice: {
    en: 'Invoice {number} from {business}',
    hi: '{business} से चालान {number}',
    ta: '{business} இடமிருந்து விலைப்பட்டியல் {number}',
    mr: '{business} कडून बिल {number}',
    bn: '{business} থেকে চালান {number}',
    gu: '{business} તરફથી બિલ {number}',
  },
  receipt: {
    en: 'Receipt for {number} from {business}',
    hi: '{business} से {number} की रसीद',
    ta: '{business} இடமிருந்து {number} க்கான ரசீது',
    mr: '{business} कडून {number} ची पावती',
    bn: '{business} থেকে {number} এর রসিদ',
    gu: '{business} તરફથી {number} ની રસીદ',
  },
  reminder: {
    en: 'Payment reminder: invoice {number} from {business}',
    hi: 'भुगतान अनुस्मारक: {business} का चालान {number}',
    ta: 'கட்டண நினைவூட்டல்: {business} விலைப்பட்டியல் {number}',
    mr: 'पेमेंट आठवण: {business} चे बिल {number}',
    bn: 'পেমেন্ট অনুস্মারক: {business} এর চালান {number}',
    gu: 'ચુકવણી યાદ: {business} નું બિલ {number}',
  },
};

/** Meta's name for an organisation's template: lower case letters, digits and underscores only. */
export const templateName = (orgId: string, kind: MessageKind): string =>
  `gd_${orgId.replace(/-/g, '').slice(0, 8)}_${kind}`;

/** `₹1,23,456.50`, the Indian grouping. */
export function rupees(paise: bigint | number): string {
  const p = BigInt(paise);
  const neg = p < 0n;
  const abs = neg ? -p : p;
  const whole = (abs / 100n).toString();
  const frac = (abs % 100n).toString().padStart(2, '0');
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}₹${rest ? `${rest},` : ''}${last3}.${frac}`;
}

export interface VariableContext {
  party: string;
  number: string;
  amountPaise: bigint | number;
  business: string;
  /** `YYYY-MM-DD`. */
  due?: string | null;
}

/** `5 Nov 2026`. */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${d} ${months[m - 1]} ${y}`;
}

/** The values for {{1}}, {{2}}... of a message, read from a document and its party. */
export function resolveVariables(kind: MessageKind, c: VariableContext): string[] {
  const value: Record<VariableKey, string> = {
    party: c.party.trim() || '-',
    number: c.number || '-',
    amount: rupees(c.amountPaise),
    business: c.business.trim() || '-',
    due: c.due ? longDate(c.due) : longDate(istDate(Date.now())),
  };
  return VARIABLES[kind].map((k) => value[k]);
}

/** The text as the customer will read it. */
export function renderPreview(body: string, variables: readonly string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => variables[Number(n) - 1] ?? '');
}

export function renderSubject(
  kind: MessageKind,
  lang: Language,
  v: { number: string; business: string },
): string {
  return SUBJECTS[kind][lang].replace('{number}', v.number).replace('{business}', v.business);
}

/** The rules Meta applies to a body, so a template is not sent for review only to be refused. */
export function templateProblems(body: string, kind: MessageKind): string[] {
  const out: string[] = [];
  const found = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  const want = VARIABLES[kind].length;
  for (let i = 1; i <= want; i++) if (!found.includes(i)) out.push(`missing {{${i}}}`);
  for (const n of found)
    if (n < 1 || n > want) out.push(`{{${n}}} is not a variable of this message`);
  if (/^\s*\{\{\d+\}\}/.test(body)) out.push('a variable cannot start the text');
  if (/\{\{\d+\}\}\s*[.!?]?\s*$/.test(body)) out.push('a variable cannot end the text');
  if (/\{\{\d+\}\}\s*\{\{\d+\}\}/.test(body)) out.push('two variables cannot touch');
  if (body.length > 1024) out.push('the text is longer than 1024 characters');
  return out;
}
