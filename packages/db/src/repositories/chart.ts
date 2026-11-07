/**
 * The chart of accounts the posting rules write to (prompt 50): one row per `AccountKey`, created on demand
 * for businesses from before a key existed, and the groups the statements show them under.
 */
import type { AccountKey, AccountMeta, AccountType } from '@gst/domain';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from '../database';
import type { NewRow, Row } from '../schema';

import { BaseRepo, RuleError, runInTx, type Ctx } from './base';

/** Ledger account for each posting key: [code, name, type]. Created on demand for older businesses. */
export const ACCOUNTS: Record<AccountKey, [string, string, string]> = {
  cash: ['1000', 'Cash', 'asset'],
  bank: ['1100', 'Bank', 'asset'],
  receivables: ['1200', 'Accounts Receivable', 'asset'],
  payables: ['2000', 'Accounts Payable', 'liability'],
  sales: ['4000', 'Sales', 'income'],
  purchases: ['5000', 'Purchases', 'expense'],
  expenses: ['5100', 'Expenses', 'expense'],
  roundOff: ['5200', 'Round-off', 'expense'],
  adjustments: ['5300', 'Adjustments', 'expense'],
  gatewayFees: ['5400', 'Payment gateway fees', 'expense'],
  openingEquity: ['3100', 'Opening Balance Equity', 'equity'],
  capital: ['3000', 'Capital', 'equity'],
  drawings: ['3300', 'Drawings', 'equity'],
  retainedEarnings: ['3200', 'Retained Earnings', 'equity'],
  tcsPayable: ['2200', 'TCS Payable', 'liability'],
  tdsReceivable: ['1400', 'TDS Receivable', 'asset'],
  discountAllowed: ['5500', 'Discount Allowed', 'expense'],
  discountReceived: ['4100', 'Discount Received', 'income'],
  // one ledger per tax head (prompt 50); businesses from before carry the old aggregate ledgers
  // (`LEGACY_TAX_ACCOUNTS`) until the year-end screen reclassifies them
  outputCgst: ['2110', 'Output CGST', 'liability'],
  outputSgst: ['2120', 'Output SGST', 'liability'],
  outputUtgst: ['2130', 'Output UTGST', 'liability'],
  outputIgst: ['2140', 'Output IGST', 'liability'],
  outputCess: ['2150', 'Output Cess', 'liability'],
  inputCgst: ['1310', 'Input CGST', 'asset'],
  inputSgst: ['1320', 'Input SGST', 'asset'],
  inputUtgst: ['1330', 'Input UTGST', 'asset'],
  inputIgst: ['1340', 'Input IGST', 'asset'],
  inputCess: ['1350', 'Input Cess', 'asset'],
};

/** The aggregate tax ledgers businesses posted to before prompt 50. */
export const LEGACY_TAX_ACCOUNTS = { output: '2100', input: '1300' } as const;

/** The sub-group a system account sits under on the statements (prompt 50). */
export const SYSTEM_SUB_GROUPS: Record<string, string> = {
  '1000': 'cash',
  '1100': 'bank',
  '1200': 'receivables',
  '1300': 'duties_taxes',
  '1310': 'duties_taxes',
  '1320': 'duties_taxes',
  '1330': 'duties_taxes',
  '1340': 'duties_taxes',
  '1350': 'duties_taxes',
  '1400': 'duties_taxes',
  '2000': 'payables',
  '2100': 'duties_taxes',
  '2110': 'duties_taxes',
  '2120': 'duties_taxes',
  '2130': 'duties_taxes',
  '2140': 'duties_taxes',
  '2150': 'duties_taxes',
  '2200': 'duties_taxes',
  '3000': 'capital',
  '3100': 'capital',
  '3200': 'reserves',
  '3300': 'drawings',
  '4000': 'sales',
  '4100': 'other_income',
  '5000': 'purchases',
  '5100': 'indirect_expenses',
  '5200': 'indirect_expenses',
  '5300': 'indirect_expenses',
  '5400': 'indirect_expenses',
  '5500': 'indirect_expenses',
};

export interface ChartAccount extends AccountMeta {
  isSystem: boolean;
  tallyName: string | null;
  businessAccountId: string | null;
  version: number;
}

/** The codes user accounts take, by type: from the base up in tens. */
const USER_CODE_BASE: Record<AccountType, number> = {
  asset: 1500,
  liability: 2500,
  equity: 3500,
  income: 4500,
  expense: 6000,
};

export const toMeta = (r: Row): ChartAccount => ({
  id: String(r['id']),
  code: String(r['code']),
  name: String(r['name']),
  type: String(r['type']) as AccountType,
  subGroup: (r['sub_group'] as string | null) ?? SYSTEM_SUB_GROUPS[String(r['code'])] ?? null,
  parentId: (r['parent_id'] as string | null) ?? null,
  isSystem: !!r['is_system'],
  tallyName: (r['tally_name'] as string | null) ?? null,
  businessAccountId: (r['business_account_id'] as string | null) ?? null,
  version: Number(r['version'] ?? 1),
});

/* ------------------------------------------------------------------------------------- chart */

export class ChartRepo extends BaseRepo {
  constructor(d: Database) {
    super(d, 'ledger_accounts');
  }

  async accounts(ctx: Ctx): Promise<ChartAccount[]> {
    return runInTx(this.d, ctx, (tx) => this.accountsIn(tx, ctx));
  }

  async accountsIn(tx: any, ctx: Ctx): Promise<ChartAccount[]> {
    const t = this.t;
    const rows: Row[] = await tx
      .select()
      .from(t)
      .where(and(eq(t.business_id, ctx.businessId), isNull(t.deleted_at)))
      .orderBy(asc(t.code));
    return rows.map(toMeta);
  }

  /** Every system ledger the posting rules may need, made now rather than on first use, with its group. */
  async ensureSystem(ctx: Ctx): Promise<number> {
    return runInTx(this.d, ctx, async (tx) => {
      const have = new Map((await this.accountsIn(tx, ctx)).map((a) => [a.code, a]));
      let made = 0;
      const seen = new Set<string>();
      for (const [code, name, type] of Object.values(ACCOUNTS)) {
        if (seen.has(code)) continue;
        seen.add(code);
        const cur = have.get(code);
        if (cur) {
          if (!cur.subGroup && SYSTEM_SUB_GROUPS[code])
            await this.updateIn(
              tx,
              ctx,
              cur.id,
              { sub_group: SYSTEM_SUB_GROUPS[code] },
              cur.version,
            );
          continue;
        }
        await this.createIn(tx, ctx, {
          code,
          name,
          type,
          sub_group: SYSTEM_SUB_GROUPS[code] ?? null,
          is_system: true,
        });
        made++;
      }
      for (const code of Object.values(LEGACY_TAX_ACCOUNTS)) {
        const cur = have.get(code);
        if (cur && !cur.subGroup)
          await this.updateIn(tx, ctx, cur.id, { sub_group: 'duties_taxes' }, cur.version);
      }
      return made;
    });
  }

  private async nextUserCodeIn(tx: any, ctx: Ctx, type: AccountType): Promise<string> {
    const codes = (await this.accountsIn(tx, ctx))
      .map((a) => Number(a.code))
      .filter((n) => Number.isFinite(n) && n >= USER_CODE_BASE[type]);
    const next = codes.length ? Math.max(...codes) + 10 : USER_CODE_BASE[type];
    return String(next);
  }

  async createAccount(
    ctx: Ctx,
    input: {
      name: string;
      type: AccountType;
      subGroup?: string | null;
      code?: string | null;
      parentId?: string | null;
      tallyName?: string | null;
    },
  ): Promise<ChartAccount> {
    const name = input.name.trim();
    if (!name) throw new RuleError('An account needs a name.');
    return runInTx(this.d, ctx, async (tx) => {
      const code = input.code?.trim() || (await this.nextUserCodeIn(tx, ctx, input.type));
      if (!/^[0-9A-Za-z._-]{1,16}$/.test(code))
        throw new RuleError('The code is up to 16 letters or digits.');
      const have = await this.accountsIn(tx, ctx);
      if (have.some((a) => a.code === code)) throw new RuleError(`Code ${code} is already in use.`);
      if (input.parentId && !have.some((a) => a.id === input.parentId && a.type === input.type))
        throw new RuleError('The parent must be an account of the same type.');
      const row = await this.createIn(tx, ctx, {
        code,
        name,
        type: input.type,
        sub_group: input.subGroup ?? null,
        parent_id: input.parentId ?? null,
        tally_name: input.tallyName?.trim() || null,
        is_system: false,
      });
      return toMeta(row);
    });
  }

  async updateAccount(
    ctx: Ctx,
    id: string,
    patch: {
      name?: string;
      subGroup?: string | null;
      tallyName?: string | null;
      parentId?: string | null;
    },
    version: number,
  ): Promise<ChartAccount> {
    const values: NewRow = {};
    if (patch.name !== undefined) {
      if (!patch.name.trim()) throw new RuleError('An account needs a name.');
      values['name'] = patch.name.trim();
    }
    if (patch.subGroup !== undefined) values['sub_group'] = patch.subGroup;
    if (patch.tallyName !== undefined) values['tally_name'] = patch.tallyName?.trim() || null;
    if (patch.parentId !== undefined) values['parent_id'] = patch.parentId;
    return toMeta(await this.update(ctx, id, values, version));
  }

  /** A user account with nothing posted to it can go; a system account or one with entries cannot. */
  async archiveAccount(ctx: Ctx, id: string, version: number): Promise<void> {
    await runInTx(this.d, ctx, async (tx) => {
      const row = await this.getIn(tx, ctx, id);
      if (!row) throw new RuleError('That account was not found.');
      if (row['is_system']) throw new RuleError('A system account cannot be removed.');
      const le = this.d.schema.ledger_entries;
      const [n]: Row[] = await tx
        .select({ n: sql<number>`count(*)` })
        .from(le)
        .where(
          and(eq(le.business_id, ctx.businessId), eq(le.account_id, id), isNull(le.deleted_at)),
        );
      if (Number(n?.['n'] ?? 0) > 0)
        throw new RuleError('An account with entries cannot be removed.');
      await this.softDelete({ ...ctx, tx }, id, version);
    });
  }

  /** The ledger for a bank, UPI, wallet or cash business account, made on first use (prompt 50). */
  async bankLedgerIdIn(tx: any, ctx: Ctx, businessAccountId: string): Promise<string> {
    const t = this.t;
    const [cur]: Row[] = await tx
      .select({ id: t.id })
      .from(t)
      .where(
        and(
          eq(t.business_id, ctx.businessId),
          eq(t.business_account_id, businessAccountId),
          isNull(t.deleted_at),
        ),
      )
      .limit(1);
    if (cur) return String(cur['id']);
    const ba = this.d.schema.business_accounts;
    const [acc]: Row[] = await tx
      .select()
      .from(ba)
      .where(and(eq(ba.business_id, ctx.businessId), eq(ba.id, businessAccountId)))
      .limit(1);
    if (!acc) throw new RuleError('That business account was not found.');
    const cash = acc['kind'] === 'cash';
    const have = (await this.accountsIn(tx, ctx)).map((a) => Number(a.code));
    const base = cash ? 1001 : 1101;
    let code = base;
    while (have.includes(code)) code++;
    if (code >= base + 99) throw new RuleError('Too many bank ledgers.');
    const made = await this.createIn(tx, ctx, {
      code: String(code),
      name: String(acc['name']),
      type: 'asset',
      sub_group: cash ? 'cash' : 'bank',
      is_system: true,
      business_account_id: businessAccountId,
    });
    return String(made['id']);
  }
}
