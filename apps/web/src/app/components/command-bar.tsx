import { DocumentRepo, ItemRepo, PartyRepo, getRecent, type RecentItem, type Row } from '@gst/db';
import { formatPaise } from '@gst/ui';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  toast,
} from '@gst/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { aiRouter } from '../../lib/ai';
import { useActionContext } from '../action-context';
import {
  filterActions,
  getActions,
  pushRecentAction,
  readRecentActions,
  subscribeActions,
  type Action,
} from '../actions';
import { useAppDb } from '../db';
import { restoreFocus } from '../focus';
import { parseCommand, type Intent } from '../grammar';
import { useAppStore } from '../store';

import { VoiceButton } from '@/features/ai/voice-button';

interface Found {
  parties: Row[];
  items: Row[];
  documents: Row[];
}

const NONE: Found = { parties: [], items: [], documents: [] };

function describe(intent: Intent, party?: string): string {
  if (intent.kind === 'payment') {
    const amount = formatPaise(intent.amountPaise);
    const who = party ?? intent.party;
    return intent.direction === 'made'
      ? `Pay ${amount} to ${who}`
      : `Receive ${amount} from ${who}`;
  }
  if (intent.kind === 'new') {
    const who = party ?? intent.party;
    return `New ${intent.doc.replace('_', ' ')}${who ? ` for ${who}` : ''}`;
  }
  return `Go to ${intent.page}`;
}

/** Ctrl+K / "/" command bar: actions, typed commands, and FTS search over parties, items and documents. */
export function CommandBar() {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.commandOpen);
  const setOpen = useAppStore((s) => s.setCommandOpen);
  return (
    <Dialog open={open} onOpenChange={(o) => setOpen(o)}>
      <DialogContent
        className="top-[15%] w-[min(40rem,calc(100vw-2rem))] translate-y-0 p-0"
        data-testid="command-bar"
        onCloseAutoFocus={restoreFocus}
      >
        <DialogTitle className="sr-only">{t('command.title')}</DialogTitle>
        <DialogDescription className="sr-only">{t('command.description')}</DialogDescription>
        {/* mounted only while open, so every opening starts from fresh state */}
        <CommandPanel />
      </DialogContent>
    </Dialog>
  );
}

function CommandPanel() {
  const { t } = useTranslation();
  const setOpen = useAppStore((s) => s.setCommandOpen);
  const { database, ctx } = useAppDb();
  const actionCtx = useActionContext();

  const [query, setQuery] = useState(() => useAppStore.getState().commandPrefill);
  const [search, setSearch] = useState<{
    q: string;
    found: Found;
    party: string | undefined;
    ms: number;
  } | null>(null);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [, bump] = useState(0);
  const seq = useRef(0);

  useEffect(() => subscribeActions(() => bump((n) => n + 1)), []);

  // recent rows for the empty state
  useEffect(() => {
    if (!database || !ctx) return;
    void getRecent(database, ctx, 6).then(setRecent);
  }, [database, ctx]);

  const intent = useMemo(() => parseCommand(query), [query]);

  // search parties, items and documents as the query changes (results arrive asynchronously)
  useEffect(() => {
    const q = query.trim();
    const mine = ++seq.current;
    if (!q || !database || !ctx) return;
    const started = performance.now();
    const partyText = intent && 'party' in intent && intent.party ? intent.party : null;
    void (async () => {
      const [parties, items, documents, target] = await Promise.all([
        new PartyRepo(database).search(ctx, q, 5),
        new ItemRepo(database).search(ctx, q, 5),
        new DocumentRepo(database).search(ctx, q, 5),
        partyText
          ? new PartyRepo(database).search(ctx, partyText, 1)
          : Promise.resolve([] as Row[]),
      ]).catch(() => [[], [], [], []] as Row[][]);
      if (mine !== seq.current) return;
      setSearch({
        q,
        found: { parties, items, documents },
        party: target[0]?.['name'],
        ms: Math.round(performance.now() - started),
      });
    })();
  }, [query, database, ctx, intent]);

  const close = useCallback(() => setOpen(false), [setOpen]);

  const runAction = useCallback(
    async (a: Action) => {
      pushRecentAction(a.id);
      close();
      try {
        await a.run(actionCtx);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    },
    [actionCtx, close],
  );

  const goTo = useCallback(
    (page: string, search?: Record<string, unknown>) => {
      close();
      actionCtx.navigate(`/${actionCtx.shell ?? 'books'}/${page}`, search);
    },
    [actionCtx, close],
  );

  const runIntent = useCallback(() => {
    if (!intent) return;
    const search = { cmd: query.trim() };
    if (intent.kind === 'payment') goTo('payments', search);
    else if (intent.kind === 'new') goTo(intent.doc === 'purchase' ? 'documents' : 'sell', search);
    else goTo(intent.page);
  }, [intent, query, goTo]);

  const ask = useCallback(async () => {
    close();
    const r = await aiRouter.suggest(
      { feature: 'command_nl', input: { text: query.trim() } },
      z.unknown(),
    );
    if (!r.ok) toast.info(t('command.askUnavailable'));
  }, [close, query, t]);

  const allActions = getActions(actionCtx);
  const q = query.trim();
  const matchedActions = useMemo(
    () => filterActions(allActions, q, { recent: readRecentActions(), limit: q ? 8 : 5 }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allActions.length, q, actionCtx.shell, actionCtx.businessId],
  );

  const current = search && search.q === q ? search : null;
  const found = current?.found ?? NONE;
  const resolvedParty = current?.party;
  const ms = current?.ms ?? null;
  const hasRows = found.parties.length + found.items.length + found.documents.length > 0;

  return (
    <Command shouldFilter={false} loop>
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={t('command.placeholder')}
        data-testid="command-input"
      />
      <div className="flex items-center justify-end gap-1 border-b border-border px-2 py-1">
        <VoiceButton compact onClose={close} />
      </div>
      <CommandList data-testid="command-results" data-search-ms={ms ?? ''}>
        {intent && (
          <CommandGroup heading={t('command.command')}>
            <CommandItem value="intent" onSelect={runIntent} data-testid="command-intent">
              {describe(intent, resolvedParty)}
            </CommandItem>
          </CommandGroup>
        )}

        {matchedActions.length > 0 && (
          <CommandGroup heading={q ? t('command.actions') : t('command.recent')}>
            {matchedActions.map((a) => (
              <CommandItem key={a.id} value={`action:${a.id}`} onSelect={() => void runAction(a)}>
                <span className="flex-1">{a.title}</span>
                <span className="text-xs text-fg-muted">{a.shortcut ?? a.section}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {found.parties.length > 0 && (
          <CommandGroup heading={t('command.parties')}>
            {found.parties.map((p) => (
              <CommandItem
                key={p['id']}
                value={`party:${p['id']}`}
                onSelect={() => goTo('parties', { open: p['id'] })}
              >
                <span className="flex-1">{p['name']}</span>
                <span className="text-xs text-fg-muted">{p['gstin'] ?? ''}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {found.items.length > 0 && (
          <CommandGroup heading={t('command.items')}>
            {found.items.map((i) => (
              <CommandItem
                key={i['id']}
                value={`item:${i['id']}`}
                onSelect={() => goTo('items', { open: i['id'] })}
              >
                <span className="flex-1">{i['name']}</span>
                <span className="text-xs text-fg-muted">{i['sku'] ?? ''}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {found.documents.length > 0 && (
          <CommandGroup heading={t('command.documents')}>
            {found.documents.map((d) => (
              <CommandItem
                key={d['id']}
                value={`doc:${d['id']}`}
                onSelect={() => goTo('documents', { open: d['id'] })}
              >
                <span className="flex-1">{d['number'] ?? `Draft ${d['type']}`}</span>
                <span className="text-xs text-fg-muted">{d['party_name'] ?? ''}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {!q && recent.length > 0 && (
          <CommandGroup heading={t('command.recent')}>
            {recent.map((r) => (
              <CommandItem
                key={`${r.kind}:${r.id}`}
                value={`recent:${r.kind}:${r.id}`}
                onSelect={() =>
                  goTo(r.kind === 'party' ? 'parties' : r.kind === 'item' ? 'items' : 'documents', {
                    open: r.id,
                  })
                }
              >
                <span className="flex-1">{r.title}</span>
                <span className="text-xs text-fg-muted">{r.subtitle || r.kind}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {q && !intent && (
          <CommandGroup heading={t('command.ask')}>
            <CommandItem value="ask" onSelect={() => void ask()} data-testid="command-ask">
              {t('command.ask')}: “{q}”
            </CommandItem>
          </CommandGroup>
        )}
        {q && !intent && matchedActions.length === 0 && !hasRows && (
          <CommandEmpty>{t('command.empty')}</CommandEmpty>
        )}
      </CommandList>
      {ms !== null && (
        <p className="px-3 py-1 text-xs text-fg-muted">{t('command.searchMs', { ms })}</p>
      )}
    </Command>
  );
}
