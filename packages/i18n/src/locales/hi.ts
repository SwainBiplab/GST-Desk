/**
 * हिन्दी. First drafts for review by a native speaker (docs/i18n/review.md). Anything not here is
 * shown in English. Business terms follow the glossary (`src/glossary.ts`).
 */
import { a } from './hi-parts/a';
import { b } from './hi-parts/b';
import { c } from './hi-parts/c';
import { d } from './hi-parts/d';
import { e } from './hi-parts/e';
import { f, fErrors } from './hi-parts/f';
import { g } from './hi-parts/g';
import { h } from './hi-parts/h';
import { iHelp } from './hi-parts/i';

import type { LocaleBundle } from '.';

/** Merge catalogue parts; a later part wins where two give the same key. */
type Obj = { [key: string]: unknown };
function merge(...parts: Obj[]): Obj {
  const out: Obj = {};
  for (const part of parts)
    for (const [k, v] of Object.entries(part))
      out[k] =
        typeof v === 'object' && v !== null && typeof out[k] === 'object'
          ? merge(out[k] as Obj, v as Obj)
          : typeof v === 'object' && v !== null
            ? merge(v as Obj)
            : v;
  return out;
}

const first: LocaleBundle['ui'] = {
  app: { name: 'GST Desk', skip: 'सीधे सामग्री पर जाएँ' },
  shell: { shop: 'दुकान', books: 'खाता', switch: 'मोड बदलें' },
  nav: {
    label: 'मुख्य मेनू',
    dashboard: 'डैशबोर्ड',
    sell: 'बिक्री',
    parties: 'पार्टियाँ',
    items: 'सामान',
    documents: 'दस्तावेज़',
    payments: 'भुगतान',
    reports: 'रिपोर्ट',
    inbox: 'इनबॉक्स',
    settings: 'सेटिंग',
    purchases: 'खरीद',
    sections: {
      overview: 'सारांश',
      sales: 'बिक्री',
      purchases: 'खरीद',
      parties: 'पार्टियाँ',
      items: 'सामान',
      money: 'पैसा',
      reports: 'रिपोर्ट',
      gst: 'जीएसटी',
      inbox: 'इनबॉक्स',
      settings: 'सेटिंग',
    },
  },
  actions: {
    newBill: 'नया बिल',
    receivePayment: 'भुगतान लें',
    scanBill: 'बिल स्कैन करें',
    search: 'खोजें या कमांड चलाएँ',
    openPanel: 'विवरण पैनल दिखाएँ',
    closePanel: 'विवरण पैनल छिपाएँ',
  },
  strip: {
    sales: 'आज की बिक्री',
    cash: 'आज मिला नकद',
    pending: 'ग्राहकों से बाकी',
  },
  chrome: {
    business: 'कारोबार',
    noBusiness: 'अभी कोई कारोबार नहीं',
    addBusiness: 'कारोबार जोड़ें',
    local: 'स्थानीय',
    notifications: 'सूचनाएँ',
    help: 'मदद',
    keyboardMap: 'कीबोर्ड शॉर्टकट',
    density: 'घनत्व',
    compact: 'सघन',
    comfortable: 'आरामदायक',
    theme: 'थीम',
    language: 'भाषा',
  },
  page: {
    notBuilt: 'यह स्क्रीन अभी बनी नहीं है।',
    unknown: 'पृष्ठ नहीं मिला',
    back: 'डैशबोर्ड पर वापस जाएँ',
  },
  confirm: { yes: 'हाँ', cancel: 'रद्द करें' },
  unsaved: {
    title: 'बिना सहेजे छोड़ें?',
    body: 'आपके बदलाव सहेजे नहीं गए हैं। अभी छोड़ने पर वे खो जाएँगे।',
    leave: 'छोड़ें',
    stay: 'रुकें',
  },
  welcome: {
    language: {
      label: 'भाषा',
      note: 'ऐप आपकी चुनी भाषा में चलेगा। जो शब्द अभी अनुवादित नहीं हैं वे अंग्रेज़ी में दिखेंगे।',
    },
  },
  inbox: {
    title: 'इनबॉक्स',
    subtitle: 'ऐप ने जो बातें आपके देखने के लिए पकड़ी हैं। आपके स्वीकार करने तक कुछ नहीं बदलता।',
    views: { open: 'देखना बाकी', snoozed: 'टाले हुए', done: 'निपटे' },
    kinds: {
      duplicate_party: 'संभावित दोहरी पार्टी',
      duplicate_item: 'संभावित दोहरा सामान',
      hsn_suggestion: 'HSN सुझाव',
      reminder_due: 'भुगतान की याद',
      low_stock: 'कम स्टॉक',
      draft_stale: 'पुराना ड्राफ़्ट',
      backup_failed: 'बैकअप नहीं हुआ',
      rate_change: 'जीएसटी दर बदली',
    },
    filters: { kind: 'प्रकार', allKinds: 'सभी प्रकार', search: 'इनबॉक्स में खोजें' },
    count_one: '{{count}} प्रविष्टि',
    count_other: '{{count}} प्रविष्टियाँ',
    empty: {
      open: 'सब ठीक है। किसी बात पर ध्यान देने की ज़रूरत नहीं।',
      snoozed: 'कुछ भी टाला नहीं गया।',
      done: 'अभी कुछ निपटाया नहीं गया।',
    },
    actions: {
      accept: 'स्वीकार करें',
      acceptEdited: 'बदलाव के साथ स्वीकार करें',
      edit: 'बदलें',
      reject: 'अस्वीकार करें',
      snooze: 'बाद में',
      open: 'रिकॉर्ड खोलें',
      unsnooze: 'वापस लाएँ',
      acknowledge: 'ठीक है',
      runChecks: 'अभी जाँचें',
      bulk: 'कई स्वीकार करें',
      sendReminder: 'WhatsApp पर भेजें',
    },
    snooze: { tomorrow: 'कल', week: 'अगले हफ़्ते', month: 'अगले महीने' },
    status: { accepted: 'स्वीकार', rejected: 'अस्वीकार', expired: 'अब ज़रूरत नहीं' },
    toast: {
      accepted: 'स्वीकार किया',
      acknowledged: 'देख लिया गया',
      rejected: 'अस्वीकार किया',
      snoozed: 'बाद के लिए टाला',
      unsnoozed: 'इनबॉक्स में वापस',
      nothingNew: 'कुछ नया नहीं मिला',
    },
    reject: { title: 'यह सुझाव अस्वीकार करें', confirm: 'अस्वीकार करें' },
    keys: 'J / K चलें · A स्वीकार · E बदलें · R अस्वीकार · S बाद में · O रिकॉर्ड खोलें',
  },
};

const rest = {
  errors: {
    boundary: {
      title: 'कुछ गड़बड़ हो गई',
      body: 'आपका डेटा सुरक्षित है। आप जाँच-विवरण (बिना निजी जानकारी) कॉपी करके सहायता को भेज सकते हैं।',
      copy: 'जाँच-विवरण कॉपी करें',
      copied: 'जाँच-विवरण कॉपी हो गया',
      reload: 'फिर से खोलें',
    },
  },
  help: {
    keymap: { title: 'कीबोर्ड शॉर्टकट', description: 'इस मोड में चलने वाले शॉर्टकट।' },
  },
};

export const bundle: LocaleBundle = {
  ui: merge(first, a, b, c, d, e, f, g, h),
  errors: merge(rest.errors, fErrors),
  help: merge(rest.help, iHelp),
};
