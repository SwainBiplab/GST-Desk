import { BaseRepo, BusinessRepo, ConflictError, type Row } from '@gst/db';
import {
  FLAG_KEYS,
  PRESETS,
  RULE_46A_DECLARATION,
  deriveFlags,
  diffOverrides,
  type DocumentType,
  type FeatureFlags,
  type PresetId,
} from '@gst/domain';
import {
  Button,
  Card,
  CardTitle,
  Input,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  toast,
} from '@gst/ui';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { setBranding, type BrandingKind } from './create';
import { DetailsFields, PresetPicker, RegistrationFields } from './forms';
import { useFeatureFlags } from './hooks';
import {
  draftToValues,
  readSettings,
  rowToDraft,
  validateDetails,
  validateRegistration,
  type BusinessDraft,
  type Errors,
} from './profile';

import { getBlob } from '@/app/blobs';
import { useConfirm } from '@/app/components/confirm';
import { useAppDb } from '@/app/db';
import { useLocationInfo } from '@/app/hooks';
import { useAppStore } from '@/app/store';
import { useUnsavedGuard } from '@/app/unsaved';
import { AuditViewer } from '@/features/numbering/audit-viewer';
import { NumberingTab } from '@/features/numbering/numbering-tab';
import { Field } from '@/features/onboarding/field';
import { AccountsTab } from '@/features/payments/accounts-tab';
import { PrintTab } from '@/features/print/designer';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Run a business update, turning a stale version into a friendly message. */
function useSave() {
  const { t } = useTranslation();
  return async (action: () => Promise<unknown>) => {
    try {
      await action();
      toast.success(t('settings.saved'));
      return true;
    } catch (e) {
      toast.error(
        e instanceof ConflictError
          ? t('settings.conflict')
          : e instanceof Error
            ? e.message
            : String(e),
      );
      return false;
    }
  };
}

function ProfileTab({ business }: { business: Row }) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const confirm = useConfirm();
  const save = useSave();
  const [saved, setSaved] = useState(() => rowToDraft(business));
  const [draft, setDraft] = useState(saved);
  const [fy, setFy] = useState<number>(business['fy_start_month'] ?? 4);
  const [errors, setErrors] = useState<Errors>({});
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(saved) || fy !== (business['fy_start_month'] ?? 4);
  useUnsavedGuard(dirty);

  const change = (patch: Partial<BusinessDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setErrors({});
  };

  const submit = async () => {
    const found = { ...validateRegistration(draft), ...validateDetails(draft) };
    if (Object.keys(found).length > 0) return setErrors(found);
    if (!database || !ctx) return;
    if (draft.composition !== saved.composition) {
      const ok = await confirm({
        title: t('settings.switchScheme'),
        description: t('settings.switchSchemeBody'),
        confirmLabel: t('settings.confirm'),
      });
      if (!ok) return;
    }
    const values = draftToValues(draft);
    const merged = { ...readSettings(business), ...(values['settings_json'] as object) };
    const done = await save(() =>
      new BusinessRepo(database).update(
        ctx,
        { ...values, fy_start_month: fy, settings_json: merged },
        business['version'],
      ),
    );
    if (done) setSaved(draft);
  };

  return (
    <form
      className="flex flex-col gap-6"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <RegistrationFields draft={draft} onChange={change} errors={errors} />
      <DetailsFields draft={draft} onChange={change} errors={errors} />
      <Field label={t('settings.fyStart')}>
        {(c) => (
          <Select value={String(fy)} onValueChange={(v) => setFy(Number(v))}>
            <SelectTrigger {...c} className="max-w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MONTHS.map((m, i) => (
                <SelectItem key={m} value={String(i + 1)}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>
      <div>
        <Button type="submit" disabled={!dirty} data-testid="save-profile">
          {t('settings.save')}
        </Button>
      </div>
    </form>
  );
}

/** Object URL of an attachment's image, or null. */
function useAttachmentUrl(attachmentId: string | undefined): string | null {
  const { database, ctx } = useAppDb();
  const [url, setUrl] = useState<{ id: string; href: string | null } | null>(null);
  useEffect(() => {
    if (!attachmentId || !database || !ctx) return;
    let cancelled = false;
    let made: string | null = null;
    void (async () => {
      const row = await new BaseRepo(database, 'attachments').get(ctx, attachmentId);
      const blob = row ? await getBlob(row['storage_path'], row['mime'] ?? 'image/png') : null;
      if (cancelled) return;
      made = blob ? URL.createObjectURL(blob) : null;
      setUrl({ id: attachmentId, href: made });
    })();
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [attachmentId, database, ctx]);
  return attachmentId && url?.id === attachmentId ? url.href : null;
}

function BrandingSlot({ kind, business }: { kind: BrandingKind; business: Row }) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const save = useSave();
  const s = readSettings(business);
  const id =
    kind === 'logo'
      ? s.logoAttachmentId
      : kind === 'signature'
        ? s.signatureAttachmentId
        : s.stampAttachmentId;
  const href = useAttachmentUrl(id);
  return (
    <Card className="flex flex-col gap-2" data-testid={`branding-${kind}`}>
      <CardTitle>{t(`settings.branding.${kind}`)}</CardTitle>
      {href ? (
        <img
          src={href}
          alt={t(`settings.branding.${kind}`)}
          className="max-h-32 max-w-full object-contain"
          data-testid={`preview-${kind}`}
        />
      ) : (
        <p className="text-sm text-fg-muted">{t('settings.branding.none')}</p>
      )}
      <Field label={id ? t('settings.branding.replace') : t('settings.branding.choose')}>
        {(c) => (
          <Input
            {...c}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            data-testid={`file-${kind}`}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file && database && ctx)
                void save(() => setBranding(database, ctx, business, kind, file));
            }}
          />
        )}
      </Field>
    </Card>
  );
}

function FeaturesTab({ business }: { business: Row }) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const save = useSave();
  const settings = readSettings(business);
  const scheme = business['scheme'] === 'composition' ? 'composition' : 'regular';
  const [preset, setPreset] = useState<PresetId>(
    (business['preset'] as PresetId | null) ?? 'trader',
  );
  const [overrides, setOverrides] = useState<Partial<FeatureFlags>>(settings.overrides ?? {});
  const flags = deriveFlags(preset, scheme, overrides);

  const persist = (nextPreset: PresetId, nextOverrides: Partial<FeatureFlags>) => {
    if (!database || !ctx) return;
    const preview = PRESETS[nextPreset];
    void save(() =>
      new BusinessRepo(database).update(
        ctx,
        {
          preset: nextPreset,
          settings_json: {
            ...settings,
            overrides: nextOverrides,
            units: preview.units,
            printTemplate: preview.printTemplate,
            documentTypes: preview.documentTypes,
          },
        },
        business['version'],
      ),
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <PresetPicker
        value={preset}
        onChange={(p) => {
          setPreset(p);
          persist(p, overrides);
        }}
      />
      <Card>
        <CardTitle>{t('settings.features.toggles')}</CardTitle>
        <p className="pb-2 text-sm text-fg-muted">{t('settings.features.overrideNote')}</p>
        {scheme === 'composition' && (
          <p className="pb-2 text-sm text-warning">{t('settings.features.composition')}</p>
        )}
        <ul className="flex flex-col gap-2">
          {FLAG_KEYS.map((k) => {
            const locked = scheme === 'composition' && (k === 'taxInvoice' || k === 'billOfSupply');
            return (
              <li key={k} className="flex items-center gap-3">
                <Switch
                  id={`flag-${k}`}
                  data-testid={`flag-${k}`}
                  checked={flags[k]}
                  disabled={locked}
                  onCheckedChange={(on) => {
                    const next = diffOverrides(preset, scheme, { ...flags, [k]: on });
                    setOverrides(next);
                    persist(preset, next);
                  }}
                />
                <label htmlFor={`flag-${k}`}>{t(`settings.features.${k}`)}</label>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

function DocumentsTab({ business }: { business: Row }) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const save = useSave();
  const settings = readSettings(business);
  const preset = (business['preset'] as PresetId | null) ?? 'trader';
  const types: DocumentType[] = settings.documentTypes ?? PRESETS[preset].documentTypes;
  const [terms, setTerms] = useState<Partial<Record<DocumentType, string>>>(settings.terms ?? {});
  const dirty = JSON.stringify(terms) !== JSON.stringify(settings.terms ?? {});
  useUnsavedGuard(dirty);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!database || !ctx) return;
        void save(() =>
          new BusinessRepo(database).update(
            ctx,
            { settings_json: { ...settings, terms } },
            business['version'],
          ),
        );
      }}
    >
      <p className="text-sm text-fg-muted">{t('settings.documents.termsHelp')}</p>
      {types.map((type) => (
        <Field key={type} label={`${t('settings.documents.terms')}: ${type.replace(/_/g, ' ')}`}>
          {(c) => (
            <Textarea
              {...c}
              rows={2}
              data-testid={`terms-${type}`}
              value={terms[type] ?? ''}
              onChange={(e) => setTerms((x) => ({ ...x, [type]: e.target.value }))}
            />
          )}
        </Field>
      ))}
      {business['scheme'] === 'composition' && (
        <p
          className="rounded-md border border-border bg-surface-1 p-3 text-sm"
          data-testid="declaration"
        >
          {t('settings.documents.declaration')} <em>{RULE_46A_DECLARATION}</em>
        </p>
      )}
      <p className="text-sm text-fg-muted">{t('settings.documents.numbering')}</p>
      <div>
        <Button type="submit" disabled={!dirty}>
          {t('settings.save')}
        </Button>
      </div>
    </form>
  );
}

function BusinessesTab() {
  const { t } = useTranslation();
  const { businesses, business, database, ctx } = useAppDb();
  const setBusinessId = useAppStore((s) => s.setBusinessId);
  const confirm = useConfirm();
  const save = useSave();
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {businesses.map((b) => {
          const current = b['id'] === business?.['id'];
          return (
            <li
              key={b['id']}
              data-testid={`business-${b['id']}`}
              className="flex items-center gap-3 rounded-lg border border-border p-3"
            >
              <span className="flex-1">
                <span className="font-medium">{b['trade_name'] ?? b['legal_name']}</span>{' '}
                {current && (
                  <span className="text-xs text-fg-muted">
                    ({t('settings.businesses.current')})
                  </span>
                )}
              </span>
              {!current && (
                <Button variant="outline" onClick={() => setBusinessId(b['id'])}>
                  {t('settings.businesses.switch')}
                </Button>
              )}
              <Button
                variant="ghost"
                disabled={businesses.length <= 1}
                onClick={async () => {
                  if (!database || !ctx) return;
                  const ok = await confirm({
                    title: t('settings.businesses.archiveTitle'),
                    description: t('settings.businesses.archiveBody'),
                    confirmLabel: t('settings.businesses.archive'),
                  });
                  if (!ok) return;
                  const done = await save(() =>
                    new BusinessRepo(database).archive(ctx, b['id'], b['version']),
                  );
                  if (done && current)
                    setBusinessId(businesses.find((x) => x['id'] !== b['id'])?.['id'] ?? null);
                }}
              >
                {t('settings.businesses.archive')}
              </Button>
            </li>
          );
        })}
      </ul>
      {businesses.length <= 1 && (
        <p className="text-sm text-fg-muted">{t('settings.businesses.last')}</p>
      )}
      <div>
        <Button asChild variant="outline">
          <Link to="/welcome" search={{ add: true }} data-testid="add-business">
            {t('settings.businesses.add')}
          </Link>
        </Button>
      </div>
    </div>
  );
}

const TABS = [
  'profile',
  'branding',
  'features',
  'documents',
  'numbering',
  'accounts',
  'print',
  'audit',
  'businesses',
  'inventory',
  'thermal',
  'backup',
] as const;

/** Settings: business profile, images, features, document terms, businesses. Sections follow the feature flags. */
export function SettingsPage() {
  const { t } = useTranslation();
  const { business } = useAppDb();
  const flags = useFeatureFlags();
  const { search } = useLocationInfo();
  const wanted = typeof search['tab'] === 'string' ? search['tab'] : 'profile';
  const visible = TABS.filter((k) =>
    k === 'inventory' ? flags.inventory : k === 'thermal' ? flags.thermal : true,
  );
  const [tab, setTab] = useState<string>(visible.includes(wanted as never) ? wanted : 'profile');

  if (!business) return null;
  return (
    <div>
      <PageHeader title={t('nav.settings')} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label={t('nav.settings')}>
          {visible.map((k) => (
            <TabsTrigger key={k} value={k} data-testid={`tab-${k}`}>
              {t(`settings.tabs.${k}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="profile">
          {/* remount when a different business is selected so the form starts from its values */}
          <ProfileTab key={business['id'] + business['version']} business={business} />
        </TabsContent>
        <TabsContent value="branding">
          <div className="grid gap-3 md:grid-cols-3">
            {(['logo', 'signature', 'stamp'] as const).map((k) => (
              <BrandingSlot key={k} kind={k} business={business} />
            ))}
          </div>
        </TabsContent>
        <TabsContent value="features">
          <FeaturesTab key={business['id']} business={business} />
        </TabsContent>
        <TabsContent value="documents">
          <DocumentsTab key={business['id'] + business['version']} business={business} />
        </TabsContent>
        <TabsContent value="numbering">
          <NumberingTab />
        </TabsContent>
        <TabsContent value="print">
          <PrintTab />
        </TabsContent>
        <TabsContent value="accounts">
          <AccountsTab />
        </TabsContent>
        <TabsContent value="audit">
          <AuditViewer />
        </TabsContent>
        <TabsContent value="businesses">
          <BusinessesTab />
        </TabsContent>
        {flags.inventory && (
          <TabsContent value="inventory">
            <p data-testid="section-inventory">{t('settings.inventory')}</p>
          </TabsContent>
        )}
        {flags.thermal && (
          <TabsContent value="thermal">
            <p data-testid="section-thermal">{t('settings.thermal')}</p>
          </TabsContent>
        )}
        <TabsContent value="backup">
          <p>{t('settings.backup')}</p>
        </TabsContent>
      </Tabs>
    </div>
  );
}
