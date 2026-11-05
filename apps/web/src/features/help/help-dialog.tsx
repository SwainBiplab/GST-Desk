import { Dialog, DialogContent, DialogDescription, DialogTitle, Input, cn } from '@gst/ui';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SCREEN_IDS, START_STEPS, search, type Article } from './model';
import { closeHelp, useHelp } from './store';

import { dyn } from '@/lib/dyn-key';

/**
 * In-app help: a search box, the Getting started guide, and one article for every screen. It opens on
 * the article for the screen you are on (F1, or Help in the top bar). Text is in the language of the
 * screens; a language whose translation is only a draft says so.
 */
export function HelpDialog() {
  const { t } = useTranslation(['ui', 'help']);
  const { open, article } = useHelp();
  return (
    <Dialog open={open} onOpenChange={(o) => !o && closeHelp()}>
      <DialogContent className="max-w-3xl" data-testid="help-dialog">
        <DialogTitle>{t('help:title')}</DialogTitle>
        <DialogDescription className="sr-only">{t('help:search')}</DialogDescription>
        {/* the content is unmounted when the dialog closes, so each opening starts clean on `article` */}
        <HelpBody start={article} />
      </DialogContent>
    </Dialog>
  );
}

function HelpBody({ start }: { start: string | null }) {
  const { t, i18n } = useTranslation(['ui', 'help']);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(start);

  const articles = useMemo<Article[]>(() => {
    const guide: Article = {
      id: 'start',
      title: t('help:start.title'),
      paragraphs: [
        t('help:start.intro'),
        ...START_STEPS.flatMap((s) => [
          t(dyn(`help:start.${s}.title`)),
          t(dyn(`help:start.${s}.body`)),
        ]),
      ],
    };
    const screens = SCREEN_IDS.map<Article>((id) => ({
      id,
      title: t(dyn(`help:screens.${id}.title`)),
      paragraphs: [
        t(dyn(`help:screens.${id}.body`)),
        t(dyn(`help:screens.${id}.tip1`)),
        t(dyn(`help:screens.${id}.tip2`)),
        t(dyn(`help:screens.${id}.tip3`)),
      ],
    }));
    return [guide, ...screens];
    // the articles change with the language
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, i18n.language]);

  const shown = search(articles, query);
  const current = shown.find((a) => a.id === picked) ?? shown[0] ?? null;
  const isDraft = i18n.language !== 'en';

  return (
    <>
      <Input
        value={query}
        placeholder={t('help:search')}
        aria-label={t('help:search')}
        data-testid="help-search"
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="grid min-h-72 gap-3 pt-3 sm:grid-cols-[14rem_1fr]">
        <ul className="flex flex-col gap-1" aria-label={t('help:title')}>
          {shown.length === 0 && (
            <li className="text-sm text-fg-muted" data-testid="help-none">
              {t('help:noResults')}
            </li>
          )}
          {shown.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                data-testid={`help-item-${a.id}`}
                aria-current={current?.id === a.id}
                className={cn(
                  'w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2',
                  current?.id === a.id && 'bg-surface-2 font-medium',
                )}
                onClick={() => setPicked(a.id)}
              >
                {a.title}
              </button>
            </li>
          ))}
        </ul>
        {current && (
          <article className="text-sm" data-testid="help-article" data-id={current.id}>
            <h2 className="pb-2 text-base font-semibold">{current.title}</h2>
            {current.id === 'start' ? (
              <>
                <p className="pb-3 text-fg-muted">{current.paragraphs[0]}</p>
                <ol className="flex list-decimal flex-col gap-3 pl-5">
                  {START_STEPS.map((s) => (
                    <li key={s}>
                      <p className="font-medium">{t(dyn(`help:start.${s}.title`))}</p>
                      <p className="text-fg-muted">{t(dyn(`help:start.${s}.body`))}</p>
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <>
                <p className="pb-2">{current.paragraphs[0]}</p>
                <ul className="flex list-disc flex-col gap-1 pl-5 text-fg-muted">
                  {current.paragraphs.slice(1).map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </>
            )}
            {isDraft && (
              <p className="pt-4 text-xs text-fg-muted" data-testid="help-draft-note">
                {t('help:reviewNote')}
              </p>
            )}
          </article>
        )}
      </div>
    </>
  );
}
