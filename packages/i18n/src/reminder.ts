/**
 * Payment reminder wording, per language. These are drafts: a person reads and can edit every message
 * before it is sent, and the Hindi, Tamil, Bengali, Gujarati and Marathi lines are machine-drafted and
 * flagged for a native speaker's review (backlog).
 */
import type { PrintLanguage } from './print';

/** `{party}`, `{amount}`, `{count}`, `{days}`, `{business}`. */
export const REMINDER_TEXT: Record<PrintLanguage, string> = {
  en: 'Hello {party}, a gentle reminder: {amount} is pending on {count} invoice(s), the oldest {days} day(s) overdue. Kindly pay at your earliest. Thank you, {business}.',
  hi: 'नमस्ते {party}, विनम्र अनुस्मारक: {count} बिल पर {amount} बकाया है, सबसे पुराना {days} दिन से देय है। कृपया जल्द भुगतान करें। धन्यवाद, {business}।',
  ta: 'வணக்கம் {party}, நினைவூட்டல்: {count} பில்களில் {amount} நிலுவையில் உள்ளது, பழையது {days} நாட்கள் தாமதம். தயவுசெய்து விரைவில் செலுத்தவும். நன்றி, {business}.',
  bn: 'নমস্কার {party}, মনে করিয়ে দিচ্ছি: {count}টি বিলে {amount} বকেয়া, সবচেয়ে পুরনোটি {days} দিন পার হয়েছে। অনুগ্রহ করে শীঘ্র পরিশোধ করুন। ধন্যবাদ, {business}।',
  gu: 'નમસ્તે {party}, નમ્ર રીમાઇન્ડર: {count} બિલ પર {amount} બાકી છે, સૌથી જૂનું {days} દિવસથી બાકી છે. કૃપા કરીને જલદી ચુકવણી કરો. આભાર, {business}.',
  mr: 'नमस्कार {party}, नम्र आठवण: {count} बिलांवर {amount} थकीत आहे, सर्वात जुने {days} दिवस उशिरा आहे. कृपया लवकर भरणा करा. धन्यवाद, {business}.',
};

/** The language a customer in this state most likely reads. Parties have no language field yet (backlog). */
const STATE_LANGUAGE: Record<string, PrintLanguage> = {
  '27': 'mr',
  '33': 'ta',
  '19': 'bn',
  '24': 'gu',
  '07': 'hi',
  '06': 'hi',
  '08': 'hi',
  '09': 'hi',
  '05': 'hi',
  '02': 'hi',
  '04': 'hi',
  '10': 'hi',
  '20': 'hi',
  '23': 'hi',
  '22': 'hi',
};

export function languageOfState(stateCode: string | null | undefined): PrintLanguage {
  return STATE_LANGUAGE[(stateCode ?? '').padStart(2, '0')] ?? 'en';
}

export function reminderText(
  lang: PrintLanguage,
  vars: { party: string; amount: string; count: number; days: number; business: string },
): string {
  return REMINDER_TEXT[lang].replace(
    /\{(party|amount|count|days|business)\}/g,
    (_m, k: keyof typeof vars) => String(vars[k]),
  );
}
