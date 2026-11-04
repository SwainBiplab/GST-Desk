import { describe, expect, it } from 'vitest';

import {
  PAGE_SIZES,
  PRESET_IDS,
  PRESETS,
  TemplateError,
  blockApplies,
  blocksIn,
  exportTemplate,
  moveBlock,
  parseTemplate,
  presetSpec,
  thermalColumns,
  toggleBlock,
  toggleColumn,
} from '../src';

describe('presets', () => {
  it('ships five, and every one is a valid template', () => {
    expect(PRESET_IDS).toHaveLength(5);
    for (const id of PRESET_IDS) {
      const s = parseTemplate(JSON.stringify(PRESETS[id]));
      expect(s.basedOn).toBe(id);
    }
  });

  it('differ where they should: page, style and columns', () => {
    expect(PRESETS.retail.page.size).toBe('a5');
    expect(PRESETS.modern.style.zebra).toBe(true);
    expect(PRESETS.compact.table.taxColumns).toBe('combined');
    expect(PRESETS.tally.copies).toBe('rule48');
    expect(PRESETS.retail.table.columns.find((c) => c.key === 'hsn')!.visible).toBe(false);
    expect(PRESETS.classic.table.columns.find((c) => c.key === 'hsn')!.visible).toBe(true);
  });

  it('are handed out as copies, so editing one never changes the shipped preset', () => {
    const a = presetSpec('classic');
    a.name = 'Mine';
    a.blocks[0]!.visible = false;
    expect(PRESETS.classic.name).toBe('Classic');
    expect(PRESETS.classic.blocks[0]!.visible).toBe(true);
  });
});

describe('importing and exporting', () => {
  it('round-trips through JSON', () => {
    const s = presetSpec('modern');
    expect(parseTemplate(exportTemplate(s))).toEqual(s);
  });

  it('says what is wrong with a bad file', () => {
    expect(() => parseTemplate('not json')).toThrow(/not valid JSON/);
    expect(() => parseTemplate('{}')).toThrow(TemplateError);
    const bad = presetSpec('classic');
    (bad.theme as { accent: string }).accent = 'red';
    expect(() => parseTemplate(JSON.stringify(bad))).toThrow(/theme\.accent/);
  });

  it('refuses a duplicated block or column, and a hidden description or amount', () => {
    const dup = presetSpec('classic');
    dup.blocks.push({ ...dup.blocks[0]! });
    expect(() => parseTemplate(dup)).toThrow(/two "header" blocks/);

    const cols = presetSpec('classic');
    cols.table.columns.push({ ...cols.table.columns[0]! });
    expect(() => parseTemplate(cols)).toThrow(/two "sno" columns/);

    const noItem = presetSpec('classic');
    noItem.table.columns.find((c) => c.key === 'item')!.visible = false;
    expect(() => parseTemplate(noItem)).toThrow(/description column/);
    const noAmount = presetSpec('classic');
    noAmount.table.columns.find((c) => c.key === 'amount')!.visible = false;
    expect(() => parseTemplate(noAmount)).toThrow(/amount column/);
  });

  it('accepts a rcm self-invoice rule and refuses an unknown language', () => {
    const s = presetSpec('classic');
    s.blocks.find((b) => b.type === 'taxSummary')!.onlyTypes = ['rcm_self_invoice'];
    expect(() => parseTemplate(s)).not.toThrow();
    const l = presetSpec('classic') as unknown as { language: string };
    l.language = 'fr';
    expect(() => parseTemplate(l)).toThrow(TemplateError);
  });
});

describe('editing a template', () => {
  it('moves a block within its zone and never out of it', () => {
    const s = presetSpec('classic');
    const order = (x: typeof s) => blocksIn(x, 'closing').map((b) => b.type);
    const before = order(s);
    const moved = moveBlock(s, 'bank', -1);
    expect(order(moved).indexOf('bank')).toBe(before.indexOf('bank') - 1);
    // the first block of a zone cannot move up, the table cannot leave its zone
    expect(moveBlock(s, 'header', -1)).toBe(s);
    expect(moveBlock(s, 'lines', 1)).toBe(s);
    // other zones are untouched
    expect(blocksIn(moved, 'top').map((b) => b.type)).toEqual(
      blocksIn(s, 'top').map((b) => b.type),
    );
  });

  it('switches blocks and columns, but never the description or amount column', () => {
    const s = presetSpec('classic');
    expect(blocksIn(toggleBlock(s, 'bank', false), 'closing').some((b) => b.type === 'bank')).toBe(
      false,
    );
    const hidden = toggleColumn(s, 'hsn', false);
    expect(hidden.table.columns.find((c) => c.key === 'hsn')!.visible).toBe(false);
    expect(
      toggleColumn(s, 'item', false).table.columns.find((c) => c.key === 'item')!.visible,
    ).toBe(true);
    expect(
      toggleColumn(s, 'amount', false).table.columns.find((c) => c.key === 'amount')!.visible,
    ).toBe(true);
  });

  it('shows a block only where its own rules allow', () => {
    const s = presetSpec('classic');
    const summary = s.blocks.find((b) => b.type === 'taxSummary')!;
    expect(blockApplies(summary, { type: 'tax_invoice', supply: 'intra' })).toBe(true);
    expect(blockApplies(summary, { type: 'bill_of_supply', supply: 'none' })).toBe(false);
    const bank = s.blocks.find((b) => b.type === 'bank')!;
    expect(
      blockApplies({ ...bank, onlySupply: ['export'] }, { type: 'tax_invoice', supply: 'intra' }),
    ).toBe(false);
    expect(
      blockApplies({ ...bank, visible: false }, { type: 'tax_invoice', supply: 'intra' }),
    ).toBe(false);
  });
});

describe('page sizes and thermal', () => {
  it('knows A4, A5 and Letter in points', () => {
    expect(PAGE_SIZES.a4.width).toBeCloseTo(595.28, 1);
    expect(PAGE_SIZES.a5.height).toBeCloseTo(595.28, 1);
    expect(PAGE_SIZES.letter.width).toBe(612);
  });

  it('a 58 mm roll holds 32 characters and an 80 mm roll 48', () => {
    expect(thermalColumns(58)).toBe(32);
    expect(thermalColumns(80)).toBe(48);
  });
});
