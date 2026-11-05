/**
 * The GST glossary: one agreed word per concept per language, so "taxable value" is never two things
 * on two screens. Terms that also appear on a printed document are taken straight from the print
 * catalogue (`FROM_PRINT`), so the screen and the printout cannot drift apart; the rest are here.
 *
 * Status: machine-assisted first drafts. A CA reviewer and a native speaker sign each language off in
 * docs/i18n/review.md; until then these are what the draft tool uses and what a translator starts from.
 */
import { printLabel, type PrintLabelKey, type PrintLanguage } from './print';

/** Concept to the print label that already says it. */
export const FROM_PRINT = {
  invoice: 'title.tax_invoice',
  billOfSupply: 'title.bill_of_supply',
  quotation: 'title.quotation',
  creditNote: 'title.credit_note',
  debitNote: 'title.debit_note',
  deliveryChallan: 'title.delivery_challan',
  purchaseBill: 'title.purchase_bill',
  taxableValue: 'taxable',
  cgst: 'cgst',
  sgst: 'sgst',
  igst: 'igst',
  cess: 'cess',
  utgst: 'utgst',
  tcs: 'tcs',
  placeOfSupply: 'placeOfSupply',
  reverseCharge: 'reverseCharge',
  hsn: 'hsn',
  gstin: 'gstin',
  dueDate: 'dueDate',
  discount: 'discount',
  roundOff: 'roundOff',
  total: 'total',
  amountInWords: 'amountInWords',
  ewayBill: 'ewayBill',
  quantity: 'qty',
  rate: 'rate',
  billTo: 'billTo',
  shipTo: 'shipTo',
} as const satisfies Record<string, PrintLabelKey>;

export type PrintConcept = keyof typeof FROM_PRINT;

type Words = Record<PrintLanguage, string>;

/** Concepts the print catalogue does not need. */
export const OWN_TERMS = {
  customer: {
    en: 'Customer',
    hi: 'ग्राहक',
    ta: 'வாடிக்கையாளர்',
    bn: 'গ্রাহক',
    gu: 'ગ્રાહક',
    mr: 'ग्राहक',
  },
  supplier: {
    en: 'Supplier',
    hi: 'आपूर्तिकर्ता',
    ta: 'விநியோகஸ்தர்',
    bn: 'সরবরাহকারী',
    gu: 'સપ્લાયર',
    mr: 'पुरवठादार',
  },
  party: { en: 'Party', hi: 'पार्टी', ta: 'தரப்பினர்', bn: 'পার্টি', gu: 'પાર્ટી', mr: 'पार्टी' },
  item: { en: 'Item', hi: 'सामान', ta: 'பொருள்', bn: 'পণ্য', gu: 'માલ', mr: 'माल' },
  stock: { en: 'Stock', hi: 'स्टॉक', ta: 'இருப்பு', bn: 'মজুত', gu: 'સ્ટૉક', mr: 'साठा' },
  sale: { en: 'Sale', hi: 'बिक्री', ta: 'விற்பனை', bn: 'বিক্রি', gu: 'વેચાણ', mr: 'विक्री' },
  purchase: { en: 'Purchase', hi: 'खरीद', ta: 'கொள்முதல்', bn: 'কেনা', gu: 'ખરીદી', mr: 'खरेदी' },
  payment: {
    en: 'Payment',
    hi: 'भुगतान',
    ta: 'பணம் செலுத்துதல்',
    bn: 'পেমেন্ট',
    gu: 'ચુકવણી',
    mr: 'देयक',
  },
  receipt: { en: 'Receipt', hi: 'रसीद', ta: 'ரசீது', bn: 'রসিদ', gu: 'રસીદ', mr: 'पावती' },
  outstanding: {
    en: 'Outstanding',
    hi: 'बकाया',
    ta: 'நிலுவை',
    bn: 'বকেয়া',
    gu: 'બાકી',
    mr: 'थकबाकी',
  },
  overdue: {
    en: 'Overdue',
    hi: 'देय तिथि निकल गई',
    ta: 'தாமதமானது',
    bn: 'মেয়াদোত্তীর্ণ',
    gu: 'મુદત વીતી ગઈ',
    mr: 'मुदत उलटून गेली',
  },
  reminder: {
    en: 'Reminder',
    hi: 'याद दिलाना',
    ta: 'நினைவூட்டல்',
    bn: 'অনুস্মারক',
    gu: 'યાદ',
    mr: 'आठवण',
  },
  report: { en: 'Report', hi: 'रिपोर्ट', ta: 'அறிக்கை', bn: 'রিপোর্ট', gu: 'રિપોર્ટ', mr: 'अहवाल' },
  ledger: {
    en: 'Ledger',
    hi: 'खाता बही',
    ta: 'பேரேடு',
    bn: 'খতিয়ান',
    gu: 'ખાતાવહી',
    mr: 'खातेवही',
  },
  balance: {
    en: 'Balance',
    hi: 'शेष',
    ta: 'இருப்புத் தொகை',
    bn: 'ব্যালান্স',
    gu: 'બાકી રકમ',
    mr: 'शिल्लक',
  },
  draft: { en: 'Draft', hi: 'ड्राफ़्ट', ta: 'வரைவு', bn: 'খসড়া', gu: 'મુસદ્દો', mr: 'मसुदा' },
  issued: {
    en: 'Issued',
    hi: 'जारी',
    ta: 'வழங்கப்பட்டது',
    bn: 'ইস্যু করা',
    gu: 'જારી',
    mr: 'जारी',
  },
  cancelled: {
    en: 'Cancelled',
    hi: 'रद्द',
    ta: 'ரத்து செய்யப்பட்டது',
    bn: 'বাতিল',
    gu: 'રદ',
    mr: 'रद्द',
  },
  paid: {
    en: 'Paid',
    hi: 'चुकता',
    ta: 'செலுத்தப்பட்டது',
    bn: 'পরিশোধিত',
    gu: 'ચૂકવેલ',
    mr: 'भरलेले',
  },
  unpaid: {
    en: 'Unpaid',
    hi: 'बाकी',
    ta: 'செலுத்தப்படவில்லை',
    bn: 'অপরিশোধিত',
    gu: 'બાકી',
    mr: 'न भरलेले',
  },
  gstReturn: {
    en: 'GST return',
    hi: 'जीएसटी रिटर्न',
    ta: 'ஜிஎஸ்டி கணக்கு தாக்கல்',
    bn: 'জিএসটি রিটার্ন',
    gu: 'જીએસટી રિટર્ન',
    mr: 'जीएसटी विवरणपत्र',
  },
  inputCredit: {
    en: 'Input tax credit',
    hi: 'इनपुट टैक्स क्रेडिट',
    ta: 'உள்ளீட்டு வரி வரவு',
    bn: 'ইনপুট ট্যাক্স ক্রেডিট',
    gu: 'ઇનપુટ ટૅક્સ ક્રેડિટ',
    mr: 'इनपुट टॅक्स क्रेडिट',
  },
  backup: {
    en: 'Backup',
    hi: 'बैकअप',
    ta: 'காப்புப்பிரதி',
    bn: 'ব্যাকআপ',
    gu: 'બૅકઅપ',
    mr: 'बॅकअप',
  },
  restore: {
    en: 'Restore',
    hi: 'वापस लाना',
    ta: 'மீட்டெடு',
    bn: 'পুনরুদ্ধার',
    gu: 'પાછું લાવો',
    mr: 'पुनर्संचयित करा',
  },
  settings: {
    en: 'Settings',
    hi: 'सेटिंग',
    ta: 'அமைப்புகள்',
    bn: 'সেটিংস',
    gu: 'સેટિંગ્સ',
    mr: 'सेटिंग्ज',
  },
  dashboard: {
    en: 'Dashboard',
    hi: 'डैशबोर्ड',
    ta: 'முகப்பு',
    bn: 'ড্যাশবোর্ড',
    gu: 'ડેશબોર્ડ',
    mr: 'डॅशबोर्ड',
  },
  composition: {
    en: 'Composition dealer',
    hi: 'कंपोजिशन डीलर',
    ta: 'கூட்டு வரி வணிகர்',
    bn: 'কম্পোজিশন ডিলার',
    gu: 'કમ્પોઝિશન ડીલર',
    mr: 'कंपोझिशन डीलर',
  },
} as const satisfies Record<string, Words>;

export type OwnConcept = keyof typeof OWN_TERMS;
export type Concept = PrintConcept | OwnConcept;

export const CONCEPTS: readonly Concept[] = [
  ...(Object.keys(FROM_PRINT) as PrintConcept[]),
  ...(Object.keys(OWN_TERMS) as OwnConcept[]),
];

/** The agreed word for a concept in a language. */
export function term(lang: PrintLanguage, concept: Concept): string {
  if (concept in FROM_PRINT) return printLabel(lang, FROM_PRINT[concept as PrintConcept]);
  return OWN_TERMS[concept as OwnConcept][lang];
}

/** Every term in one language, English word to that language's word. Used by the draft tool. */
export function glossaryFor(lang: PrintLanguage): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of CONCEPTS) {
    const english = term('en', c).toLowerCase();
    out.set(english, term(lang, c));
  }
  return out;
}
