import { SettingsRepo, TemplateRepo, type Shell } from '@gst/db';
import {
  PRINT_LABEL_KEYS,
  PRINT_LANGUAGES,
  PRINT_LANGUAGE_NAMES,
  printLabel,
  type PrintLabelKey,
  type PrintLanguage,
} from '@gst/i18n';
import {
  BANK,
  UPI,
  PAGE_SIZES,
  TemplateError,
  exportTemplate,
  layoutDocument,
  moveBlock,
  parseTemplate,
  receiptLines,
  receiptText,
  reorderBlock,
  samplePrintModel,
  thermalColumns,
  toggleBlock,
  toggleColumn,
  zoneOf,
  type BlockType,
  type ColumnKey,
  type TemplateSpec,
  type Zone,
} from '@gst/print';
import {
  Badge,
  Button,
  Card,
  CardTitle,
  Checkbox,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  toast,
} from '@gst/ui';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { downloadText } from '../parties/csv';

import { BULK_PATTERN_KEY, DEFAULT_BULK_PATTERN } from './bulk-export';
import { familiesFor, usePrintFonts } from './fonts-client';
import { PageView } from './page-view';
import { usePrintContext } from './use-print-model';
import { useTemplates, type TemplateOption } from './use-templates';

import { useAppDb, useLiveQuery } from '@/app/db';
import { Field } from '@/features/onboarding/field';

const DOC_TYPES = [
  'tax_invoice',
  'bill_of_supply',
  'quotation',
  'credit_note',
  'debit_note',
  'delivery_challan',
  'purchase_bill',
] as const;
const SWATCHES = ['#1a3c6e', '#0f766e', '#7c2d12', '#6d28d9', '#be123c', '#222222'];
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const SUPPLIES = ['intra', 'inter', 'export', 'rcm'] as const;

function ColourField({
  label,
  value,
  onChange,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  testId: string;
}) {
  return (
    <Field label={label}>
      {(c) => (
        <div className="flex items-center gap-2">
          <input
            {...c}
            type="color"
            value={value}
            data-testid={testId}
            className="h-9 w-12 cursor-pointer rounded border border-border bg-bg p-1"
            onChange={(e) => onChange(e.target.value)}
          />
          <div className="flex gap-1">
            {SWATCHES.map((s) => (
              <button
                key={s}
                type="button"
                aria-label={s}
                className="h-5 w-5 rounded-full border border-border"
                style={{ background: s }}
                onClick={() => onChange(s)}
              />
            ))}
          </div>
        </div>
      )}
    </Field>
  );
}

function Section({ title, children, id }: { title: string; children: ReactNode; id: string }) {
  return (
    <Card className="p-3" data-testid={`designer-${id}`}>
      <CardTitle className="pb-2 text-base">{title}</CardTitle>
      <div className="flex flex-col gap-3">{children}</div>
    </Card>
  );
}

/**
 * Settings → Print: pick or make a template and watch the page change as you design it. Everything is
 * the template spec, so a template can be saved, made the default for a document type, exported and
 * imported on another machine.
 */
export function PrintTab() {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const { options } = useTemplates();
  const pc = usePrintContext();
  const importRef = useRef<HTMLInputElement>(null);

  const [selectedId, setSelectedId] = useState('preset:classic');
  // the spec being edited; null follows the selected template untouched
  const [draft, setDraft] = useState<TemplateSpec | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [previewType, setPreviewType] = useState<(typeof DOC_TYPES)[number]>('tax_invoice');
  const [supply, setSupply] = useState<(typeof SUPPLIES)[number]>('intra');
  const [labelFilter, setLabelFilter] = useState('');

  const selected: TemplateOption = options.find((o) => o.id === selectedId) ?? options[0]!;
  const spec = draft ?? selected.spec;
  const nameShown = name ?? selected.name;
  const dirty = draft !== null || name !== null;

  const edit = (f: (s: TemplateSpec) => TemplateSpec) => setDraft(f(spec));
  const choose = (id: string) => {
    setSelectedId(id);
    setDraft(null);
    setName(null);
  };

  const defaults = useLiveQuery<Record<string, Partial<Record<Shell, string>>>>({
    tables: ['settings', 'templates'],
    key: ['designer-defaults'],
    fn: (d, c) => new TemplateRepo(d).getDefaults(c),
  }).data;

  const pattern = useLiveQuery<string | undefined>({
    tables: ['settings'],
    key: ['bulk-pattern'],
    fn: (d, c) => new SettingsRepo(d).getValue<string>(c, BULK_PATTERN_KEY),
  });

  // the preview: a sample document built by the real engine, in the template's language
  const model = useMemo(
    () =>
      samplePrintModel({
        type: previewType,
        lines: 6,
        pos: supply === 'inter' ? '29' : '27',
        export: supply === 'export',
        reverseCharge: supply === 'rcm',
        ...(previewType === 'bill_of_supply' ? { gstRateBp: 0 } : {}),
        // the real business, and sample bank details when it has none, so the block can still be designed
        ...(pc
          ? { business: pc.business, accounts: pc.accounts.length > 0 ? pc.accounts : [BANK, UPI] }
          : {}),
      }),
    [previewType, supply, pc],
  );
  const fonts = usePrintFonts(familiesFor(model, spec));
  const pages = useMemo(
    () => (fonts ? layoutDocument(model, spec, { measurer: fonts.measurer }).pages : null),
    [fonts, model, spec],
  );
  const receipt = useMemo(
    () => receiptText(receiptLines(model, spec), thermalColumns(spec.thermal.widthMm)),
    [model, spec],
  );

  /* ---- saving, deleting, importing, exporting ---- */

  const saveAsNew = async () => {
    if (!database || !ctx) return;
    try {
      const made = await new TemplateRepo(database).createTemplate(ctx, nameShown, {
        ...spec,
        name: nameShown,
      });
      toast.success(t('print.designer.saved'));
      setSelectedId(String(made['id']));
      setDraft(null);
      setName(null);
    } catch (e) {
      toast.error(errText(e));
    }
  };
  const save = async () => {
    if (!database || !ctx || !selected.row) return;
    try {
      const row = await new TemplateRepo(database).updateTemplate(
        ctx,
        selected.row['id'],
        selected.row['version'],
        nameShown,
        { ...spec, name: nameShown },
      );
      toast.success(t('print.designer.saved'));
      setSelectedId(String(row['id']));
      setDraft(null);
      setName(null);
    } catch (e) {
      toast.error(errText(e));
    }
  };
  const remove = async () => {
    if (!database || !ctx || !selected.row) return;
    try {
      await new TemplateRepo(database).deleteTemplate(
        ctx,
        selected.row['id'],
        selected.row['version'],
      );
      toast.success(t('print.designer.deleted'));
      choose('preset:classic');
    } catch (e) {
      toast.error(errText(e));
    }
  };
  const importFile = async (file: File) => {
    try {
      const imported = parseTemplate(await file.text());
      setSelectedId('preset:classic');
      setDraft(imported);
      setName(imported.name);
      toast.success(t('print.designer.imported'));
    } catch (e) {
      toast.error(e instanceof TemplateError ? e.message : errText(e));
    }
  };
  const setDefault = async (type: string, shell: Shell, on: boolean) => {
    if (!database || !ctx) return;
    try {
      await new TemplateRepo(database).setDefault(ctx, type, shell, on ? selected.id : null);
    } catch (e) {
      toast.error(errText(e));
    }
  };

  /* ---- label overrides ---- */

  const lang: PrintLanguage = spec.language;
  const overrides = (spec.labels[lang] ?? {}) as Partial<Record<PrintLabelKey, string>>;
  const shownLabels = PRINT_LABEL_KEYS.filter((k) => {
    const q = labelFilter.trim().toLowerCase();
    return !q || k.toLowerCase().includes(q) || printLabel('en', k).toLowerCase().includes(q);
  }).slice(0, 24);
  const setLabel = (k: PrintLabelKey, v: string) =>
    edit((s) => {
      const cur = { ...((s.labels[lang] ?? {}) as Record<string, string>) };
      if (v.trim()) cur[k] = v;
      else delete cur[k]; // eslint-disable-line @typescript-eslint/no-dynamic-delete
      return { ...s, labels: { ...s.labels, [lang]: cur } };
    });

  const dragged = useRef<BlockType | null>(null);
  const ZONES: { zone: Zone; label: string }[] = [
    { zone: 'top', label: t('print.designer.zoneTop') },
    { zone: 'table', label: t('print.designer.zoneTable') },
    { zone: 'closing', label: t('print.designer.zoneClosing') },
    { zone: 'pageFooter', label: t('print.designer.zoneFooter') },
  ];

  return (
    <div
      className="grid gap-4 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]"
      data-testid="print-tab"
    >
      <div className="flex min-w-0 flex-col gap-3">
        <Card className="p-3">
          <CardTitle className="pb-2 text-base">{t('print.designer.templates')}</CardTitle>
          <ul className="flex flex-col gap-1" data-testid="template-list">
            {options.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  data-testid="template-option"
                  data-id={o.id}
                  aria-pressed={o.id === selectedId}
                  className={`flex w-full items-center gap-2 rounded-md border px-2 py-1 text-left text-sm ${
                    o.id === selectedId
                      ? 'border-accent bg-surface-2'
                      : 'border-border hover:bg-surface-1'
                  }`}
                  onClick={() => choose(o.id)}
                >
                  <span className="flex-1">{o.name}</span>
                  {!o.saved && <Badge tone="neutral">{t('print.designer.preset')}</Badge>}
                </button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2 pt-3">
            <Button
              variant="outline"
              data-testid="template-import"
              onClick={() => importRef.current?.click()}
            >
              {t('print.designer.import')}
            </Button>
            <Button
              variant="outline"
              data-testid="template-export"
              onClick={() =>
                downloadText(
                  `${nameShown.replace(/\W+/g, '-')}.template.json`,
                  exportTemplate({ ...spec, name: nameShown }),
                  'application/json',
                )
              }
            >
              {t('print.designer.export')}
            </Button>
            <input
              ref={importRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              data-testid="template-import-file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importFile(f);
                e.target.value = '';
              }}
            />
          </div>
        </Card>

        <Section title={t('print.designer.basics')} id="basics">
          <Field label={t('print.designer.name')}>
            {(c) => (
              <Input
                {...c}
                data-testid="template-name"
                value={nameShown}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('print.designer.language')}>
              {(c) => (
                <Select
                  value={spec.language}
                  onValueChange={(v) => edit((s) => ({ ...s, language: v as PrintLanguage }))}
                >
                  <SelectTrigger {...c} data-testid="template-language">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRINT_LANGUAGES.map((l) => (
                      <SelectItem key={l} value={l}>
                        {PRINT_LANGUAGE_NAMES[l]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
            <Field label={t('print.designer.pageSize')}>
              {(c) => (
                <Select
                  value={spec.page.size}
                  onValueChange={(v) =>
                    edit((s) => ({ ...s, page: { ...s.page, size: v as keyof typeof PAGE_SIZES } }))
                  }
                >
                  <SelectTrigger {...c} data-testid="template-page-size">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(PAGE_SIZES) as (keyof typeof PAGE_SIZES)[]).map((k) => (
                      <SelectItem key={k} value={k}>
                        {PAGE_SIZES[k].name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
              <Field key={side} label={t(`print.designer.margin.${side}`)}>
                {(c) => (
                  <Input
                    {...c}
                    inputMode="numeric"
                    data-testid={`template-margin-${side}`}
                    value={String(spec.page.margin[side])}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isFinite(n) && n >= 0 && n <= 200)
                        edit((s) => ({
                          ...s,
                          page: { ...s.page, margin: { ...s.page.margin, [side]: n } },
                        }));
                    }}
                  />
                )}
              </Field>
            ))}
          </div>
        </Section>

        <Section title={t('print.designer.look')} id="look">
          <div className="grid gap-3 sm:grid-cols-2">
            <ColourField
              label={t('print.designer.accent')}
              value={spec.theme.accent}
              testId="template-accent"
              onChange={(v) => edit((s) => ({ ...s, theme: { ...s.theme, accent: v } }))}
            />
            <ColourField
              label={t('print.designer.headerFill')}
              value={spec.theme.headerFill}
              testId="template-header-fill"
              onChange={(v) => edit((s) => ({ ...s, theme: { ...s.theme, headerFill: v } }))}
            />
            <ColourField
              label={t('print.designer.headerText')}
              value={spec.theme.headerText}
              testId="template-header-text"
              onChange={(v) => edit((s) => ({ ...s, theme: { ...s.theme, headerText: v } }))}
            />
            <ColourField
              label={t('print.designer.border')}
              value={spec.theme.border}
              testId="template-border"
              onChange={(v) => edit((s) => ({ ...s, theme: { ...s.theme, border: v } }))}
            />
          </div>
          <Field label={`${t('print.designer.fontSize')}: ${spec.font.size} pt`}>
            {(c) => (
              <input
                {...c}
                type="range"
                min={6}
                max={14}
                step={0.5}
                value={spec.font.size}
                data-testid="template-font-size"
                onChange={(e) =>
                  edit((s) => ({ ...s, font: { ...s.font, size: Number(e.target.value) } }))
                }
              />
            )}
          </Field>
          <Field label={`${t('print.designer.titleScale')}: ${spec.font.titleScale.toFixed(1)}×`}>
            {(c) => (
              <input
                {...c}
                type="range"
                min={1}
                max={3}
                step={0.1}
                value={spec.font.titleScale}
                onChange={(e) =>
                  edit((s) => ({ ...s, font: { ...s.font, titleScale: Number(e.target.value) } }))
                }
              />
            )}
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={spec.style.titleBand}
              data-testid="template-band"
              onCheckedChange={(v) => edit((s) => ({ ...s, style: { ...s.style, titleBand: v } }))}
            />
            {t('print.designer.titleBand')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={spec.style.zebra}
              data-testid="template-zebra"
              onCheckedChange={(v) => edit((s) => ({ ...s, style: { ...s.style, zebra: v } }))}
            />
            {t('print.designer.zebra')}
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('print.designer.grid')}>
              {(c) => (
                <Select
                  value={spec.style.grid}
                  onValueChange={(v) =>
                    edit((s) => ({
                      ...s,
                      style: { ...s.style, grid: v as 'lines' | 'box' | 'none' },
                    }))
                  }
                >
                  <SelectTrigger {...c} data-testid="template-grid">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="lines">{t('print.designer.gridLines')}</SelectItem>
                    <SelectItem value="box">{t('print.designer.gridBox')}</SelectItem>
                    <SelectItem value="none">{t('print.designer.gridNone')}</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </Field>
            <Field label={t('print.designer.headerLayout')}>
              {(c) => (
                <Select
                  value={spec.style.headerLayout}
                  onValueChange={(v) =>
                    edit((s) => ({
                      ...s,
                      style: { ...s.style, headerLayout: v as 'left' | 'center' },
                    }))
                  }
                >
                  <SelectTrigger {...c} data-testid="template-header-layout">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="left">{t('print.designer.left')}</SelectItem>
                    <SelectItem value="center">{t('print.designer.center')}</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </Field>
          </div>
        </Section>

        <Section title={t('print.designer.blocks')} id="blocks">
          <p className="text-xs text-fg-muted">{t('print.designer.blocksHelp')}</p>
          {ZONES.map(({ zone, label }) => {
            const inZone = spec.blocks.filter((b) => zoneOf(b.type) === zone);
            if (inZone.length === 0) return null;
            return (
              <div key={zone}>
                <p className="pb-1 text-xs font-semibold uppercase text-fg-muted">{label}</p>
                <ul className="flex flex-col gap-1" data-testid={`blocks-${zone}`}>
                  {inZone.map((b, i) => (
                    <li
                      key={b.type}
                      draggable
                      data-testid="block-row"
                      data-block={b.type}
                      className="flex items-center gap-2 rounded-md border border-border bg-bg px-2 py-1 text-sm"
                      onDragStart={() => (dragged.current = b.type)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => {
                        if (dragged.current) edit((s) => reorderBlock(s, dragged.current!, b.type));
                        dragged.current = null;
                      }}
                    >
                      <span aria-hidden className="cursor-grab text-fg-muted">
                        ⋮⋮
                      </span>
                      <span className="flex-1">{t(`print.designer.block.${b.type}`)}</span>
                      <Button
                        variant="ghost"
                        aria-label={t('print.designer.up')}
                        data-testid="block-up"
                        disabled={i === 0}
                        onClick={() => edit((s) => moveBlock(s, b.type, -1))}
                      >
                        ↑
                      </Button>
                      <Button
                        variant="ghost"
                        aria-label={t('print.designer.down')}
                        data-testid="block-down"
                        disabled={i === inZone.length - 1}
                        onClick={() => edit((s) => moveBlock(s, b.type, 1))}
                      >
                        ↓
                      </Button>
                      {b.type !== 'lines' && (
                        <Switch
                          aria-label={t(`print.designer.block.${b.type}`)}
                          checked={b.visible}
                          data-testid="block-visible"
                          onCheckedChange={(v) => edit((s) => toggleBlock(s, b.type, v))}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          {spec.blocks.some((b) => b.type === 'footer') && (
            <Field label={t('print.designer.footerText')}>
              {(c) => (
                <Input
                  {...c}
                  data-testid="template-footer-text"
                  value={spec.blocks.find((b) => b.type === 'footer')?.text ?? ''}
                  onChange={(e) =>
                    edit((s) => ({
                      ...s,
                      blocks: s.blocks.map((b) =>
                        b.type === 'footer' ? { ...b, text: e.target.value } : b,
                      ),
                    }))
                  }
                />
              )}
            </Field>
          )}
        </Section>

        <Section title={t('print.designer.columns')} id="columns">
          <ul className="flex flex-col gap-1">
            {spec.table.columns.map((c) => (
              <li
                key={c.key}
                className="flex items-center gap-2 text-sm"
                data-testid="column-row"
                data-column={c.key}
              >
                <Switch
                  aria-label={t(`print.designer.col.${c.key}`)}
                  checked={c.visible}
                  disabled={c.key === 'item' || c.key === 'amount'}
                  data-testid="column-visible"
                  onCheckedChange={(v) => edit((s) => toggleColumn(s, c.key as ColumnKey, v))}
                />
                <span className="flex-1">{t(`print.designer.col.${c.key}`)}</span>
                <Input
                  aria-label={`${t(`print.designer.col.${c.key}`)} ${t('print.designer.width')}`}
                  className="w-16 text-right"
                  inputMode="decimal"
                  value={String(c.weight)}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n) && n >= 0.3 && n <= 60)
                      edit((s) => ({
                        ...s,
                        table: {
                          ...s.table,
                          columns: s.table.columns.map((x) =>
                            x.key === c.key ? { ...x, weight: n } : x,
                          ),
                        },
                      }));
                  }}
                />
              </li>
            ))}
          </ul>
          <Field label={t('print.designer.taxColumns')}>
            {(c) => (
              <Select
                value={spec.table.taxColumns}
                onValueChange={(v) =>
                  edit((s) => ({
                    ...s,
                    table: { ...s.table, taxColumns: v as 'split' | 'combined' | 'hidden' },
                  }))
                }
              >
                <SelectTrigger {...c} data-testid="template-tax-columns">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="split">{t('print.designer.taxSplit')}</SelectItem>
                  <SelectItem value="combined">{t('print.designer.taxCombined')}</SelectItem>
                  <SelectItem value="hidden">{t('print.designer.taxHidden')}</SelectItem>
                </SelectContent>
              </Select>
            )}
          </Field>
        </Section>

        <Section title={t('print.designer.copiesTitle')} id="copies">
          <Field label={t('print.designer.copies')}>
            {(c) => (
              <Select
                value={spec.copies}
                onValueChange={(v) => edit((s) => ({ ...s, copies: v as 'single' | 'rule48' }))}
              >
                <SelectTrigger {...c} data-testid="template-copies">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="single">{t('print.designer.copiesSingle')}</SelectItem>
                  <SelectItem value="rule48">{t('print.designer.copiesRule48')}</SelectItem>
                </SelectContent>
              </Select>
            )}
          </Field>
          <Field label={t('print.designer.watermark')} hint={t('print.designer.watermarkHelp')}>
            {(c) => (
              <Input
                {...c}
                data-testid="template-watermark"
                value={spec.watermark.custom ?? ''}
                maxLength={30}
                onChange={(e) =>
                  edit((s) => ({
                    ...s,
                    watermark: {
                      ...s.watermark,
                      custom: e.target.value.trim() ? e.target.value : null,
                    },
                  }))
                }
              />
            )}
          </Field>
        </Section>

        <Section title={t('print.designer.labels')} id="labels">
          <p className="text-xs text-fg-muted">
            {t('print.designer.labelsHelp', { language: PRINT_LANGUAGE_NAMES[lang] })}
          </p>
          <Input
            aria-label={t('print.designer.labelSearch')}
            placeholder={t('print.designer.labelSearch')}
            data-testid="label-search"
            value={labelFilter}
            onChange={(e) => setLabelFilter(e.target.value)}
          />
          <ul className="flex flex-col gap-1">
            {shownLabels.map((k) => (
              <li key={k} className="flex items-center gap-2 text-sm">
                <span className="w-32 shrink-0 truncate text-fg-muted" title={k}>
                  {k}
                </span>
                <Input
                  aria-label={k}
                  data-testid="label-input"
                  data-key={k}
                  placeholder={printLabel(lang, k)}
                  value={overrides[k] ?? ''}
                  onChange={(e) => setLabel(k, e.target.value)}
                />
              </li>
            ))}
          </ul>
        </Section>

        <Section title={t('print.designer.thermal')} id="thermal">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('print.designer.rollWidth')}>
              {(c) => (
                <Select
                  value={String(spec.thermal.widthMm)}
                  onValueChange={(v) =>
                    edit((s) => ({
                      ...s,
                      thermal: { ...s.thermal, widthMm: v === '58' ? 58 : 80 },
                    }))
                  }
                >
                  <SelectTrigger {...c} data-testid="template-roll">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="58">58 mm</SelectItem>
                    <SelectItem value="80">80 mm</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </Field>
            <Field label={t('print.designer.rollFooter')}>
              {(c) => (
                <Input
                  {...c}
                  data-testid="template-roll-footer"
                  value={spec.thermal.footer}
                  maxLength={120}
                  onChange={(e) =>
                    edit((s) => ({ ...s, thermal: { ...s.thermal, footer: e.target.value } }))
                  }
                />
              )}
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={spec.thermal.showBusiness}
              onCheckedChange={(v) =>
                edit((s) => ({ ...s, thermal: { ...s.thermal, showBusiness: v } }))
              }
            />
            {t('print.designer.rollBusiness')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={spec.thermal.showTaxSummary}
              onCheckedChange={(v) =>
                edit((s) => ({ ...s, thermal: { ...s.thermal, showTaxSummary: v } }))
              }
            />
            {t('print.designer.rollSummary')}
          </label>
          <p className="text-xs text-fg-muted" data-testid="roll-columns">
            {t('print.designer.rollColumns', {
              columns: thermalColumns(spec.thermal.widthMm),
              mm: spec.thermal.widthMm,
            })}
          </p>
          <pre
            className="overflow-auto rounded-md border border-border bg-white p-2 font-mono text-[10px] leading-tight text-black"
            data-testid="roll-preview"
          >
            {`${'1234567890'.repeat(5).slice(0, thermalColumns(spec.thermal.widthMm))}\n${receipt}`}
          </pre>
        </Section>

        <Section title={t('print.designer.defaults')} id="defaults">
          <p className="text-xs text-fg-muted">{t('print.designer.defaultsHelp')}</p>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-fg-muted">
              <tr>
                <th className="font-medium">{t('print.designer.documentType')}</th>
                <th className="text-center font-medium">Books</th>
                <th className="text-center font-medium">Shop</th>
              </tr>
            </thead>
            <tbody>
              {DOC_TYPES.map((type) => (
                <tr key={type} className="border-t border-border">
                  <td className="py-1">{t(`docs.types.${type}`)}</td>
                  {(['books', 'shop'] as const).map((shell) => (
                    <td key={shell} className="text-center">
                      <Checkbox
                        aria-label={`${t(`docs.types.${type}`)} ${shell}`}
                        data-testid={`default-${type}-${shell}`}
                        checked={(defaults?.[type]?.[shell] ?? null) === selected.id}
                        onCheckedChange={(v) => void setDefault(type, shell, v === true)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <Section title={t('print.bulk.title')} id="bulk">
          <Field label={t('print.bulk.pattern')} hint={t('print.bulk.patternHelp')}>
            {(c) => (
              <Input
                {...c}
                data-testid="bulk-pattern"
                defaultValue={pattern.data ?? DEFAULT_BULK_PATTERN}
                key={pattern.data ?? 'default'}
                onBlur={(e) => {
                  if (!database || !ctx) return;
                  const v = e.target.value.trim() || DEFAULT_BULK_PATTERN;
                  void new SettingsRepo(database)
                    .set(ctx, BULK_PATTERN_KEY, v)
                    .then(() => toast.success(t('print.designer.saved')));
                }}
              />
            )}
          </Field>
        </Section>

        <div className="sticky bottom-0 flex flex-wrap gap-2 border-t border-border bg-bg py-2">
          <Button
            data-testid="template-save"
            disabled={!selected.saved || !dirty}
            onClick={() => void save()}
          >
            {t('print.designer.save')}
          </Button>
          <Button
            variant="outline"
            data-testid="template-save-new"
            onClick={() => void saveAsNew()}
          >
            {t('print.designer.saveNew')}
          </Button>
          <Button
            variant="outline"
            data-testid="template-reset"
            disabled={!dirty}
            onClick={() => choose(selectedId)}
          >
            {t('print.designer.reset')}
          </Button>
          <Button
            variant="ghost"
            data-testid="template-delete"
            disabled={!selected.saved}
            onClick={() => void remove()}
          >
            {t('print.designer.delete')}
          </Button>
        </div>
      </div>

      <div
        className="min-w-0 xl:sticky xl:top-2 xl:max-h-[calc(100vh-1rem)] xl:overflow-auto"
        data-testid="designer-preview"
      >
        <div className="flex flex-wrap items-center gap-2 pb-2">
          <Select
            value={previewType}
            onValueChange={(v) => setPreviewType(v as typeof previewType)}
          >
            <SelectTrigger
              className="w-48"
              aria-label={t('print.designer.previewType')}
              data-testid="designer-preview-type"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DOC_TYPES.map((x) => (
                <SelectItem key={x} value={x}>
                  {t(`docs.types.${x}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={supply} onValueChange={(v) => setSupply(v as typeof supply)}>
            <SelectTrigger
              className="w-44"
              aria-label={t('print.designer.previewSupply')}
              data-testid="designer-preview-supply"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUPPLIES.map((x) => (
                <SelectItem key={x} value={x}>
                  {t(`print.designer.supply.${x}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="rounded-md border border-border bg-surface-2 p-2">
          {pages && fonts ? (
            <PageView pages={pages} zoom={62} measurer={fonts.measurer} paper={spec.page.size} />
          ) : (
            <p className="p-4 text-sm text-fg-muted">{t('empty.loading')}</p>
          )}
        </div>
      </div>
    </div>
  );
}
