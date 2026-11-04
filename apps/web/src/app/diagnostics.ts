/** "Copy diagnostics": enough to debug, nothing that identifies a person or a customer. */

export interface DiagnosticsInput {
  error: unknown;
  /** Current location (path only is used). */
  pathname: string;
  appVersion: string;
  userAgent: string;
  db?: { kind: string | null; persistent: boolean; schemaVersion?: number } | null;
  at: string;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Remove things that can identify people from free text. */
export function scrub(text: string): string {
  return text
    .replace(UUID, ':id')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[pan]')
    .replace(/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g, '[gstin]')
    .replace(/(?<!\d)(?:\+91[ -]?)?[6-9]\d{9}(?!\d)/g, '[phone]')
    .replace(/(?<!\d)\d{9,18}(?!\d)/g, '[number]')
    .replace(/[A-Za-z]:\\[^\s)]+/g, '[path]')
    .replace(/\/(?:Users|home)\/[^\s/)]+/g, '/[user]');
}

export function buildDiagnostics(i: DiagnosticsInput): string {
  const err = i.error instanceof Error ? i.error : new Error(String(i.error));
  const frames = (err.stack ?? '')
    .split('\n')
    .slice(1, 6)
    .map((l) => scrub(l.trim().replace(/\?[^\s)]*/g, '')));
  return JSON.stringify(
    {
      app: 'gst-desk',
      version: i.appVersion,
      at: i.at,
      route: scrub(i.pathname.split('?')[0]!),
      userAgent: i.userAgent,
      database: i.db ?? null,
      error: { name: err.name, message: scrub(err.message).slice(0, 300), frames },
    },
    null,
    2,
  );
}
