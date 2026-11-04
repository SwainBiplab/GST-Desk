import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearActions,
  filterActions,
  getActions,
  registerAction,
  scoreAction,
  subscribeActions,
  type Action,
  type ActionContext,
} from './actions';
import { buildDiagnostics, scrub } from './diagnostics';
import { parseAmount, parseCommand } from './grammar';
import { GO_TO, SHORTCUTS, shortcutsFor } from './shortcuts';

const act = (id: string, title: string, extra: Partial<Action> = {}): Action => ({
  id,
  title,
  section: 'Go to',
  run: () => {},
  ...extra,
});

const ctx = (shell: 'shop' | 'books' | null = 'books'): ActionContext => ({
  shell,
  businessId: 'b1',
  navigate: () => {},
  ui: {
    openCommandBar: () => {},
    openKeymap: () => {},
    toggleTheme: () => {},
    toggleDensity: () => {},
    switchShell: () => {},
    loadDemoData: async () => {},
  },
});

describe('action registry', () => {
  beforeEach(() => clearActions());

  it('registers, replaces, unregisters and notifies', () => {
    let calls = 0;
    const off = subscribeActions(() => calls++);
    const un = registerAction(act('a', 'Alpha'));
    registerAction(act('a', 'Alpha 2'));
    expect(getActions().map((a) => a.title)).toEqual(['Alpha 2']);
    un(); // stale handle: the replacement stays
    expect(getActions()).toHaveLength(1);
    const un2 = registerAction(act('b', 'Beta'));
    un2();
    expect(getActions()).toHaveLength(1);
    expect(calls).toBeGreaterThanOrEqual(4);
    off();
  });

  it('hides actions whose `when` is false', () => {
    registerAction(act('books', 'Books only', { when: (c) => c.shell === 'books' }));
    registerAction(act('all', 'Everywhere'));
    expect(getActions(ctx('books'))).toHaveLength(2);
    expect(getActions(ctx('shop')).map((a) => a.id)).toEqual(['all']);
  });
});

describe('action filtering', () => {
  const actions = [
    act('p', 'Go to Parties', { keywords: ['customers', 'suppliers'] }),
    act('i', 'Go to Items', { keywords: ['products', 'stock'] }),
    act('np', 'New party', { section: 'New' }),
    act('ni', 'New invoice', { section: 'New', keywords: ['sale', 'bill'] }),
    act('t', 'Toggle theme', { section: 'Settings', keywords: ['dark', 'light'] }),
  ];

  it('returns everything for an empty query, recent first', () => {
    expect(filterActions(actions, '').map((a) => a.id)).toEqual(['p', 'i', 'np', 'ni', 't']);
    expect(
      filterActions(actions, '', { recent: ['t', 'ni'] })
        .map((a) => a.id)
        .slice(0, 2),
    ).toEqual(['t', 'ni']);
  });

  it('matches title prefixes, word prefixes, keywords and sections', () => {
    expect(filterActions(actions, 'new').map((a) => a.id)).toEqual(['np', 'ni']);
    expect(filterActions(actions, 'inv')[0]?.id).toBe('ni');
    expect(filterActions(actions, 'customers').map((a) => a.id)).toEqual(['p']);
    expect(filterActions(actions, 'dark')[0]?.id).toBe('t');
    expect(filterActions(actions, 'settings')[0]?.id).toBe('t');
  });

  it('requires every word and supports fuzzy subsequences', () => {
    expect(filterActions(actions, 'new party').map((a) => a.id)).toEqual(['np']);
    expect(filterActions(actions, 'new zzz')).toEqual([]);
    expect(filterActions(actions, 'prts').map((a) => a.id)).toEqual(['p']);
    expect(filterActions(actions, 'xyzq')).toEqual([]);
  });

  it('ranks title matches above keyword matches and honours the limit', () => {
    const ranked = filterActions(
      [act('k', 'Zebra', { keywords: ['party'] }), act('p', 'Party list')],
      'party',
    );
    expect(ranked.map((a) => a.id)).toEqual(['p', 'k']);
    expect(filterActions(actions, '', { limit: 2 })).toHaveLength(2);
    expect(scoreAction(actions[0]!, 'GO   TO!!')).toBeGreaterThan(0);
  });
});

describe('amount parsing', () => {
  it.each([
    ['5000', 500_000n],
    ['5,000', 500_000n],
    ['₹5,000', 500_000n],
    ['rs 250.50', 25_050n],
    ['2k', 200_000n],
    ['1.5 lakh', 15_000_000n],
    ['2 cr', 2_000_000_000n],
    ['0.5 crore', 500_000_000n],
    ['3 million', 300_000_000n],
  ])('%s', (text, paise) => expect(parseAmount(text)).toBe(paise));

  it('rejects junk', () => {
    expect(parseAmount('abc')).toBeNull();
    expect(parseAmount('5 pounds')).toBeNull();
    expect(parseAmount('')).toBeNull();
  });
});

describe('command grammar', () => {
  it('parses payments in both directions', () => {
    expect(parseCommand('pay 5000 to Sharma')).toEqual({
      kind: 'payment',
      direction: 'made',
      amountPaise: 500_000n,
      party: 'Sharma',
    });
    expect(parseCommand('Received 1.5 lakh from Iyer & Sons')).toEqual({
      kind: 'payment',
      direction: 'received',
      amountPaise: 15_000_000n,
      party: 'Iyer & Sons',
    });
    expect(parseCommand('  paid   ₹2k   to   Das  ')).toMatchObject({
      amountPaise: 200_000n,
      party: 'Das',
    });
  });

  it('rejects payments with a bad amount or zero', () => {
    expect(parseCommand('pay abc to Sharma')).toBeNull();
    expect(parseCommand('pay 0 to Sharma')).toBeNull();
    expect(parseCommand('pay 5000 Sharma')).toBeNull();
  });

  it('parses new documents with an optional party', () => {
    expect(parseCommand('new invoice')).toEqual({ kind: 'new', doc: 'invoice' });
    expect(parseCommand('create quote for Patel Traders')).toEqual({
      kind: 'new',
      doc: 'quotation',
      party: 'Patel Traders',
    });
    expect(parseCommand('new credit note')).toEqual({ kind: 'new', doc: 'credit_note' });
    expect(parseCommand('new spaceship')).toBeNull();
  });

  it('parses go-to with aliases', () => {
    expect(parseCommand('go parties')).toEqual({ kind: 'go', page: 'parties' });
    expect(parseCommand('open to customers')).toEqual({ kind: 'go', page: 'parties' });
    expect(parseCommand('go gst')).toEqual({ kind: 'go', page: 'reports' });
    expect(parseCommand('go nowhere')).toBeNull();
  });

  it('returns null for plain text', () => {
    expect(parseCommand('Sharma')).toBeNull();
    expect(parseCommand('')).toBeNull();
    expect(parseCommand('what is my gst liability')).toBeNull();
  });
});

describe('keyboard map', () => {
  it('limits Books-only shortcuts to Books', () => {
    expect(shortcutsFor('shop').every((s) => s.scope === 'global')).toBe(true);
    expect(shortcutsFor('books').length).toBe(SHORTCUTS.length);
  });

  it('documents every shortcut in docs/keyboard.md', () => {
    const doc = readFileSync(
      join(import.meta.dirname, '..', '..', '..', '..', 'docs', 'keyboard.md'),
      'utf8',
    );
    for (const s of SHORTCUTS) expect(doc, s.keys).toContain(s.keys);
    for (const t of Object.values(GO_TO)) expect(doc).toContain(t.label);
  });
});

describe('diagnostics', () => {
  it('scrubs identifiers from free text', () => {
    const dirty =
      'party 3f2b8c1e-0a4d-4b6f-9d6e-1a2b3c4d5e6f a@b.co AAPFU0939F 27AAPFU0939F1ZV 9876543210 acct 123456789012 C:\\Users\\Biplab\\x.ts';
    const clean = scrub(dirty);
    for (const secret of [
      '3f2b8c1e',
      'a@b.co',
      'AAPFU0939F',
      '9876543210',
      '123456789012',
      'Biplab',
    ]) {
      expect(clean).not.toContain(secret);
    }
  });

  it('builds a JSON report without query strings or personal data', () => {
    const err = new Error('Failed for sharma@example.com / 9876543210');
    const out = JSON.parse(
      buildDiagnostics({
        error: err,
        pathname: '/books/parties/3f2b8c1e-0a4d-4b6f-9d6e-1a2b3c4d5e6f?q=Sharma',
        appVersion: '0.0.0',
        userAgent: 'UA',
        db: { kind: 'opfs', persistent: true, schemaVersion: 2 },
        at: '2026-01-01T00:00:00Z',
      }),
    );
    expect(out.route).toBe('/books/parties/:id');
    expect(out.error.message).toBe('Failed for [email] / [phone]');
    expect(out.database).toEqual({ kind: 'opfs', persistent: true, schemaVersion: 2 });
    expect(JSON.stringify(out)).not.toMatch(/sharma|Sharma|9876543210/);
    expect(
      JSON.parse(
        buildDiagnostics({
          error: 'plain string',
          pathname: '/',
          appVersion: '1',
          userAgent: 'x',
          at: 'now',
        }),
      ).database,
    ).toBeNull();
  });
});
