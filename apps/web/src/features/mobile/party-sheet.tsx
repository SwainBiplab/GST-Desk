/** Choose the customer on a phone (prompt 43): recent ones first, search, and a two-field new party. */
import { DocumentRepo, PartyRepo, type Row } from '@gst/db';
import type { DocumentType } from '@gst/domain';
import { Button, Drawer, DrawerContent, Input, SheetTitle, toast } from '@gst/ui';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isPurchase } from '../documents/state';

import { recentPartyIds } from './logic';

import { useAppDb, useLiveQuery } from '@/app/db';

const fits = (type: DocumentType, p: Row): boolean =>
  p['type'] === 'both' || p['type'] === (isPurchase(type) ? 'supplier' : 'customer');

export function PartySheet({
  type,
  onPick,
  onClose,
}: {
  type: DocumentType;
  onPick: (party: Row) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { database, ctx, business } = useAppDb();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Row[]>([]);
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => box.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');

  const recent = useLiveQuery<Row[]>({
    tables: ['documents', 'parties'],
    key: ['mobile-recent-parties', type],
    fn: async (d, c) => {
      const docs = await new DocumentRepo(d).listBy(c, { limit: 100 });
      const repo = new PartyRepo(d);
      const out: Row[] = [];
      for (const id of recentPartyIds(docs)) {
        const p = await repo.get(c, id);
        if (p && fits(type, p)) out.push(p);
      }
      if (out.length < 8) {
        const more = await repo.list(c, { orderBy: d.schema.parties.updated_at, limit: 40 });
        for (const p of more.reverse())
          if (fits(type, p) && !out.some((x) => x['id'] === p['id'])) out.push(p);
      }
      return out.slice(0, 12);
    },
  });

  useEffect(() => {
    if (!database || !ctx) return;
    const term = q.trim();
    if (!term) return;
    let live = true;
    const timer = setTimeout(() => {
      void new PartyRepo(database)
        .search(ctx, term, 20)
        .then((r) => live && setResults(r.filter((p) => fits(type, p))));
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, database, ctx, type]);

  const create = async () => {
    if (!database || !ctx || !name.trim()) return;
    try {
      const p = await new PartyRepo(database).create(ctx, {
        type: isPurchase(type) ? 'supplier' : 'customer',
        name: name.trim(),
        phone: phone.trim() || null,
        state_code: String(business?.['state_code'] ?? '27'),
      });
      toast.success(t('mobile.party.created', { name: p['name'] }));
      onPick(p);
    } catch (e) {
      console.error('party create failed', e);
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const list = q.trim() ? results : (recent.data ?? []);
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()}>
      <DrawerContent className="max-h-[85dvh] overflow-auto" data-testid="party-sheet">
        <SheetTitle className="pb-2 text-base font-medium">{t('mobile.party.title')}</SheetTitle>
        <Input
          ref={box}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('mobile.party.search')}
          aria-label={t('mobile.party.search')}
          data-testid="party-sheet-search"
          className="min-h-12"
        />
        {!q.trim() && list.length > 0 && (
          <p className="pt-2 text-xs text-fg-muted">{t('mobile.party.recent')}</p>
        )}
        <ul className="divide-y divide-border">
          {list.map((p) => (
            <li key={String(p['id'])}>
              <button
                type="button"
                className="flex min-h-12 w-full items-center justify-between px-1 text-left"
                data-testid="party-sheet-row"
                onClick={() => onPick(p)}
              >
                <span className="truncate">{String(p['name'])}</span>
                <span className="text-xs text-fg-muted">
                  {String(p['phone'] ?? p['city'] ?? '')}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {list.length === 0 && q.trim() && (
          <p className="py-2 text-sm text-fg-muted" data-testid="party-sheet-none">
            {t('mobile.party.none')}
          </p>
        )}
        {creating ? (
          <div className="flex flex-col gap-2 pt-3" data-testid="party-sheet-new">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('mobile.party.name')}
              aria-label={t('mobile.party.name')}
              data-testid="party-new-name"
              className="min-h-12"
            />
            <Input
              value={phone}
              inputMode="tel"
              onChange={(e) => setPhone(e.target.value)}
              placeholder={t('mobile.party.phone')}
              aria-label={t('mobile.party.phone')}
              data-testid="party-new-phone"
              className="min-h-12"
            />
            <Button
              className="min-h-12"
              data-testid="party-new-save"
              disabled={!name.trim()}
              onClick={() => void create()}
            >
              {t('mobile.party.create')}
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            className="mt-3 min-h-12 w-full"
            data-testid="party-sheet-create"
            onClick={() => {
              setName(q.trim());
              setCreating(true);
            }}
          >
            {t('mobile.party.newParty')}
          </Button>
        )}
      </DrawerContent>
    </Drawer>
  );
}
