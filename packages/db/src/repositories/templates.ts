/**
 * Print templates a business has saved (the five shipped presets are not rows; they live in code and
 * are referred to as `preset:<id>`), and which template each document type uses in Books and in Shop.
 * The template itself is the JSON `@gst/print` validates; this repository only stores it.
 */
import type { Database } from '../database';
import type { Row } from '../schema';

import { SettingsRepo } from './aggregates';
import { BaseRepo, RuleError, runInTx, type Ctx } from './base';

export type Shell = 'books' | 'shop';
export type TemplateDefaults = Record<string, Partial<Record<Shell, string>>>;

const DEFAULTS_KEY = 'print.defaults';
const MAX_BYTES = 64 * 1024;

export class TemplateRepo extends BaseRepo {
  private readonly settings: SettingsRepo;

  constructor(d: Database) {
    super(d, 'templates');
    this.settings = new SettingsRepo(d);
  }

  /** The business's saved templates, by name. */
  async listTemplates(ctx: Ctx): Promise<Row[]> {
    const rows = await this.list(ctx);
    return rows
      .filter((r) => r['kind'] === 'document')
      .sort((a, b) => String(a['name']).localeCompare(String(b['name'])));
  }

  private async checkIn(tx: any, ctx: Ctx, name: string, config: unknown, exceptId?: string) {
    const n = name.trim();
    if (!n) throw new RuleError('Give the template a name.');
    if (JSON.stringify(config).length > MAX_BYTES)
      throw new RuleError('The template is too large.');
    const clash = (await this.list({ ...ctx, tx })).find(
      (r) =>
        r['kind'] === 'document' &&
        r['id'] !== exceptId &&
        String(r['name']).toLowerCase() === n.toLowerCase(),
    );
    if (clash) throw new RuleError(`A template named "${clash['name']}" already exists.`);
    return n;
  }

  /** Save a new template. `config` is a validated template spec. */
  async createTemplate(ctx: Ctx, name: string, config: unknown): Promise<Row> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const n = await this.checkIn(tx, c, name, config);
      return this.createIn(tx, c, {
        name: n,
        kind: 'document',
        config_json: config,
        is_default: false,
      });
    });
  }

  /** Change a template's name and content. */
  async updateTemplate(
    ctx: Ctx,
    id: string,
    expectedVersion: number,
    name: string,
    config: unknown,
  ): Promise<Row> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const n = await this.checkIn(tx, c, name, config, id);
      return this.updateIn(tx, c, id, { name: n, config_json: config }, expectedVersion);
    });
  }

  /** Delete a template. One that is still a default for a document type is refused, with where. */
  async deleteTemplate(ctx: Ctx, id: string, expectedVersion: number): Promise<Row> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const used: string[] = [];
      const defaults = await this.getDefaults(c);
      for (const [type, byShell] of Object.entries(defaults))
        for (const [shell, tid] of Object.entries(byShell))
          if (tid === id) used.push(`${type.replace(/_/g, ' ')} in ${shell}`);
      if (used.length > 0)
        throw new RuleError(
          `This template is the default for ${used.join(', ')}. Choose another default first.`,
        );
      return this.softDelete(c, id, expectedVersion);
    });
  }

  async getDefaults(ctx: Ctx): Promise<TemplateDefaults> {
    const v = await this.settings.getValue<TemplateDefaults>(ctx, DEFAULTS_KEY);
    return v && typeof v === 'object' ? v : {};
  }

  /** Make a template (a saved id, or `preset:<id>`) the default for a document type in a shell; null clears it. */
  async setDefault(
    ctx: Ctx,
    documentType: string,
    shell: Shell,
    templateId: string | null,
  ): Promise<void> {
    await runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      if (templateId && !templateId.startsWith('preset:')) {
        const row = await this.getIn(tx, c, templateId);
        if (!row) throw new RuleError('That template no longer exists.');
      }
      const defaults = await this.getDefaults(c);
      // this type's entry with the shell set or cleared, and every other type as it was
      const kept = Object.fromEntries(
        Object.entries({
          ...(defaults[documentType] ?? {}),
          ...(templateId ? { [shell]: templateId } : {}),
        }).filter(([k]) => templateId !== null || k !== shell),
      ) as Partial<Record<Shell, string>>;
      const next: TemplateDefaults = Object.fromEntries(
        Object.entries(defaults).filter(([k]) => k !== documentType),
      );
      if (Object.keys(kept).length > 0) next[documentType] = kept;
      await this.settings.set(c, DEFAULTS_KEY, next);
    });
  }

  /** The template id a document type uses in a shell: its own default, else the `preset:` fallback. */
  async resolveId(
    ctx: Ctx,
    documentType: string,
    shell: Shell,
    fallback = 'preset:classic',
  ): Promise<string> {
    const defaults = await this.getDefaults(ctx);
    const id = defaults[documentType]?.[shell] ?? defaults['*']?.[shell];
    if (!id) return fallback;
    if (id.startsWith('preset:')) return id;
    // a default that was deleted from under us falls back rather than failing a print
    const row = await this.get(ctx, id);
    return row ? id : fallback;
  }
}
