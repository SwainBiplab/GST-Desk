/**
 * Number series (FR-040/044): several series per document type, each with a counter per financial
 * year, defaults per type and per shell, and the reservation groundwork for several devices.
 *
 * One logical series is a set of `number_series` rows sharing `series_key`: one row per financial
 * year when the series resets by year, otherwise one row. Settings changes apply to every row of the
 * series; numbers already issued are plain text on their documents and never change.
 */
import {
  consume,
  fyOf,
  previewSeries,
  release,
  remaining,
  reserve,
  seriesClash,
  validateSeries,
  type Pool,
  type Range,
  type Reservation,
  type SeriesSettings,
} from '@gst/domain';
import { and, eq, isNull } from 'drizzle-orm';

import type { Database } from '../database';
import type { Row } from '../schema';

import { BusinessRepo, SettingsRepo } from './aggregates';
import { BaseRepo, NotFoundError, RuleError, newId, runInTx, type Ctx } from './base';

export type SyncMode = 'local' | 'synced';
export type ShellName = 'books' | 'shop';

export interface SeriesInput {
  documentType: string;
  name: string;
  prefix: string;
  suffix?: string;
  padding: number;
  reset: 'fy' | 'never';
  start?: number;
  isDefault?: boolean;
  shellDefault?: ShellName | null;
}

export interface SeriesView {
  key: string;
  documentType: string;
  name: string;
  prefix: string;
  suffix: string;
  padding: number;
  reset: 'fy' | 'never';
  start: number;
  isDefault: boolean;
  shellDefault: ShellName | null;
  counters: { id: string; fy: string | null; next: number }[];
  /** True once a document has been issued from it (it can then be renamed but not deleted). */
  used: boolean;
}

/** Range rows, with the transaction-scoped calls the numbering code needs. */
class ReservationRepo extends BaseRepo {
  constructor(d: Database) {
    super(d, 'number_reservations');
  }
  createWith(tx: any, ctx: Ctx, values: Row) {
    return this.createIn(tx, ctx, values);
  }
  getWith(tx: any, ctx: Ctx, id: string) {
    return this.getIn(tx, ctx, id);
  }
  updateWith(tx: any, ctx: Ctx, id: string, patch: Row, version: number) {
    return this.updateIn(tx, ctx, id, patch, version);
  }
}

const keyOf = (r: Row): string =>
  (r['series_key'] as string | null) ?? `legacy-${r['document_type']}`;

const settingsOf = (r: Row): SeriesSettings => ({
  name: (r['name'] as string | null) ?? 'Default',
  prefix: r['prefix'],
  suffix: r['suffix'],
  padding: Number(r['padding']),
  reset: r['reset'],
  start: Number(r['start_number'] ?? 1),
});

export class NumberingRepo extends BaseRepo {
  private readonly settings: SettingsRepo;

  constructor(d: Database) {
    super(d, 'number_series');
    this.settings = new SettingsRepo(d);
  }

  /* ------------------------------------------------------------------ series */

  private async rowsIn(tx: any, ctx: Ctx, type?: string): Promise<Row[]> {
    const t = this.t;
    const where = [eq(t.business_id, ctx.businessId), isNull(t.deleted_at)];
    if (type) where.push(eq(t.document_type, type));
    return tx
      .select()
      .from(t)
      .where(and(...where))
      .orderBy(t.document_type, t.created_at);
  }

  private async usedSeriesIdsIn(tx: any, ctx: Ctx): Promise<Set<string>> {
    const docs = this.d.schema.documents;
    const rows: Row[] = await tx
      .select({ series: docs.series_id })
      .from(docs)
      .where(and(eq(docs.business_id, ctx.businessId), isNull(docs.deleted_at)));
    return new Set(rows.map((r) => r['series']).filter(Boolean));
  }

  private groupIn(rows: Row[], used: Set<string>): SeriesView[] {
    const byKey = new Map<string, Row[]>();
    for (const r of rows) {
      const k = keyOf(r);
      byKey.set(k, [...(byKey.get(k) ?? []), r]);
    }
    return [...byKey.entries()].map(([key, list]) => {
      const first = list[0]!;
      const s = settingsOf(first);
      return {
        key,
        documentType: first['document_type'],
        name: s.name,
        prefix: s.prefix,
        suffix: s.suffix,
        padding: s.padding,
        reset: s.reset,
        start: s.start,
        isDefault: list.some((r) => !!r['is_default']),
        shellDefault: (list.find((r) => r['shell_default'])?.['shell_default'] ??
          null) as ShellName | null,
        counters: list.map((r) => ({
          id: r['id'],
          fy: (r['fy'] as string | null) ?? null,
          next: Number(r['next_number']),
        })),
        used: list.some((r) => used.has(r['id'])),
      };
    });
  }

  async listSeries(ctx: Ctx, type?: string): Promise<SeriesView[]> {
    return runInTx(this.d, ctx, async (tx) =>
      this.groupIn(await this.rowsIn(tx, ctx, type), await this.usedSeriesIdsIn(tx, ctx)),
    );
  }

  private checkIn(input: SeriesSettings, others: SeriesView[]): void {
    const problems = validateSeries(input);
    if (problems.length > 0) throw new RuleError(problems.map((p) => p.message).join(' '));
    const clash = others.find((o) => seriesClash(o, input));
    if (clash)
      throw new RuleError(
        `The series "${clash.name}" already uses this prefix and suffix, so numbers could repeat.`,
      );
  }

  async createSeries(ctx: Ctx, input: SeriesInput): Promise<SeriesView> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const existing = this.groupIn(
        await this.rowsIn(tx, c, input.documentType),
        await this.usedSeriesIdsIn(tx, c),
      );
      const settings: SeriesSettings = {
        name: input.name.trim(),
        prefix: input.prefix,
        suffix: input.suffix ?? '',
        padding: input.padding,
        reset: input.reset,
        start: input.start ?? 1,
      };
      this.checkIn(settings, existing);
      if (existing.some((e) => e.name === settings.name))
        throw new RuleError(`A series named "${settings.name}" already exists for this type.`);
      const key = newId();
      const isDefault = input.isDefault || existing.length === 0;
      if (isDefault) await this.clearFlagIn(tx, c, input.documentType, 'is_default', key);
      if (input.shellDefault)
        await this.clearFlagIn(tx, c, input.documentType, 'shell_default', key, input.shellDefault);
      await this.createIn(tx, c, {
        document_type: input.documentType,
        series_key: key,
        name: settings.name,
        prefix: settings.prefix,
        suffix: settings.suffix,
        padding: settings.padding,
        reset: settings.reset,
        start_number: settings.start,
        next_number: settings.start,
        fy: null,
        is_default: isDefault,
        shell_default: input.shellDefault ?? null,
      });
      return this.groupIn(await this.rowsIn(tx, c, input.documentType), new Set()).find(
        (s) => s.key === key,
      )!;
    });
  }

  /** Clear a default flag on the other series of a type before another takes it. */
  private async clearFlagIn(
    tx: any,
    ctx: Ctx,
    type: string,
    flag: 'is_default' | 'shell_default',
    exceptKey: string,
    shell?: ShellName,
  ): Promise<void> {
    for (const r of await this.rowsIn(tx, ctx, type)) {
      if (keyOf(r) === exceptKey) continue;
      if (flag === 'is_default' && r['is_default'])
        await this.updateIn(tx, ctx, r['id'], { is_default: false }, r['version']);
      if (flag === 'shell_default' && r['shell_default'] === shell)
        await this.updateIn(tx, ctx, r['id'], { shell_default: null }, r['version']);
    }
  }

  /**
   * Change a series. Name, prefix, suffix, padding and reset apply from the next number on; numbers
   * already issued are untouched. A counter nobody has used yet follows a changed start number.
   */
  async updateSeries(
    ctx: Ctx,
    key: string,
    patch: Partial<Omit<SeriesInput, 'documentType'>>,
  ): Promise<SeriesView> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const all = await this.rowsIn(tx, c);
      const mine = all.filter((r) => keyOf(r) === key);
      if (mine.length === 0) throw new NotFoundError('number_series', key);
      const type = mine[0]!['document_type'] as string;
      const others = this.groupIn(
        all.filter((r) => r['document_type'] === type && keyOf(r) !== key),
        new Set(),
      );
      const now = settingsOf(mine[0]!);
      const next: SeriesSettings = {
        name: patch.name?.trim() ?? now.name,
        prefix: patch.prefix ?? now.prefix,
        suffix: patch.suffix ?? now.suffix,
        padding: patch.padding ?? now.padding,
        reset: patch.reset ?? now.reset,
        start: patch.start ?? now.start,
      };
      this.checkIn(next, others);
      if (others.some((o) => o.name === next.name))
        throw new RuleError(`A series named "${next.name}" already exists for this type.`);
      const makeDefault = patch.isDefault === true;
      if (makeDefault) await this.clearFlagIn(tx, c, type, 'is_default', key);
      if (patch.shellDefault)
        await this.clearFlagIn(tx, c, type, 'shell_default', key, patch.shellDefault);

      for (const r of mine) {
        const pristine = Number(r['next_number']) === Number(r['start_number'] ?? 1);
        await this.updateIn(
          tx,
          c,
          r['id'],
          {
            series_key: key,
            name: next.name,
            prefix: next.prefix,
            suffix: next.suffix,
            padding: next.padding,
            reset: next.reset,
            start_number: next.start,
            ...(pristine && patch.start !== undefined ? { next_number: next.start } : {}),
            ...(makeDefault ? { is_default: true } : {}),
            ...(patch.shellDefault !== undefined ? { shell_default: patch.shellDefault } : {}),
          },
          r['version'],
        );
      }
      return this.groupIn(await this.rowsIn(tx, c, type), await this.usedSeriesIdsIn(tx, c)).find(
        (s) => s.key === key,
      )!;
    });
  }

  /** Remove a series nobody has issued from. The type's last series cannot be removed. */
  async removeSeries(ctx: Ctx, key: string): Promise<void> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const all = await this.rowsIn(tx, c);
      const mine = all.filter((r) => keyOf(r) === key);
      if (mine.length === 0) throw new NotFoundError('number_series', key);
      const used = await this.usedSeriesIdsIn(tx, c);
      if (mine.some((r) => used.has(r['id'])))
        throw new RuleError('Numbers have been issued from this series, so it cannot be removed.');
      const type = mine[0]!['document_type'];
      const siblings = all.filter((r) => r['document_type'] === type && keyOf(r) !== key);
      if (siblings.length === 0) throw new RuleError('A document type needs at least one series.');
      for (const r of mine) await this.softDelete(c, r['id'], r['version']);
      if (mine.some((r) => r['is_default']) && !siblings.some((r) => r['is_default'])) {
        const first = siblings[0]!;
        await this.updateIn(tx, c, first['id'], { is_default: true }, first['version']);
      }
    });
  }

  /** What the next number of a series will look like for a document dated `date`. */
  async preview(ctx: Ctx, key: string, date: string): Promise<string | null> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const rows = (await this.rowsIn(tx, c)).filter((r) => keyOf(r) === key);
      if (rows.length === 0) return null;
      const business = await new BusinessRepo(this.d).get(c);
      const fyStart = Number(business?.['fy_start_month'] ?? 4);
      const label = fyOf(date, fyStart).label;
      const s = settingsOf(rows[0]!);
      const counter =
        s.reset === 'never' ? rows[0]! : rows.find((r) => r['fy'] === label || r['fy'] === null);
      return previewSeries(s, counter ? Number(counter['next_number']) : s.start, date, fyStart);
    });
  }

  /* ------------------------------------------------------------------ sync mode and ranges */

  async getMode(ctx: Ctx): Promise<SyncMode> {
    return (await this.settings.getValue<SyncMode>(ctx, 'sync_mode')) === 'synced'
      ? 'synced'
      : 'local';
  }

  async setMode(ctx: Ctx, mode: SyncMode): Promise<void> {
    await this.settings.set(ctx, 'sync_mode', mode);
  }

  private poolOfIn(row: Row): Pool {
    const json = row['reserved_ranges_json'] as { released?: Range[] } | null;
    return { next: Number(row['next_number']), released: json?.released ?? [] };
  }

  /**
   * Hand this device a range of `size` numbers from the series' counter for `date`'s year. The numbers
   * leave the shared counter, so no other device can be given them.
   */
  async reserveRange(
    ctx: Ctx,
    key: string,
    size: number,
    date: string,
  ): Promise<{ id: string; from: number; to: number }> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const rows = (await this.rowsIn(tx, c)).filter((r) => keyOf(r) === key);
      if (rows.length === 0) throw new NotFoundError('number_series', key);
      const business = await new BusinessRepo(this.d).get(c);
      const label = fyOf(date, Number(business?.['fy_start_month'] ?? 4)).label;
      const s = settingsOf(rows[0]!);
      const counter =
        s.reset === 'never' ? rows[0]! : rows.find((r) => r['fy'] === label || r['fy'] === null);
      if (!counter)
        throw new RuleError('Issue a document in this year first so the series has a counter.');
      const { pool, reservation } = reserve(this.poolOfIn(counter), size);
      await this.updateIn(
        tx,
        c,
        counter['id'],
        {
          next_number: pool.next,
          reserved_ranges_json: { released: pool.released },
          fy: counter['fy'] ?? label,
        },
        counter['version'],
      );
      const made = await new ReservationRepo(this.d).createWith(tx, c, {
        series_id: counter['id'],
        device_id: null,
        from_number: reservation.from,
        to_number: reservation.to,
        used: 0,
        status: 'active',
      });
      return { id: made['id'], from: reservation.from, to: reservation.to };
    });
  }

  /** Return a range's unused numbers to the pool. */
  async releaseRange(ctx: Ctx, reservationId: string): Promise<void> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const res = new ReservationRepo(this.d);
      const r = await res.getWith(tx, c, reservationId);
      if (!r) throw new NotFoundError('number_reservations', reservationId);
      if (r['status'] !== 'active') return;
      const counterRows = await this.rowsIn(tx, c);
      const counter = counterRows.find((x) => x['id'] === r['series_id']);
      if (!counter) throw new NotFoundError('number_series', r['series_id']);
      const range: Reservation = {
        from: Number(r['from_number']),
        to: Number(r['to_number']),
        used: Number(r['used']),
      };
      const pool = release(this.poolOfIn(counter), range);
      await this.updateIn(
        tx,
        c,
        counter['id'],
        { next_number: pool.next, reserved_ranges_json: { released: pool.released } },
        counter['version'],
      );
      await res.updateWith(tx, c, reservationId, { status: 'released' }, r['version']);
    });
  }

  /** The active range with numbers left on a counter row, if any. */
  async activeRangeIn(tx: any, ctx: Ctx, counterId: string): Promise<Row | null> {
    const res = this.d.schema.number_reservations;
    const rows: Row[] = await tx
      .select()
      .from(res)
      .where(
        and(
          eq(res.business_id, ctx.businessId),
          eq(res.series_id, counterId),
          eq(res.status, 'active'),
          isNull(res.deleted_at),
        ),
      );
    return (
      rows.find(
        (r) =>
          remaining({
            from: Number(r['from_number']),
            to: Number(r['to_number']),
            used: Number(r['used']),
          }) > 0,
      ) ?? null
    );
  }

  /** Take the next number from a range and close the range when it runs out. */
  async consumeFromIn(tx: any, ctx: Ctx, range: Row): Promise<number> {
    const r: Reservation = {
      from: Number(range['from_number']),
      to: Number(range['to_number']),
      used: Number(range['used']),
    };
    const { number, reservation } = consume(r);
    await new ReservationRepo(this.d).updateWith(
      tx,
      ctx,
      range['id'],
      { used: reservation.used, status: remaining(reservation) === 0 ? 'used' : 'active' },
      range['version'],
    );
    return number;
  }

  /** Ranges of a series, newest first (for settings). */
  async listRanges(ctx: Ctx, key: string): Promise<Row[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const rows = (await this.rowsIn(tx, ctx)).filter((r) => keyOf(r) === key).map((r) => r['id']);
      const res = this.d.schema.number_reservations;
      const all: Row[] = await tx
        .select()
        .from(res)
        .where(and(eq(res.business_id, ctx.businessId), isNull(res.deleted_at)));
      return all.filter((r) => rows.includes(r['series_id']));
    });
  }
}
