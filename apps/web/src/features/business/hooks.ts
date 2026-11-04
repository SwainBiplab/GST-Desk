import { SettingsRepo, getOnboardingFacts, type OnboardingFacts } from '@gst/db';
import { deriveFlags, type FeatureFlags, type PresetId } from '@gst/domain';
import { useMemo } from 'react';

import {
  computeChecklist,
  checklistVisible,
  doneIds,
  type Dismissed,
  type Step,
} from './checklist';
import { readSettings } from './profile';

import { useAppDb, useLiveQuery } from '@/app/db';

/** Effective feature flags for the current business: preset, manual overrides, then the tax scheme. */
export function useFeatureFlags(): FeatureFlags {
  const { business } = useAppDb();
  return useMemo(() => {
    const preset = (business?.['preset'] as PresetId | null | undefined) ?? null;
    const scheme = business?.['scheme'] === 'composition' ? 'composition' : 'regular';
    return deriveFlags(preset, scheme, readSettings(business ?? null).overrides ?? {});
  }, [business]);
}

const DISMISS_KEY = 'onboarding.dismissed';
const BACKUP_KEY = 'backup.folder';

export function useChecklist(): {
  steps: Step[];
  visible: boolean;
  ready: boolean;
  dismiss: () => Promise<void>;
} {
  const { business, database, ctx } = useAppDb();
  const facts = useLiveQuery<OnboardingFacts>({
    tables: ['parties', 'items', 'documents', 'payments'],
    key: ['onboarding'],
    fn: (d, c) => getOnboardingFacts(d, c),
  });
  const saved = useLiveQuery({
    tables: ['settings'],
    key: ['onboarding-settings'],
    fn: async (d, c) => {
      const repo = new SettingsRepo(d);
      return {
        dismissed: (await repo.getValue<Dismissed>(c, DISMISS_KEY)) ?? null,
        backup: Boolean(await repo.getValue(c, BACKUP_KEY)),
      };
    },
  });

  const steps = useMemo(
    () =>
      facts.data && saved.data
        ? computeChecklist({
            business: business ?? null,
            facts: facts.data,
            backupFolderSet: saved.data.backup,
          })
        : [],
    [business, facts.data, saved.data],
  );

  return {
    steps,
    ready: steps.length > 0,
    visible: steps.length > 0 && checklistVisible(steps, saved.data?.dismissed ?? null),
    dismiss: async () => {
      if (!database || !ctx) return;
      await new SettingsRepo(database).set(ctx, DISMISS_KEY, {
        done: doneIds(steps),
      } satisfies Dismissed);
    },
  };
}
