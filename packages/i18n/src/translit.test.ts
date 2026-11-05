import { describe, expect, it } from 'vitest';

import { latinKey, romanise, scriptOf, suggest, transliterate } from './translit';

/** Fifty common names and words, typed the way the engine reads them, with their Devanagari spelling. */
const DEVA: [string, string][] = [
  ['ramesh', 'रमेश'],
  ['suresh', 'सुरेश'],
  ['mahesh', 'महेश'],
  ['gaNesh', 'गणेश'],
  ['rajesh', 'रजेश'],
  ['dinesh', 'दिनेश'],
  ['mukesh', 'मुकेश'],
  ['lakshmii', 'लक्ष्मी'],
  ['kRRiShNa', 'कृष्ण'],
  ['sharmaa', 'शर्मा'],
  ['varmaa', 'वर्मा'],
  ['guptaa', 'गुप्ता'],
  ['paTel', 'पटेल'],
  ['shaah', 'शाह'],
  ['siMh', 'सिंह'],
  ['kumaar', 'कुमार'],
  ['aanaMd', 'आनंद'],
  ['priya', 'प्रिय'],
  ['deepak', 'दीपक'],
  ['gopaal', 'गोपाल'],
  ['hari', 'हरि'],
  ['shyaam', 'श्याम'],
  ['mohan', 'मोहन'],
  ['kailaash', 'कैलाश'],
  ['vaibhav', 'वैभव'],
  ['chandra', 'चन्द्र'],
  ['bharat', 'भरत'],
  ['jain', 'जैन'],
  ['agrawaal', 'अग्रवाल'],
  ['dukaan', 'दुकान'],
  ['kiraanaa', 'किराना'],
  ['bazaar', 'बज़ार'],
  ['vyaapaar', 'व्यापार'],
  ['miThaaii', 'मिठाई'],
  ['dawaaii', 'दवाई'],
  ['rupaye', 'रुपये'],
  ['ghar', 'घर'],
  ['paanii', 'पानी'],
  ['chaay', 'चाय'],
  ['doodh', 'दूध'],
  ['saabun', 'साबुन'],
  ['kapaDaa', 'कपडा'],
  ['bijalii', 'बिजली'],
  ['sonaa', 'सोना'],
  ['chaaMdii', 'चांदी'],
  ['phal', 'फल'],
  ['sabzii', 'सब्ज़ी'],
  ['ghee', 'घी'],
  ['namaste', 'नमस्ते'],
  ['dhanyavaad', 'धन्यवाद'],
];

/** The same words in Tamil. */
const TAMIL: [string, string][] = [
  ['rameesh', 'ரமேஷ்'],
  ['sureesh', 'சுரேஷ்'],
  ['kumaar', 'குமார்'],
  ['murugan', 'முருகன்'],
  ['selvam', 'செல்வம்'],
  ['raaman', 'ராமன்'],
  ['lakshmi', 'லக்ஷ்மி'],
  ['priya', 'ப்ரிய'],
  ['aanandam', 'ஆனந்தம்'],
  ['chennai', 'சென்னை'],
  ['madurai', 'மதுரை'],
  ['kovai', 'கொவை'],
  ['tamizh', 'தமிழ்'],
  ['vaNakkam', 'வணக்கம்'],
  ['nanRi', 'நன்றி'],
  ['ammaa', 'அம்மா'],
  ['appaa', 'அப்பா'],
  ['thaNNiir', 'தண்ணீர்'],
  ['pazham', 'பழம்'],
  ['arisi', 'அரிசி'],
  ['paal', 'பால்'],
  ['kaapi', 'காபி'],
  ['chaaya', 'சாய'],
  ['kaDai', 'கடை'],
  ['viiDu', 'வீடு'],
  ['sundar', 'சுந்தர்'],
  ['goopaal', 'கோபால்'],
  ['mohan', 'மொஹன்'],
  ['gaNeesh', 'கணேஷ்'],
  ['vijay', 'விஜய்'],
  ['karthik', 'கர்திக்'],
  ['bharath', 'பரத்'],
  ['diipaa', 'தீபா'],
  ['kavitha', 'கவித'],
  ['saravaNan', 'சரவணன்'],
  ['rajan', 'ரஜன்'],
  ['senthil', 'செந்தில்'],
  ['anbu', 'அன்பு'],
  ['kannan', 'கன்னன்'],
  ['mani', 'மனி'],
  ['muthu', 'முது'],
  ['naTaraajan', 'நடராஜன்'],
  ['miina', 'மீன'],
  ['shankar', 'ஷங்கர்'],
  ['ravi', 'ரவி'],
  ['hari', 'ஹரி'],
  ['balaji', 'பலஜி'],
  ['kaveri', 'கவெரி'],
  ['rupai', 'ருபை'],
  ['sivaa', 'சிவா'],
];

/**
 * Bengali and Gujarati sit at a fixed distance from Devanagari in Unicode, so the same fifty words are
 * checked against the Devanagari spelling moved over, by a separate (and deliberately dumb) oracle.
 */
function moved(deva: string, to: 'bengali' | 'gujarati'): string {
  const offset = to === 'bengali' ? 0x80 : 0x180;
  return [...deva]
    .map((ch) => {
      if (to === 'bengali' && ch === 'व') return 'ব';
      const cp = ch.codePointAt(0)!;
      return cp >= 0x900 && cp <= 0x97f ? String.fromCodePoint(cp + offset) : ch;
    })
    .join('');
}

describe('transliteration vectors', () => {
  it.each(DEVA)('Devanagari: %s', (roman, native) => {
    expect(transliterate(roman, 'deva')).toBe(native);
  });
  it('has fifty Devanagari vectors', () => expect(DEVA).toHaveLength(50));

  it.each(TAMIL)('Tamil: %s', (roman, native) => {
    expect(transliterate(roman, 'tamil')).toBe(native);
  });
  it('has fifty Tamil vectors', () => expect(TAMIL).toHaveLength(50));

  it.each(DEVA)('Bengali: %s', (roman, deva) => {
    expect(transliterate(roman, 'bengali')).toBe(moved(deva, 'bengali'));
  });
  it.each(DEVA)('Gujarati: %s', (roman, deva) => {
    expect(transliterate(roman, 'gujarati')).toBe(moved(deva, 'gujarati'));
  });

  it('spells a few Bengali and Gujarati words the way a speaker would', () => {
    expect(transliterate('ramesh', 'bengali')).toBe('রমেশ');
    expect(transliterate('shyaam', 'bengali')).toBe('শ্যাম');
    expect(transliterate('vaibhav', 'bengali')).toBe('বৈভব');
    expect(transliterate('paTel', 'gujarati')).toBe('પટેલ');
    expect(transliterate('gaNesh', 'gujarati')).toBe('ગણેશ');
    expect(transliterate('kiraanaa', 'gujarati')).toBe('કિરાના');
  });

  it('treats a capitalised or upper-case word as ordinary', () => {
    expect(transliterate('Ramesh', 'deva')).toBe('रमेश');
    expect(transliterate('RAMESH', 'deva')).toBe('रमेश');
  });

  it('converts each word and keeps spaces, digits and native text as they are', () => {
    expect(transliterate('ramesh  traders 2', 'deva')).toBe('रमेश  त्रदेर्स 2');
    expect(transliterate('शर्मा store', 'deva')).toBe('शर्मा स्तोरे');
    expect(transliterate('', 'deva')).toBe('');
  });
});

describe('suggestions', () => {
  it('offers the long final vowel first for a name ending in a consonant and a', () => {
    expect(suggest('sharma', 'deva')).toEqual(['शर्मा', 'शर्म']);
    expect(suggest('priya', 'deva')[0]).toBe('प्रिया');
  });
  it('offers the retroflex reading of t and d as another choice', () => {
    expect(suggest('patel', 'deva')).toContain('पटेल');
    expect(suggest('patel', 'deva')[0]).toBe('पतेल');
  });
  it('offers the long final i for a name like Lakshmi', () => {
    expect(suggest('lakshmi', 'deva')).toEqual(['लक्ष्मि', 'लक्ष्मी']);
  });
  it('offers Tamil long e and o', () => {
    expect(suggest('selvam', 'tamil')[0]).toBe('செல்வம்');
    expect(suggest('selvam', 'tamil')).toContain('சேல்வம்');
  });
  it('never repeats a reading and caps the list', () => {
    const s = suggest('hari', 'deva', 3);
    expect(new Set(s).size).toBe(s.length);
    expect(s.length).toBeLessThanOrEqual(3);
  });
  it('gives nothing for text with no letters', () => {
    expect(suggest('123', 'deva')).toEqual([]);
    expect(suggest('', 'tamil')).toEqual([]);
  });
});

describe('the Roman key kept for search', () => {
  it('uses what was typed when there is something', () => {
    expect(latinKey('शर्मा', 'Sharma Traders', 'deva')).toBe('sharma traders');
  });
  it('works a spelling out when only the native text is at hand', () => {
    expect(romanise('रमेश', 'deva')).toBe('ramesh');
    expect(romanise('शर्मा', 'deva')).toBe('sharma');
    expect(romanise('রমেশ', 'bengali')).toBe('ramesh');
    expect(latinKey('રમેશ', null, 'gujarati')).toBe('ramesh');
    expect(romanise('தமிழ்', 'tamil')).toBe('thamizh');
  });
  it('leaves English text alone', () => {
    expect(latinKey('Sharma', null, null)).toBe('sharma');
  });
});

describe('scripts', () => {
  it('maps languages to scripts', () => {
    expect(scriptOf('hi')).toBe('deva');
    expect(scriptOf('mr')).toBe('deva');
    expect(scriptOf('ta')).toBe('tamil');
    expect(scriptOf('bn')).toBe('bengali');
    expect(scriptOf('gu')).toBe('gujarati');
    expect(scriptOf('en')).toBeNull();
  });
});
