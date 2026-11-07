import { describe, expect, it } from 'vitest';

import {
  canAccept,
  describeArgs,
  diffLines,
  editableFields,
  filterRows,
  openTarget,
  toInboxRow,
  whatsappUrl,
} from './model';

const row = (
  kind: string,
  suggestion: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) =>
  toInboxRow({
    id: `id-${kind}`,
    version: 1,
    kind,
    status: 'pending',
    confidence: 92,
    created_at: 1,
    snoozed_until: null,
    reject_reason: null,
    suggestion_json: suggestion,
    payload_json: {},
    ...extra,
  } as never);

describe('inbox rows', () => {
  it('shows an HSN suggestion as a before and after', () => {
    const r = row(
      'hsn_suggestion',
      { itemId: 'i', itemName: 'Tea', code: '0902', rateBp: 500, cessBp: 0 },
      { payload_json: { hsn: null, gstRateBp: 1800 } },
    );
    expect(diffLines(r)).toEqual([
      { label: 'HSN', before: '—', after: '0902' },
      { label: 'GST', before: '18%', after: '5%' },
    ]);
    expect(describeArgs(r)).toMatchObject({ item: 'Tea', code: '0902', rate: '5%' });
  });

  it('knows where each kind opens', () => {
    expect(openTarget(row('duplicate_party', { keepId: 'p1' }))).toEqual({
      to: 'parties',
      search: { open: 'p1' },
    });
    expect(openTarget(row('low_stock', { itemId: 'i1' }))).toEqual({
      to: 'items',
      search: { edit: 'i1' },
    });
    expect(openTarget(row('draft_stale', { documentId: 'd1' }))).toEqual({
      to: 'document',
      search: { id: 'd1' },
    });
    expect(openTarget(row('backup_failed', {}))).toEqual({
      to: 'settings',
      search: { tab: 'backup' },
    });
    expect(openTarget(row('sync_conflict', {}))).toBeNull();
    expect(openTarget(row('sync_conflict', { table: 'documents', rowId: 'd1' }))).toEqual({
      to: 'document',
      search: { id: 'd1' },
    });
  });

  it('refuses to accept kinds that are not built yet', () => {
    expect(canAccept(row('hsn_suggestion', {}))).toBe(true);
    // the GST return checks are built (accepting only acknowledges); reconciliation arrives with prompt 31
    expect(canAccept(row('prefiling_issue', {}))).toBe(true);
    expect(canAccept(row('reconciliation_mismatch', {}))).toBe(false);
    // scanned bills (prompt 36) and sync conflicts (prompt 41) are built
    expect(canAccept(row('ai_extraction', {}))).toBe(true);
    expect(canAccept(row('sync_conflict', {}))).toBe(true);
    expect(canAccept(row('hsn_suggestion', {}, { status: 'accepted' }))).toBe(false);
  });

  it('offers edits only where an edit means something', () => {
    expect(editableFields('hsn_suggestion')).toEqual(['code']);
    expect(editableFields('reminder_due')).toEqual(['message']);
    expect(editableFields('duplicate_party')).toEqual(['keep']);
    expect(editableFields('ai_extraction')).toEqual(['extraction']);
    expect(editableFields('low_stock')).toEqual([]);
  });

  it('filters by kind and by what is typed', () => {
    const rows = [
      row('hsn_suggestion', { itemName: 'Green tea' }),
      row('reminder_due', { partyName: 'Sharma' }),
      row('duplicate_party', { keepName: 'Zeta', mergeName: 'Zeta Pvt' }),
    ];
    expect(filterRows(rows, { kind: 'all', search: '' })).toHaveLength(3);
    expect(filterRows(rows, { kind: 'reminder_due', search: '' })).toHaveLength(1);
    expect(filterRows(rows, { kind: 'all', search: 'zeta pvt' })).toHaveLength(1);
    expect(filterRows(rows, { kind: 'all', search: 'TEA' })).toHaveLength(1);
  });

  it('builds a WhatsApp link with the country code and the message encoded', () => {
    expect(whatsappUrl('98200 12345', 'Hello & thanks')).toBe(
      'https://wa.me/919820012345?text=Hello%20%26%20thanks',
    );
    expect(whatsappUrl(null, 'x')).toBe('https://wa.me/?text=x');
  });
});
