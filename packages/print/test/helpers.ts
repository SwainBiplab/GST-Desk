import type { Item, LayoutPage } from '../src/layout';
import { BANK, UPI, samplePrintModel, type DocOptions } from '../src/sample';

export { BANK, UPI, type DocOptions };
export const sampleModel = samplePrintModel;

export const texts = (p: LayoutPage): string[] =>
  p.items.filter((i): i is Extract<Item, { t: 'text' }> => i.t === 'text').map((i) => i.text);

export const allTexts = (pages: LayoutPage[]): string[] => pages.flatMap(texts);

export const textItems = (p: LayoutPage) =>
  p.items.filter((i): i is Extract<Item, { t: 'text' }> => i.t === 'text');
