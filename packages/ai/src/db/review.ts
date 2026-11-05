/**
 * Review items: the "AI proposes, people dispose" contract. Nothing an AI suggests is applied until a
 * person accepts it, and what they changed is kept as `correction_json` for evals.
 */
import { ReviewRepo, RuleError, runInTx, type Ctx, type Database, type Row } from '@gst/db';

import { jsonDiff } from '../diff';
import type { Schema } from '../provider';

export class ReviewError extends Error {
  override name = 'ReviewError';
}

export interface CreateReviewItemArgs<T> {
  db: Database;
  ctx: Ctx;
  kind: string;
  /** The user's current data the suggestion would change. */
  payload: unknown;
  suggestion: T;
  schema: Schema<T>;
  /** Who produced it: a provider id such as `rules` or `anthropic`. */
  source: string;
  model?: string;
  /** 0..1, stored as a whole percent. */
  confidence?: number;
  /** Names what the suggestion is about, so the same finding is never raised twice. */
  dedupeKey?: string;
}

/** Validate the suggestion, compute the diff against the payload and store a pending item. */
export async function createReviewItem<T>(a: CreateReviewItemArgs<T>): Promise<Row> {
  const parsed = a.schema.safeParse(a.suggestion);
  if (!parsed.success) {
    throw new ReviewError(
      `suggestion does not match its schema: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    );
  }
  return new ReviewRepo(a.db).create(a.ctx, {
    kind: a.kind,
    status: 'pending',
    payload_json: a.payload ?? null,
    suggestion_json: parsed.data,
    diff_json: jsonDiff(a.payload ?? null, parsed.data),
    source: a.source,
    model: a.model ?? null,
    confidence: a.confidence === undefined ? null : Math.round(a.confidence * 100),
    dedupe_key: a.dedupeKey ?? null,
  });
}

/** AI actors may propose but never dispose. */
function assertHuman(ctx: Ctx) {
  if (/^(ai|system:ai)[:/]/i.test(ctx.actor)) {
    throw new RuleError(`actor "${ctx.actor}" is an AI and cannot accept or reject review items`);
  }
}

export interface AcceptReviewItemArgs<T> {
  db: Database;
  ctx: Ctx;
  id: string;
  expectedVersion: number;
  schema: Schema<T>;
  /** Apply the accepted value. Runs in the same transaction: use `ctx.tx` for writes. */
  apply: (value: T, ctx: Ctx) => Promise<void>;
  /** The value after the user's edits. Omit to accept the suggestion as is. */
  edited?: unknown;
}

/**
 * Apply a pending item and mark it accepted. If the user edited the suggestion, the edit is
 * validated, applied instead, and recorded as `correction_json`. If `apply` throws, nothing is saved.
 */
export async function acceptReviewItem<T>(a: AcceptReviewItemArgs<T>): Promise<Row> {
  assertHuman(a.ctx);
  const repo = new ReviewRepo(a.db);
  return runInTx(a.db, a.ctx, async (tx) => {
    const ctx = { ...a.ctx, tx };
    const item = await repo.get(ctx, a.id);
    if (!item) throw new ReviewError(`review item ${a.id} not found`);
    if (item['status'] !== 'pending')
      throw new RuleError(`review item is already ${item['status']}`);

    const candidate = a.edited ?? item['suggestion_json'];
    const parsed = a.schema.safeParse(candidate);
    if (!parsed.success) {
      throw new ReviewError(
        `accepted value does not match its schema: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
      );
    }
    const changes = a.edited === undefined ? [] : jsonDiff(item['suggestion_json'], parsed.data);

    await a.apply(parsed.data, ctx);
    return repo.accept(ctx, a.id, a.expectedVersion, changes.length > 0 ? changes : null);
  });
}

export async function rejectReviewItem(args: {
  db: Database;
  ctx: Ctx;
  id: string;
  expectedVersion: number;
  reason?: string;
}): Promise<Row> {
  assertHuman(args.ctx);
  return new ReviewRepo(args.db).reject(args.ctx, args.id, args.expectedVersion, args.reason);
}
