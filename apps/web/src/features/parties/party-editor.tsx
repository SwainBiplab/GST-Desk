import { duplicatePartySchema, type DuplicateMatch } from '@gst/ai';
import { PartyRepo, type Row } from '@gst/db';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  Button,
  toast,
} from '@gst/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { draftToValues, rowToDraft, type FormMode, type PartyDraft } from './form';
import { usePartyRouter } from './hooks';
import { PartyForm } from './party-form';

import { useAppDb } from '@/app/db';
import { useAppNavigate } from '@/app/hooks';
import { useAppStore } from '@/app/store';
import { dyn } from '@/lib/dyn-key';

/** Candidates that look like the party being saved. Uses the Tier 0 rules provider (offline). */
export function useDuplicateCheck() {
  const router = usePartyRouter();
  return async (draft: PartyDraft, ignoreId?: string): Promise<DuplicateMatch[]> => {
    if (!router) return [];
    const values = draftToValues(draft);
    const r = await router.suggest(
      {
        feature: 'duplicate_party',
        input: { name: values['name'], gstin: values['gstin'], phone: values['phone'] },
      },
      duplicatePartySchema,
    );
    return r.ok ? r.value.matches.filter((m) => m.id !== ignoreId) : [];
  };
}

const REASONS: Record<DuplicateMatch['reasons'][number], string> = {
  gstin: 'parties.dup.gstin',
  phone: 'parties.dup.phone',
  name: 'parties.dup.name',
  similar_name: 'parties.dup.similar',
};

function DuplicatesDialog({
  matches,
  onOpen,
  onMerge,
  onSaveAnyway,
  onCancel,
}: {
  matches: DuplicateMatch[];
  onOpen: (id: string) => void;
  onMerge: (id: string) => void;
  onSaveAnyway: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog open onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent
        data-testid="duplicates-dialog"
        className="w-[min(36rem,calc(100vw-2rem))]"
      >
        <AlertDialogTitle className="text-lg font-semibold">
          {t('parties.dup.title')}
        </AlertDialogTitle>
        <AlertDialogDescription className="py-1 text-fg-muted">
          {t('parties.dup.body')}
        </AlertDialogDescription>
        <ul className="flex flex-col gap-2 py-2">
          {matches.map((m) => (
            <li
              key={m.id}
              data-testid="duplicate-candidate"
              className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2"
            >
              <span className="flex-1">
                <span className="font-medium">{m.name}</span>
                <span className="block text-xs text-fg-muted">
                  {m.reasons.map((r) => t(dyn(REASONS[r]))).join(', ')} |{' '}
                  {Math.round(m.score * 100)}%
                </span>
              </span>
              <Button type="button" variant="outline" onClick={() => onOpen(m.id)}>
                {t('parties.dup.open')}
              </Button>
              <Button
                type="button"
                variant="outline"
                data-testid="merge-into"
                onClick={() => onMerge(m.id)}
              >
                {t('parties.dup.mergeInto')}
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('parties.form.cancel')}
          </Button>
          <Button type="button" data-testid="save-anyway" onClick={onSaveAnyway}>
            {t('parties.dup.saveAnyway')}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Create or edit one party: validate, check for duplicates, save. `existing` makes it an edit.
 * `onDone` receives the saved row.
 */
export function PartyEditor({
  existing,
  mode = 'full',
  onDone,
  onCancel,
}: {
  existing?: Row;
  mode?: FormMode;
  onDone: (saved: Row) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const navigate = useAppNavigate();
  const shell = useAppStore((s) => s.shell);
  const check = useDuplicateCheck();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ draft: PartyDraft; matches: DuplicateMatch[] } | null>(
    null,
  );

  const save = async (draft: PartyDraft) => {
    if (!database || !ctx) return;
    setBusy(true);
    try {
      const repo = new PartyRepo(database);
      const values = draftToValues(draft);
      const saved = existing
        ? await repo.update(ctx, existing['id'], values, existing['version'])
        : await repo.create(ctx, values);
      toast.success(t('parties.saved'));
      onDone(saved);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const submit = async (draft: PartyDraft) => {
    const matches = await check(draft, existing?.['id']);
    if (matches.length > 0) setPending({ draft, matches });
    else await save(draft);
  };

  /** Use an existing party instead of creating a new one: fill its empty fields from what was typed. */
  const mergeInto = async (id: string, draft: PartyDraft) => {
    if (!database || !ctx) return;
    setBusy(true);
    try {
      const repo = new PartyRepo(database);
      const target = await repo.get(ctx, id);
      if (!target) return;
      const values = draftToValues(draft);
      const fill = Object.fromEntries(
        ['gstin', 'pan', 'phone', 'email', 'city', 'trade_name']
          .filter((k) => !target[k] && values[k])
          .map((k) => [k, values[k]]),
      );
      const saved =
        Object.keys(fill).length > 0 ? await repo.update(ctx, id, fill, target['version']) : target;
      toast.success(t('parties.dup.merged', { name: target['name'] }));
      onDone(saved);
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  return (
    <>
      <PartyForm
        mode={mode}
        {...(existing ? { initial: rowToDraft(existing) } : {})}
        busy={busy}
        onSubmit={submit}
        onCancel={onCancel}
        submitLabel={existing ? t('parties.form.saveChanges') : t('parties.form.save')}
      />
      {pending && (
        <DuplicatesDialog
          matches={pending.matches}
          onCancel={() => setPending(null)}
          onSaveAnyway={() => void save(pending.draft)}
          onMerge={(id) => void mergeInto(id, pending.draft)}
          onOpen={(id) => {
            setPending(null);
            navigate(`/${shell}/parties`, { open: id });
          }}
        />
      )}
    </>
  );
}
