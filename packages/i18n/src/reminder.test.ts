import { describe, expect, it } from 'vitest';

import { PRINT_LANGUAGES } from './print';
import { REMINDER_TEXT, languageOfState, reminderText } from './reminder';

describe('reminders', () => {
  it('has every placeholder in every language', () => {
    for (const l of PRINT_LANGUAGES)
      for (const k of ['{party}', '{amount}', '{count}', '{days}', '{business}'])
        expect(REMINDER_TEXT[l], `${l} ${k}`).toContain(k);
  });
  it('fills the message', () => {
    const t = reminderText('en', {
      party: 'Sharma',
      amount: 'Rs 1,000',
      count: 2,
      days: 9,
      business: 'Demo',
    });
    expect(t).toContain('Sharma');
    expect(t).toContain('Rs 1,000');
    expect(t).not.toContain('{');
  });
  it('picks a language from the state, English when unsure', () => {
    expect(languageOfState('27')).toBe('mr');
    expect(languageOfState('33')).toBe('ta');
    expect(languageOfState('7')).toBe('hi');
    expect(languageOfState('29')).toBe('en');
    expect(languageOfState(null)).toBe('en');
  });
});
