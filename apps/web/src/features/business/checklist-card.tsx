import { Button, Card, CardTitle } from '@gst/ui';
import { Check, Circle } from '@gst/ui/icons';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { useChecklist } from './hooks';

import { useAppStore } from '@/app/store';

/** Self-ticking getting-started list. `force` shows it even if dismissed (the wizard's last step). */
export function ChecklistCard({ force = false }: { force?: boolean }) {
  const { t } = useTranslation();
  const shell = useAppStore((s) => s.shell);
  const { steps, visible, ready, dismiss } = useChecklist();
  if (!ready || (!visible && !force)) return null;
  const done = steps.filter((s) => s.done).length;
  return (
    <Card data-testid="checklist" className="mb-4">
      <div className="flex items-center justify-between gap-2">
        <CardTitle>
          {t('checklist.title')}{' '}
          <span
            className="tabular text-sm font-normal text-fg-muted"
            data-testid="checklist-progress"
          >
            {done}/{steps.length}
          </span>
        </CardTitle>
        {!force && (
          <Button variant="ghost" onClick={() => void dismiss()} data-testid="checklist-dismiss">
            {t('checklist.dismiss')}
          </Button>
        )}
      </div>
      <ul className="flex flex-col gap-1 pt-2">
        {steps.map((s) => (
          <li key={s.id} data-testid={`step-${s.id}`} data-done={s.done}>
            <Link
              to={`/${shell}/$page` as '/shop/$page'}
              params={{ page: s.page }}
              {...(s.search ? { search: s.search as never } : {})}
              className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-surface-2"
            >
              {s.done ? (
                <Check size={16} className="text-success" aria-hidden />
              ) : (
                <Circle size={16} className="text-fg-muted" aria-hidden />
              )}
              <span className={s.done ? 'text-fg-muted line-through' : ''}>
                {t(`checklist.steps.${s.id}`)}
              </span>
              <span className="sr-only">{s.done ? '(done)' : '(to do)'}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
