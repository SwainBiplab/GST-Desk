import { Button, Input, Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@gst/ui';
import { Sparkles } from '@gst/ui/icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { matchedWords } from './form';
import { useHsnEntry, useHsnSuggestions, type HsnHit } from './hooks';

import { Field } from '@/features/onboarding/field';

const percent = (bp: number) => `${bp / 100}%`;

/**
 * HSN/SAC code with a suggestion popover: describe the item, see the top three matches with their
 * rate and why they matched (offline, from the local HSN master), pick one to fill code, GST rate
 * and cess. Typing a known code shows what it is.
 */
export function HsnField({
  value,
  itemName,
  error,
  onChange,
  onPick,
}: {
  value: string;
  /** Used as the starting text for suggestions. */
  itemName: string;
  error?: string | undefined;
  onChange: (code: string) => void;
  onPick: (hit: HsnHit) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const { hits, loading } = useHsnSuggestions(query, open);
  const entry = useHsnEntry(value);

  const hint = entry.data
    ? `${entry.data.description} (${percent(entry.data.rate_bp)})`
    : /^\d{4,8}$/.test(value.replace(/\s+/g, '')) && entry.isSuccess
      ? t('items.hsn.unknown')
      : undefined;

  return (
    <Field label={t('items.form.hsn')} error={error} hint={hint}>
      {(c) => (
        <Popover
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            if (o) setQuery(itemName);
          }}
        >
          <div className="flex gap-2">
            <PopoverAnchor asChild>
              <Input
                {...c}
                inputMode="numeric"
                autoComplete="off"
                data-testid="item-hsn"
                value={value}
                onChange={(e) => onChange(e.target.value)}
              />
            </PopoverAnchor>
            <PopoverTrigger asChild>
              <Button type="button" variant="outline" data-testid="hsn-suggest">
                <Sparkles size={14} aria-hidden /> {t('items.hsn.suggest')}
              </Button>
            </PopoverTrigger>
          </div>
          <PopoverContent
            align="end"
            className="w-[min(28rem,calc(100vw-2rem))]"
            data-testid="hsn-popover"
          >
            <div className="flex flex-col gap-2">
              <Input
                aria-label={t('items.hsn.describe')}
                placeholder={t('items.hsn.describe')}
                data-testid="hsn-query"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                data-autofocus
              />
              {query.trim().length < 3 ? (
                <p className="text-xs text-fg-muted">{t('items.hsn.typeMore')}</p>
              ) : loading ? (
                <p className="text-xs text-fg-muted">{t('items.hsn.searching')}</p>
              ) : hits.length === 0 ? (
                <p className="text-xs text-fg-muted" data-testid="hsn-none">
                  {t('items.hsn.none')}
                </p>
              ) : (
                <ul className="flex flex-col gap-1" aria-label={t('items.hsn.results')}>
                  {hits.map((h) => {
                    const words = matchedWords(query, h.description);
                    return (
                      <li key={h.code}>
                        <button
                          type="button"
                          data-testid="hsn-hit"
                          className="flex w-full flex-col rounded-md border border-border p-2 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring"
                          onClick={() => {
                            onPick(h);
                            setOpen(false);
                          }}
                        >
                          <span className="flex justify-between gap-2 text-sm">
                            <span className="font-medium tabular-nums">{h.code}</span>
                            <span>
                              {percent(h.rateBp)}
                              {h.cessBp > 0 && ` + ${percent(h.cessBp)} ${t('items.form.cess')}`}
                            </span>
                          </span>
                          <span className="text-sm">{h.description}</span>
                          <span className="text-xs text-fg-muted">
                            {words.length > 0
                              ? t('items.hsn.reason', { words: words.join(', ') })
                              : t('items.hsn.reasonRelated')}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="text-xs text-fg-muted">{t('items.hsn.verify')}</p>
            </div>
          </PopoverContent>
        </Popover>
      )}
    </Field>
  );
}
