import { Button, toast } from '@gst/ui';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useAppDb } from '../db';
import { buildDiagnostics } from '../diagnostics';

declare const __APP_VERSION__: string;

function ErrorScreen({ error, onReset }: { error: unknown; onReset?: () => void }) {
  const { t } = useTranslation();
  const { kind, persistent } = useAppDb();
  const copy = async () => {
    const text = buildDiagnostics({
      error,
      pathname: location.pathname,
      appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev',
      userAgent: navigator.userAgent,
      db: { kind, persistent },
      at: new Date().toISOString(),
    });
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('error.copied'));
    } catch {
      // clipboard blocked: show it so it can be copied by hand
      window.prompt(t('error.copy'), text);
    }
  };
  return (
    <div
      role="alert"
      className="mx-auto mt-16 max-w-md rounded-lg border border-border bg-surface-1 p-6"
      data-testid="error-screen"
    >
      <h1 className="text-xl font-semibold">{t('error.title')}</h1>
      <p className="py-3 text-fg-muted">{t('error.body')}</p>
      <div className="flex gap-2">
        <Button onClick={() => void copy()} data-testid="copy-diagnostics">
          {t('error.copy')}
        </Button>
        <Button variant="outline" onClick={() => (onReset ? onReset() : location.reload())}>
          {t('error.reload')}
        </Button>
      </div>
    </div>
  );
}

/** Global error boundary. The fallback offers "copy diagnostics", which contains no personal data. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  override state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Unhandled UI error', error, info.componentStack);
  }

  override render() {
    return this.state.error ? (
      <ErrorScreen error={this.state.error} onReset={() => this.setState({ error: null })} />
    ) : (
      this.props.children
    );
  }
}

/** Used as the router's default error component. */
export function RouteError({ error }: { error: unknown }) {
  return <ErrorScreen error={error} />;
}
