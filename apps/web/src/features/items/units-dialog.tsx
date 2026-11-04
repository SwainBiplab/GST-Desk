import { UnitRepo } from '@gst/db';
import { UQC_MASTER, returnsUqc, uqcName, validateCustomUnit } from '@gst/domain';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@gst/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useUnits } from './hooks';

import { useAppDb } from '@/app/db';
import { Field } from '@/features/onboarding/field';

/**
 * Units of measure: the standard GST units (UQC) a business uses, and its own units. Each custom
 * unit reports as one UQC in returns.
 */
export function UnitsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const units = useUnits().data ?? [];
  const [standard, setStandard] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [uqc, setUqc] = useState('NOS');
  const [errors, setErrors] = useState<string[]>([]);

  const have = new Set(units.map((u) => u['code'] as string));
  const addable = UQC_MASTER.filter(([c]) => !have.has(c));

  const run = async (fn: (repo: UnitRepo) => Promise<unknown>) => {
    if (!database || !ctx) return;
    try {
      await fn(new UnitRepo(database));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const addCustom = () => {
    const problems = validateCustomUnit({ code, name, uqc }, have);
    setErrors(problems);
    if (problems.length > 0) return;
    void run(async (repo) => {
      await repo.addCustom(ctx!, { code, name, uqc });
      setCode('');
      setName('');
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="flex max-h-[90vh] w-[min(44rem,calc(100vw-2rem))] flex-col gap-3 overflow-hidden"
        data-testid="units-dialog"
      >
        <DialogTitle className="text-lg font-semibold">{t('items.units.title')}</DialogTitle>
        <DialogDescription className="text-fg-muted">{t('items.units.help')}</DialogDescription>

        <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
          <table className="w-full text-sm" aria-label={t('items.units.title')}>
            <thead className="sticky top-0 bg-surface-2 text-left text-xs text-fg-muted">
              <tr>
                <th className="p-2">{t('items.units.code')}</th>
                <th className="p-2">{t('items.units.name')}</th>
                <th className="p-2">{t('items.units.reportsAs')}</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {units.map((u) => (
                <tr key={u['id']} className="border-t border-border" data-testid="unit-row">
                  <td className="p-2 font-medium">{u['code']}</td>
                  <td className="p-2">{u['name']}</td>
                  <td className="p-2">
                    {returnsUqc(u as { code: string; uqc: string | null; is_custom: boolean })}
                    {u['is_custom'] && (
                      <span className="ml-1 text-xs text-fg-muted">
                        ({t('items.units.custom')})
                      </span>
                    )}
                  </td>
                  <td className="p-2 text-right">
                    <Button
                      variant="ghost"
                      aria-label={`${t('items.units.remove')} ${u['code']}`}
                      onClick={() =>
                        void run(async (repo) => {
                          try {
                            await repo.softDelete(ctx!, u['id'], u['version']);
                          } catch {
                            toast.error(t('items.units.inUse', { code: u['code'] }));
                          }
                        })
                      }
                    >
                      {t('items.units.remove')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <Field label={t('items.units.addStandard')} className="w-64">
            {(c) => (
              <Select value={standard} onValueChange={setStandard}>
                <SelectTrigger {...c} data-testid="unit-standard">
                  <SelectValue placeholder={t('items.units.pick')} />
                </SelectTrigger>
                <SelectContent>
                  {addable.map(([c2, n]) => (
                    <SelectItem key={c2} value={c2}>
                      {c2} · {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <Button
            variant="outline"
            data-testid="unit-add-standard"
            disabled={!standard}
            onClick={() =>
              void run(async (repo) => {
                await repo.addStandard(ctx!, standard);
                setStandard('');
              })
            }
          >
            {t('items.units.add')}
          </Button>
        </div>

        <fieldset className="flex flex-col gap-2 rounded-md border border-border p-3">
          <legend className="px-1 text-sm font-medium">{t('items.units.addCustom')}</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field
              label={t('items.units.code')}
              error={
                errors.includes('duplicate')
                  ? 'unit_duplicate'
                  : errors.includes('code')
                    ? 'unit_code'
                    : undefined
              }
            >
              {(c) => (
                <Input
                  {...c}
                  data-testid="unit-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              )}
            </Field>
            <Field
              label={t('items.units.name')}
              error={errors.includes('name') ? 'name' : undefined}
            >
              {(c) => (
                <Input
                  {...c}
                  data-testid="unit-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              )}
            </Field>
            <Field label={t('items.units.reportsAs')} hint={uqcName(uqc) ?? undefined}>
              {(c) => (
                <Select value={uqc} onValueChange={setUqc}>
                  <SelectTrigger {...c} data-testid="unit-uqc">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {UQC_MASTER.map(([c2, n]) => (
                      <SelectItem key={c2} value={c2}>
                        {c2} · {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
          </div>
          <div>
            <Button data-testid="unit-add-custom" onClick={addCustom}>
              {t('items.units.add')}
            </Button>
          </div>
        </fieldset>
        <div className="flex justify-end">
          <Button variant="ghost" data-testid="units-close" onClick={onClose}>
            {t('items.units.close')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
