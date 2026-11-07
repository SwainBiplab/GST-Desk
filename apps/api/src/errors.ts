/**
 * One error envelope for every route: `{ error: { code, message, details?, requestId } }`. Known errors
 * map to a status; anything else is a 500 whose message never leaks internals.
 */
import { ConflictError, PeriodLockedError, RuleError } from '@gst/db';
import { z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

export const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorSchema>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const unauthorized = (message = 'Sign in to continue.') =>
  new ApiError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have access to this.') =>
  new ApiError(403, 'forbidden', message);
export const notFound = (what = 'That') => new ApiError(404, 'not_found', `${what} was not found.`);

export function toEnvelope(
  err: unknown,
  requestId: string,
): { status: number; body: ErrorEnvelope } {
  const body = (code: string, message: string, details?: unknown): ErrorEnvelope => ({
    error: { code, message, ...(details !== undefined ? { details } : {}), requestId },
  });
  if (err instanceof ApiError)
    return { status: err.status, body: body(err.code, err.message, err.details) };
  if (err instanceof HTTPException)
    return {
      status: err.status,
      body: body(err.status === 404 ? 'not_found' : 'http_error', err.message),
    };
  if (err instanceof z.ZodError)
    return {
      status: 400,
      body: body('validation', 'The request did not match what was expected.', err.issues),
    };
  if (err instanceof ConflictError) return { status: 409, body: body('conflict', err.message) };
  if (err instanceof PeriodLockedError)
    return { status: 423, body: body('period_locked', err.message) };
  if (err instanceof RuleError) return { status: 422, body: body('rule', err.message) };
  return { status: 500, body: body('internal', 'Something went wrong on our side.') };
}

/** Hono's `onError` hook. */
export function onError(err: Error, c: Context): Response {
  const requestId = c.get('requestId') ?? '';
  const { status, body } = toEnvelope(err, requestId);
  const log = c.get('log') as
    { error: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void } | undefined;
  if (status >= 500) log?.error({ err, requestId }, 'request failed');
  else log?.warn({ code: body.error.code, status, requestId }, 'request refused');
  return c.json(body, status as 400);
}
