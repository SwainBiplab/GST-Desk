import type { BuiltDocument, DraftDocument, TraceStep } from '@gst/domain';
import { formatPaise, TracePanel } from '@gst/ui';
import { useTranslation } from 'react-i18next';

export type TraceTarget = { kind: 'line'; key: string } | { kind: 'document' };

/** "1180 paise" is not how anyone reads money: show rupees. */
const humanise = (note: string): string =>
  note.replace(/(-?\d+) paise/g, (_m, n: string) => formatPaise(BigInt(n)));

/** The engine steps behind one line, or behind the document totals. */
export function stepsFor(built: BuiltDocument, target: TraceTarget): TraceStep[] {
  if (target.kind === 'document') return built.trace.filter((s) => !s.rule.startsWith('lines['));
  const i = built.lines.findIndex((l) => l.key === target.key);
  if (i < 0) return [];
  const prefix = `lines[${i}].`;
  return built.trace
    .filter((s) => s.rule.startsWith(prefix))
    .map((s) => ({ ...s, rule: s.rule.slice(prefix.length) }));
}

/**
 * Why a number is what it is (UX-04): the engine's own steps in plain language, for one line or for
 * the document totals. Nothing here is recomputed; it only shows the trace the totals came from.
 */
export function TraceView({
  built,
  draft,
  target,
}: {
  built: BuiltDocument;
  draft: DraftDocument;
  target: TraceTarget | null;
}) {
  const { t } = useTranslation();
  if (!target) {
    return (
      <TracePanel title={t('docs.trace.title')}>
        <p className="text-sm text-fg-muted" data-testid="trace-empty">
          {t('docs.trace.empty')}
        </p>
      </TracePanel>
    );
  }
  const steps = stepsFor(built, target);
  const line = target.kind === 'line' ? draft.lines.find((l) => l.key === target.key) : null;
  return (
    <TracePanel
      title={
        line
          ? t('docs.trace.forLine', { name: line.description || '…' })
          : t('docs.trace.forDocument')
      }
    >
      <ol className="flex flex-col gap-2" data-testid="trace-steps">
        {steps.map((s, i) => (
          <li
            key={`${s.rule}-${i}`}
            className="rounded-md border border-border p-2"
            data-testid="trace-step"
            data-rule={s.rule}
          >
            <p className="text-xs font-semibold uppercase text-fg-muted">
              {t(`docs.trace.rules.${s.rule}`, { defaultValue: s.rule })}
            </p>
            <p className="text-sm">{humanise(s.note)}</p>
          </li>
        ))}
        {steps.length === 0 && <li className="text-sm text-fg-muted">{t('docs.trace.empty')}</li>}
      </ol>
    </TracePanel>
  );
}
