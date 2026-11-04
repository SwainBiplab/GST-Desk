import { PartyRepo, type Row } from '@gst/db';
import type { DocumentType } from '@gst/domain';
import {
  Input,
  Popover,
  PopoverAnchor,
  PopoverContent,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@gst/ui';
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { isPurchase } from './state';

import { useAppDb } from '@/app/db';
import { Field } from '@/features/onboarding/field';
import { PartyEditor } from '@/features/parties/party-editor';

/** Parties that make sense for this document: customers for sales, suppliers for purchases. */
const fits = (type: DocumentType, p: Row): boolean =>
  p['type'] === 'both' || p['type'] === (isPurchase(type) ? 'supplier' : 'customer');

/**
 * Choose the party: type to search by name, GSTIN, phone or city, or pick from the ones used most
 * recently. Arrow keys and Enter work; "New party" opens the quick form and uses the result.
 */
export function PartyPicker({
  type,
  name,
  disabled,
  error,
  onPick,
}: {
  type: DocumentType;
  name: string;
  disabled?: boolean;
  error?: string | undefined;
  onPick: (party: Row | null) => void;
}) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  // null = not typing: the box shows the chosen party
  const [query, setQuery] = useState<string | null>(null);
  const text = query ?? name;
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Row[]>([]);
  const [active, setActive] = useState(0);
  const [creating, setCreating] = useState(false);
  // see ItemPicker: Enter waits for the search that matches what was typed
  const [settled, setSettled] = useState<string | null>(null);
  const waiting = useRef(false);

  const choose = (p: Row) => {
    setQuery(null);
    setOpen(false);
    onPick(p);
  };

  useEffect(() => {
    if (!open || !database || !ctx) return;
    let live = true;
    const q = query !== null ? query.trim() : '';
    const timer = setTimeout(
      () => {
        const repo = new PartyRepo(database);
        const found = q
          ? repo.search(ctx, q, 20)
          : repo
              .list(ctx, { orderBy: database.schema.parties.updated_at, limit: 40 })
              .then((r) => r.reverse());
        void found.then((all) => {
          if (!live) return;
          const rows = all.filter((p) => fits(type, p)).slice(0, 8);
          setResults(rows);
          setActive(0);
          setSettled(q);
          if (waiting.current) {
            waiting.current = false;
            if (rows[0]) choose(rows[0]);
          }
        });
      },
      q ? 120 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, database, ctx, type]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, results.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter' && open) {
      e.preventDefault();
      if (settled !== (query !== null ? query.trim() : '')) waiting.current = true;
      else if (active < results.length) choose(results[active]!);
      else setCreating(true);
    } else if (e.key === 'Escape' && open) {
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <>
      <Field
        label={t(isPurchase(type) ? 'docs.header.supplier' : 'docs.header.customer')}
        error={error}
      >
        {(c) => (
          <Popover open={open && !disabled} onOpenChange={setOpen}>
            <PopoverAnchor asChild>
              <div className="flex gap-1" data-party-field>
                <Input
                  {...c}
                  role="combobox"
                  aria-expanded={open}
                  aria-autocomplete="list"
                  autoComplete="off"
                  disabled={disabled}
                  data-testid="doc-party"
                  placeholder={t('docs.header.partyPlaceholder')}
                  value={text}
                  onFocus={() => setOpen(true)}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setOpen(true);
                    if (e.target.value === '') onPick(null);
                  }}
                  onKeyDown={onKey}
                />
              </div>
            </PopoverAnchor>
            <PopoverContent
              align="start"
              className="w-(--radix-popover-trigger-width) min-w-72 p-1"
              onOpenAutoFocus={(e) => e.preventDefault()}
              // the field is the anchor, not part of the popup: clicking or focusing it must not close the list
              onFocusOutside={(e) => e.preventDefault()}
              onInteractOutside={(e) => {
                if ((e.target as HTMLElement).closest('[data-party-field]')) e.preventDefault();
              }}
              data-testid="party-results"
            >
              <ul
                role="listbox"
                aria-label={t('docs.header.partyResults')}
                className="flex flex-col"
              >
                {results.map((p, i) => (
                  <li key={p['id']} role="option" aria-selected={i === active}>
                    <button
                      type="button"
                      tabIndex={-1}
                      data-testid="party-result"
                      className={`flex w-full flex-col rounded-sm px-2 py-1 text-left ${i === active ? 'bg-surface-2' : ''}`}
                      onMouseEnter={() => setActive(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => choose(p)}
                    >
                      <span className="text-sm font-medium">{p['name']}</span>
                      <span className="text-xs text-fg-muted">
                        {[p['gstin'], p['phone'], p['city']].filter(Boolean).join(' | ') ||
                          t('docs.header.noDetails')}
                      </span>
                    </button>
                  </li>
                ))}
                <li role="option" aria-selected={active === results.length}>
                  <button
                    type="button"
                    tabIndex={-1}
                    data-testid="party-new"
                    className={`w-full rounded-sm px-2 py-1 text-left text-sm ${active === results.length ? 'bg-surface-2' : ''}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setCreating(true)}
                  >
                    {t('docs.header.newParty', { name: query !== null ? query.trim() : '' })}
                  </button>
                </li>
              </ul>
            </PopoverContent>
          </Popover>
        )}
      </Field>
      {creating && (
        <Sheet open onOpenChange={(o) => !o && setCreating(false)}>
          <SheetContent className="w-[min(30rem,100vw)] overflow-auto" data-testid="party-quick">
            <SheetTitle className="text-lg font-semibold">{t('parties.form.titleNew')}</SheetTitle>
            <SheetDescription className="pb-3 text-fg-muted">
              {t('docs.header.quickPartyHelp')}
            </SheetDescription>
            <PartyEditor
              mode="quick"
              onCancel={() => setCreating(false)}
              onDone={(p) => {
                setCreating(false);
                choose(p);
              }}
            />
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}
