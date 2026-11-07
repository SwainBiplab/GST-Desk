/**
 * One pino logger. Every line carries the request id when there is one; nothing from a request body,
 * a token or a person's details is ever logged (the redaction list is the floor, not the ceiling).
 */
import pino, { type Logger } from 'pino';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.secret',
  '*.otp',
  '*.code',
  '*.email',
  '*.phone',
  '*.gstin',
  '*.pan',
];

export function makeLogger(level: string, pretty = false): Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { service: 'gst-api' },
    ...(pretty ? { transport: { target: 'pino/file', options: { destination: 1 } } } : {}),
  });
}

/** Scrub free text before it leaves the process (error reports): emails, phones, GSTINs, PANs, long numbers. */
export function scrub(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g, '[gstin]')
    .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[pan]')
    .replace(/(\+?91[\s-]?)?[6-9]\d{9}\b/g, '[phone]')
    .replace(/\b\d{8,}\b/g, '[number]');
}
