import type { Language } from '@gst/i18n';
import {
  Badge,
  Button,
  Input,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@gst/ui';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Field } from './field';

import { useAppDb } from '@/app/db';
import { useAppStore } from '@/app/store';
import { ChecklistCard } from '@/features/business/checklist-card';
import { createBusiness } from '@/features/business/create';
import {
  BankFields,
  DetailsFields,
  PresetPicker,
  RegistrationFields,
} from '@/features/business/forms';
import {
  emptyDraft,
  validateBank,
  validateDetails,
  validateRegistration,
  type BusinessDraft,
  type Errors,
} from '@/features/business/profile';
import { changeLanguage } from '@/lib/i18n';

const ALL = ['language', 'start', 'registration', 'details', 'preset', 'bank', 'done'] as const;
const ADD = ['registration', 'details', 'preset', 'bank', 'done'] as const;
type StepId = (typeof ALL)[number];

const LANGUAGES: [string, string][] = [
  ['en', 'English'],
  ['hi', 'हिन्दी'],
  ['mr', 'मराठी'],
  ['ta', 'தமிழ்'],
  ['bn', 'বাংলা'],
  ['gu', 'ગુજરાતી'],
];

function validate(step: StepId, d: BusinessDraft): Errors {
  if (step === 'registration') return validateRegistration(d);
  if (step === 'details') return validateDetails(d);
  if (step === 'bank') return validateBank(d.bank);
  return {};
}

/**
 * First-run and "add business" wizard. State lives here, so Back never loses input. Each step is a form:
 * Enter moves on, and the first field of a step is focused when it appears.
 */
export function Wizard({ addMode = false }: { addMode?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { database, ctx, loadDemoData } = useAppDb();
  const setBusinessId = useAppStore((s) => s.setBusinessId);
  const setShell = useAppStore((s) => s.setShell);

  const steps = addMode ? ADD : ALL;
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState<BusinessDraft>(() => ({
    ...emptyDraft(),
    shell: useAppStore.getState().shell,
  }));
  const [logo, setLogo] = useState<File | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLFormElement>(null);

  const step = steps[index]!;
  const change = (patch: Partial<BusinessDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setErrors({});
  };

  // move focus to the step's first field (or its heading) whenever the step changes
  useEffect(() => {
    const el =
      panel.current?.querySelector<HTMLElement>('[data-autofocus]') ??
      panel.current?.querySelector<HTMLElement>('h2');
    el?.focus();
  }, [step]);

  const focusFirstError = () =>
    requestAnimationFrame(() =>
      panel.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
    );

  const finish = async () => {
    if (!database) return;
    setBusy(true);
    try {
      const biz = await createBusiness(database, draft, {
        ...(addMode && ctx ? { orgId: ctx.orgId } : {}),
        logo,
      });
      setBusinessId(biz['id']);
      setShell(draft.shell);
      setIndex(steps.indexOf('done'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const next = async (e?: FormEvent) => {
    e?.preventDefault();
    if (step === 'done') return;
    const found = validate(step, draft);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      focusFirstError();
      return;
    }
    if (step === 'language') {
      // the app switches to the chosen language now, and keeps it on this device
      await changeLanguage(draft.language as Language);
      setShell(draft.shell);
    }
    if (step === 'start' && draft.start === 'sample') {
      setBusy(true);
      try {
        await loadDemoData();
        setIndex(steps.indexOf('done'));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (step === 'bank') return finish();
    setIndex((i) => i + 1);
  };

  const back = () => {
    setErrors({});
    setIndex((i) => Math.max(0, i - 1));
  };

  const isLast = step === 'bank';
  // creating anything needs the database; it opens in the background, so wait for it instead of doing nothing
  const waitingForDb = !database && (isLast || (step === 'start' && draft.start === 'sample'));
  const total = steps.length - 1; // the "done" screen is not counted

  return (
    <main
      className="mx-auto flex min-h-screen max-w-2xl flex-col gap-4 p-6"
      data-testid="wizard"
      data-step={step}
    >
      <header>
        <p className="text-sm text-fg-muted">{t('app.name')}</p>
        <h1 className="text-2xl font-semibold">{t('welcome.title')}</h1>
        {step !== 'done' && (
          <p className="text-sm text-fg-muted" aria-live="polite">
            {t('welcome.stepOf', { n: index + 1, total })}
          </p>
        )}
      </header>

      <form
        ref={panel}
        onSubmit={(e) => void next(e)}
        noValidate
        className="flex flex-col gap-5"
        aria-busy={busy}
      >
        <h2 tabIndex={-1} className="text-lg font-semibold outline-none">
          {t(`welcome.steps.${step}`)}
        </h2>

        {step === 'language' && (
          <div className="flex flex-col gap-5">
            <Field label={t('welcome.language.label')} hint={t('welcome.language.note')}>
              {(c) => (
                <Select value={draft.language} onValueChange={(language) => change({ language })}>
                  <SelectTrigger {...c} data-autofocus data-testid="language-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LANGUAGES.map(([code, name]) => (
                      <SelectItem key={code} value={code}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
            <fieldset className="flex flex-col gap-2">
              <legend className="pb-1 text-sm font-medium">{t('welcome.mode.label')}</legend>
              <RadioGroup
                value={draft.shell}
                onValueChange={(shell) => change({ shell: shell as 'shop' | 'books' })}
                aria-label={t('welcome.mode.label')}
              >
                {(['shop', 'books'] as const).map((s) => (
                  <label
                    key={s}
                    htmlFor={`shell-${s}`}
                    className="flex items-start gap-3 rounded-lg border border-border p-3"
                  >
                    <RadioGroupItem id={`shell-${s}`} value={s} />
                    <span>
                      <span className="block font-medium">{t(`shell.${s}`)}</span>
                      <span className="block text-sm text-fg-muted">{t(`welcome.mode.${s}`)}</span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
            </fieldset>
          </div>
        )}

        {step === 'start' && (
          <RadioGroup
            value={draft.start}
            onValueChange={(start) => change({ start: start as 'blank' | 'sample' })}
            aria-label={t('welcome.start.label')}
            className="flex flex-col gap-2"
          >
            <label
              htmlFor="start-import"
              className="flex items-start gap-3 rounded-lg border border-border p-3 opacity-60"
            >
              <RadioGroupItem id="start-import" value="import" disabled />
              <span className="flex-1">
                {t('welcome.start.import')} <Badge>{t('welcome.start.importSoon')}</Badge>
              </span>
            </label>
            <label
              htmlFor="start-blank"
              className="flex items-start gap-3 rounded-lg border border-border p-3"
            >
              <RadioGroupItem
                id="start-blank"
                value="blank"
                data-autofocus={draft.start === 'blank' ? true : undefined}
              />
              <span className="font-medium">{t('welcome.start.blank')}</span>
            </label>
            <label
              htmlFor="start-sample"
              className="flex items-start gap-3 rounded-lg border border-border p-3"
            >
              <RadioGroupItem
                id="start-sample"
                value="sample"
                data-autofocus={draft.start === 'sample' ? true : undefined}
              />
              <span>
                <span className="block font-medium">{t('welcome.start.sample')}</span>
                <span className="block text-sm text-fg-muted">{t('welcome.start.sampleHelp')}</span>
              </span>
            </label>
          </RadioGroup>
        )}

        {step === 'registration' && (
          <RegistrationFields draft={draft} onChange={change} errors={errors} />
        )}

        {step === 'details' && (
          <>
            <DetailsFields draft={draft} onChange={change} errors={errors} />
            <Field label={t('welcome.details.logo')} hint={t('welcome.details.logoHelp')}>
              {(c) => (
                <Input
                  {...c}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  data-testid="logo-input"
                  onChange={(e) => setLogo(e.target.files?.[0] ?? null)}
                />
              )}
            </Field>
          </>
        )}

        {step === 'preset' && (
          <PresetPicker value={draft.preset} onChange={(preset) => change({ preset })} />
        )}

        {step === 'bank' && (
          <BankFields
            bank={draft.bank}
            onChange={(patch) => change({ bank: { ...draft.bank, ...patch } })}
            errors={errors}
          />
        )}

        {step === 'done' && (
          <div className="flex flex-col gap-3">
            <p>{t('welcome.done.body')}</p>
            <ChecklistCard force />
            <div>
              <Button
                type="button"
                data-autofocus
                data-testid="go-dashboard"
                onClick={() =>
                  void navigate({
                    to: draft.shell === 'books' ? '/books/$page' : '/shop/$page',
                    params: { page: 'dashboard' },
                  })
                }
              >
                {t('welcome.goDashboard')}
              </Button>
            </div>
          </div>
        )}

        {step !== 'done' && (
          <div className="flex items-center gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={back}
              disabled={index === 0 || busy}
              data-testid="wizard-back"
            >
              {t('welcome.back')}
            </Button>
            {isLast && !draft.bank.enabled && (
              <Button
                type="button"
                variant="ghost"
                disabled={busy || waitingForDb}
                onClick={() => void finish()}
                data-testid="wizard-skip"
              >
                {t('welcome.skip')}
              </Button>
            )}
            <Button
              type="submit"
              disabled={busy || waitingForDb}
              data-testid="wizard-next"
              className="ml-auto"
            >
              {busy ? t('welcome.creating') : isLast ? t('welcome.finish') : t('welcome.next')}
            </Button>
          </div>
        )}
        {waitingForDb && <p className="text-xs text-fg-muted">{t('empty.loading')}</p>}
      </form>
    </main>
  );
}
