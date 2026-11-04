import { Button, Card, CardTitle, EmptyState, PageHeader } from '@gst/ui';
import { formatPaise } from '@gst/ui';
import { useTranslation } from 'react-i18next';

import { useAppDb } from '../db';
import { parseCommand } from '../grammar';
import { useLocationInfo } from '../hooks';
import type { PageId } from '../nav';
import type { Shell } from '../store';

/** Question-led card slots. Reports (prompt 18) fill them in. */
export function DashboardFrame({ shell }: { shell: Shell }) {
  const { t } = useTranslation();
  const keys =
    shell === 'shop'
      ? ['sold', 'owed', 'low', 'attention']
      : ['gst', 'cash', 'overdue', 'spend', 'review'];
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="dashboard-frame">
      {keys.map((k) => (
        <Card key={k} data-testid={`card-${k}`} className="min-h-32">
          <CardTitle>{t(`dash.${shell}.${k}`)}</CardTitle>
          <p className="pt-2 text-fg-muted">{t('dash.frame')}</p>
        </Card>
      ))}
    </div>
  );
}

/** Shown when the database is open but no business exists yet. */
export function NoBusiness() {
  const { t } = useTranslation();
  const { status, error, loadDemoData } = useAppDb();
  if (status === 'loading') return <p className="p-6 text-fg-muted">{t('empty.loading')}</p>;
  if (status === 'error') {
    return <EmptyState title={t('empty.error')} description={error?.message ?? ''} />;
  }
  return (
    <EmptyState
      title={t('empty.title')}
      description={t('empty.body')}
      action={
        <Button data-testid="load-demo" onClick={() => void loadDemoData()}>
          {t('empty.loadDemo')}
        </Button>
      }
    />
  );
}

/** Describe a command-bar intent that landed on a page that cannot act on it yet. */
function describeIntent(search: Record<string, unknown>): string | null {
  const raw = typeof search['cmd'] === 'string' ? search['cmd'] : null;
  const intent = raw ? parseCommand(raw) : null;
  if (!intent) return null;
  if (intent.kind === 'payment') {
    const amount = formatPaise(intent.amountPaise);
    return intent.direction === 'made'
      ? `Pay ${amount} to ${intent.party}`
      : `Receive ${amount} from ${intent.party}`;
  }
  if (intent.kind === 'new')
    return `New ${intent.doc.replace('_', ' ')}${intent.party ? ` for ${intent.party}` : ''}`;
  return null;
}

/** Placeholder body for pages built in later prompts. */
export function PlaceholderPage({ page, shell }: { page: PageId; shell: Shell }) {
  const { t } = useTranslation();
  const { search } = useLocationInfo();
  const { ctx, status } = useAppDb();
  const intent = describeIntent(search);
  return (
    <div data-shell={shell}>
      <PageHeader title={t(`nav.${page}`)} />
      {page === 'dashboard' ? (
        ctx ? (
          <DashboardFrame shell={shell} />
        ) : status === 'ready' ? (
          <NoBusiness />
        ) : (
          <NoBusiness />
        )
      ) : (
        <>
          {intent && (
            <p
              data-testid="intent"
              className="mb-3 rounded-md border border-border bg-surface-1 p-3"
            >
              {intent}
            </p>
          )}
          <p className="text-fg-muted">{t('page.notBuilt')}</p>
        </>
      )}
    </div>
  );
}
