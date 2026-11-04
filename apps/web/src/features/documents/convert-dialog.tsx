import {
  isAdjustment,
  isBlankLine,
  parseQtyMicros,
  type DocumentType,
  type DraftDocument,
  type LineSelection,
} from '@gst/domain';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
} from '@gst/ui';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { qtyText } from './state';

/**
 * Convert a document into another (quotation to invoice, challan to invoice, invoice to credit note).
 * A credit or debit note, or a purchase return, reverses part of the original: choose the lines and
 * how much of each. Quantities can never exceed what the original had.
 */
export function ConvertDialog({
  draft,
  target,
  busy,
  onConfirm,
  onClose,
}: {
  draft: DraftDocument;
  target: DocumentType;
  busy: boolean;
  onConfirm: (selection: LineSelection[] | undefined) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const adjustment = isAdjustment(target);
  const lines = useMemo(() => draft.lines.filter((l) => !isBlankLine(l)), [draft.lines]);
  const [picked, setPicked] = useState(() => new Set(lines.map((l) => l.key)));
  const [qty, setQty] = useState(() =>
    Object.fromEntries(lines.map((l) => [l.key, qtyText(l.qtyMicros)])),
  );

  const selection: LineSelection[] = lines
    .filter((l) => picked.has(l.key))
    .map((l) => ({ key: l.key, qtyMicros: BigInt(parseQtyMicros(qty[l.key] ?? '') ?? 0) }));
  const bad = (l: (typeof lines)[number]) => {
    const q = parseQtyMicros(qty[l.key] ?? '');
    return typeof q !== 'number' || q <= 0 || BigInt(q) > l.qtyMicros;
  };
  const invalid =
    adjustment && (selection.length === 0 || lines.some((l) => picked.has(l.key) && bad(l)));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="flex max-h-[90vh] w-[min(40rem,calc(100vw-2rem))] flex-col gap-3"
        data-testid="convert-dialog"
      >
        <DialogTitle className="text-lg font-semibold">
          {t('docs.convert.title', {
            from: t(`docs.types.${draft.type}`),
            to: t(`docs.types.${target}`),
          })}
        </DialogTitle>
        <DialogDescription className="text-fg-muted">
          {adjustment ? t('docs.convert.pickLines') : t('docs.convert.keepLines')}
        </DialogDescription>

        {adjustment && (
          <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
            <table className="w-full text-sm" aria-label={t('docs.convert.lines')}>
              <thead className="bg-surface-2 text-left text-xs text-fg-muted">
                <tr>
                  <th className="w-10 p-2" />
                  <th className="p-2">{t('docs.grid.item')}</th>
                  <th className="p-2 text-right">{t('docs.convert.original')}</th>
                  <th className="w-28 p-2 text-right">{t('docs.convert.quantity')}</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.key} className="border-t border-border" data-testid="convert-line">
                    <td className="p-2">
                      <Checkbox
                        aria-label={l.description}
                        checked={picked.has(l.key)}
                        onCheckedChange={(v) => {
                          const next = new Set(picked);
                          if (v === true) next.add(l.key);
                          else next.delete(l.key);
                          setPicked(next);
                        }}
                      />
                    </td>
                    <td className="p-2">{l.description}</td>
                    <td className="p-2 text-right tabular">{qtyText(l.qtyMicros)}</td>
                    <td className="p-2">
                      <Input
                        className="text-right"
                        aria-label={t('docs.convert.quantityFor', { name: l.description })}
                        aria-invalid={picked.has(l.key) && bad(l)}
                        disabled={!picked.has(l.key)}
                        inputMode="decimal"
                        data-testid="convert-qty"
                        value={qty[l.key] ?? ''}
                        onChange={(e) => setQty({ ...qty, [l.key]: e.target.value })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {invalid && (
          <p role="alert" className="text-sm text-danger">
            {t('docs.convert.invalid')}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('docs.actions.cancel')}
          </Button>
          <Button
            data-testid="convert-confirm"
            disabled={busy || invalid}
            onClick={() => onConfirm(adjustment ? selection : undefined)}
          >
            {t('docs.convert.confirm', { to: t(`docs.types.${target}`) })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
