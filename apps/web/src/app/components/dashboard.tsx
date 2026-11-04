import { formatPaise } from '@gst/ui';
import { Button, Card, CardTitle, EmptyState, PageHeader } from '@gst/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAppDb } from '../db';
import { parseCommand } from '../grammar';
import { useLocationInfo } from '../hooks';
import type { PageId } from '../nav';
import { canResetLocalData, resetLocalData } from '../reset-local';
import type { Shell } from '../store';

import { useConfirm } from './confirm';

import { ChecklistCard } from '@/features/business/checklist-card';
import { SettingsPage } from '@/features/business/settings-page';
import { DocumentsPage } from '@/features/documents/documents-page';
import { EditorRoute } from '@/features/documents/editor-route';
import { ItemsPage } from '@/features/items/items-page';
import { PartiesPage } from '@/features/parties/parties-page';
import { PaymentsPage } from '@/features/payments/payments-page';

/** Question-led card slots. Reports (prompt 18) fill them in. */
export function DashboardFrame({ shell }: { shell: Shell }) {
  const { t } = useTranslation();
  const keys =
    shell === 'shop'
      ? ['sold', 'owed', 'low', 'attention']
      : ['gst', 'cash', 'overdue', 'spend', 'review'];
  return (
    <div data-testid="dashboard-frame">
      <ChecklistCard />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {keys.map((k) => (
          <Card key={k} data-testid={`card-${k}`} className="min-h-32">
            <CardTitle>{t(`dash.${shell}.${k}`)}</CardTitle>
            <p className="pt-2 text-fg-muted">{t('dash.frame')}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}

/** The way out of a database that will not open: clear this browser's copy and start again. */
function ResetLocalData() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [failure, setFailure] = useState<string | null>(null);
  const reset = async () => {
    const ok = await confirm({
      title: t('empty.reset.title'),
      description: t('empty.reset.body'),
      confirmLabel: t('empty.reset.confirm'),
    });
    if (!ok) return;
    try {
      await resetLocalData();
      window.location.reload();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="flex flex-col items-center gap-2">
      <p className="max-w-sm text-sm text-fg-muted">{t('empty.reset.hint')}</p>
      <Button variant="outline" data-testid="reset-local" onClick={() => void reset()}>
        {t('empty.reset.action')}
      </Button>
      {failure && (
        <p role="alert" className="max-w-sm text-sm text-danger" data-testid="reset-failed">
          {t('empty.reset.failed', { reason: failure })}
        </p>
      )}
    </div>
  );
}

/** Shown when the database is open but no business exists yet. */
export function NoBusiness() {
  const { t } = useTranslation();
  const { status, error, loadDemoData } = useAppDb();
  if (status === 'loading') return <p className="p-6 text-fg-muted">{t('empty.loading')}</p>;
  if (status === 'error') {
    return (
      <EmptyState
        title={t('empty.error')}
        description={error?.message ?? ''}
        action={canResetLocalData() ? <ResetLocalData /> : undefined}
      />
    );
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
  if (page === 'parties' && ctx) {
    return (
      <div data-shell={shell} className="h-full">
        <PartiesPage shell={shell} />
      </div>
    );
  }
  if (page === 'sell' && ctx) {
    return (
      <div data-shell={shell}>
        <EditorRoute shell={shell} />
      </div>
    );
  }
  if (page === 'payments' && ctx) {
    return (
      <div data-shell={shell}>
        <PaymentsPage shell={shell} />
      </div>
    );
  }
  if (page === 'documents' && ctx) {
    return (
      <div data-shell={shell}>
        <DocumentsPage shell={shell} />
      </div>
    );
  }
  if (page === 'items' && ctx) {
    return (
      <div data-shell={shell} className="h-full">
        <ItemsPage shell={shell} />
      </div>
    );
  }
  if (page === 'settings' && ctx) {
    return (
      <div data-shell={shell}>
        <SettingsPage key={String(search['tab'] ?? '')} />
      </div>
    );
  }
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
