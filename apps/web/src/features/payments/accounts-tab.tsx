import { BusinessAccountRepo, SettingsRepo, type Row } from '@gst/db';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@gst/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAppDb, useLiveQuery } from '@/app/db';
import { Field } from '@/features/onboarding/field';
import { dyn } from '@/lib/dyn-key';

type Kind = 'bank' | 'upi' | 'cash' | 'wallet';
const KINDS: Kind[] = ['bank', 'upi', 'cash', 'wallet'];
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Settings → Bank and UPI: the accounts money moves through, which print on documents, and the wording for leftover money. */
export function AccountsTab() {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const accounts = useLiveQuery<Row[]>({
    tables: ['business_accounts'],
    key: ['accounts-all'],
    fn: (d, c) => new BusinessAccountRepo(d).listAccounts(c),
  });
  const wording = useLiveQuery<string | undefined>({
    tables: ['settings'],
    key: ['pay-wording'],
    fn: (d, c) => new SettingsRepo(d).getValue<string>(c, 'payments.wording'),
  });
  const list = accounts.data ?? [];

  const remove = async (a: Row) => {
    if (!database || !ctx) return;
    try {
      await new BusinessAccountRepo(database).removeAccount(ctx, a['id'], a['version']);
      toast.success(t('accounts.removed'));
    } catch (e) {
      toast.error(errText(e));
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="accounts-tab">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{t('accounts.title')}</h2>
        <Button className="ml-auto" data-testid="account-add" onClick={() => setEditing('new')}>
          {t('accounts.add')}
        </Button>
      </div>
      <p className="text-sm text-fg-muted">{t('accounts.help')}</p>
      {list.length === 0 ? (
        <p className="text-sm text-fg-muted" data-testid="accounts-empty">
          {t('accounts.empty')}
        </p>
      ) : (
        <Card className="p-3">
          <ul className="flex flex-col divide-y divide-border">
            {list.map((a) => (
              <li
                key={a['id']}
                className="flex flex-wrap items-center gap-2 py-2"
                data-testid="account-row"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 font-medium">
                    {a['name']}
                    {a['is_default'] && <Badge>{t('accounts.default')}</Badge>}
                  </p>
                  <p className="text-sm text-fg-muted">
                    {t(dyn(`accounts.kinds.${a['kind']}`))}
                    {a['upi_id'] ? ` · ${a['upi_id']}` : ''}
                    {a['account_no'] ? ` · ${a['account_no']}` : ''}
                    {a['ifsc'] ? ` · ${a['ifsc']}` : ''}
                    {a['show_on_documents'] ? ` · ${t('accounts.show')}` : ''}
                  </p>
                </div>
                <Button variant="outline" data-testid="account-edit" onClick={() => setEditing(a)}>
                  {t('accounts.edit')}
                </Button>
                <Button variant="ghost" data-testid="account-remove" onClick={() => void remove(a)}>
                  {t('accounts.remove')}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Field label={t('pay.wording')}>
        {(c) => (
          <Select
            value={wording.data === 'advance' ? 'advance' : 'credit'}
            onValueChange={(v) => {
              if (!database || !ctx) return;
              void new SettingsRepo(database)
                .set(ctx, 'payments.wording', v)
                .then(() => toast.success(t('pay.wordingSaved')));
            }}
          >
            <SelectTrigger {...c} className="w-56" data-testid="pay-wording">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="credit">{t('pay.wordingCredit')}</SelectItem>
              <SelectItem value="advance">{t('pay.wordingAdvance')}</SelectItem>
            </SelectContent>
          </Select>
        )}
      </Field>

      {editing && (
        <AccountDialog
          account={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function AccountDialog({ account, onClose }: { account: Row | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const [kind, setKind] = useState<Kind>((account?.['kind'] as Kind) ?? 'bank');
  const [name, setName] = useState(account?.['name'] ?? '');
  const [holder, setHolder] = useState(account?.['holder_name'] ?? '');
  const [number, setNumber] = useState(account?.['account_no'] ?? '');
  const [ifsc, setIfsc] = useState(account?.['ifsc'] ?? '');
  const [type, setType] = useState(account?.['account_type'] ?? '');
  const [upi, setUpi] = useState(account?.['upi_id'] ?? '');
  const [isDefault, setIsDefault] = useState(!!account?.['is_default']);
  const [show, setShow] = useState(account ? !!account['show_on_documents'] : true);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!database || !ctx) return;
    setError(null);
    try {
      const repo = new BusinessAccountRepo(database);
      const input = {
        kind,
        name,
        holderName: holder,
        accountNo: number,
        ifsc,
        accountType: type,
        upiId: upi,
        isDefault,
        showOnDocuments: show,
      };
      if (account) await repo.updateAccount(ctx, account['id'], account['version'], input);
      else await repo.createAccount(ctx, input);
      toast.success(t('accounts.saved'));
      onClose();
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="account-dialog" className="max-h-[90vh] overflow-auto">
        <DialogTitle className="text-lg font-semibold">
          {account ? t('accounts.edit') : t('accounts.add')}
        </DialogTitle>
        <DialogDescription className="sr-only">{t('accounts.help')}</DialogDescription>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('accounts.kind')}>
            {(c) => (
              <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
                <SelectTrigger {...c} data-testid="account-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {t(`accounts.kinds.${k}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <Field label={t('accounts.name')}>
            {(c) => (
              <Input
                {...c}
                data-testid="account-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          {kind === 'bank' && (
            <>
              <Field label={t('accounts.holder')}>
                {(c) => (
                  <Input
                    {...c}
                    data-testid="account-holder"
                    value={holder}
                    onChange={(e) => setHolder(e.target.value)}
                  />
                )}
              </Field>
              <Field label={t('accounts.number')}>
                {(c) => (
                  <Input
                    {...c}
                    inputMode="numeric"
                    data-testid="account-number"
                    value={number}
                    onChange={(e) => setNumber(e.target.value)}
                  />
                )}
              </Field>
              <Field label={t('accounts.ifsc')}>
                {(c) => (
                  <Input
                    {...c}
                    data-testid="account-ifsc"
                    value={ifsc}
                    onChange={(e) => setIfsc(e.target.value)}
                  />
                )}
              </Field>
              <Field label={t('accounts.type')}>
                {(c) => (
                  <Input
                    {...c}
                    data-testid="account-type"
                    value={type}
                    onChange={(e) => setType(e.target.value)}
                  />
                )}
              </Field>
            </>
          )}
          {kind === 'upi' && (
            <Field label={t('accounts.upi')}>
              {(c) => (
                <Input
                  {...c}
                  data-testid="account-upi"
                  value={upi}
                  onChange={(e) => setUpi(e.target.value)}
                />
              )}
            </Field>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            data-testid="account-default"
            checked={isDefault}
            onCheckedChange={(v) => setIsDefault(v === true)}
          />
          {t('accounts.isDefault')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            data-testid="account-show"
            checked={show}
            onCheckedChange={(v) => setShow(v === true)}
          />
          {t('accounts.show')}
        </label>
        {error && (
          <p role="alert" className="text-sm text-danger" data-testid="account-error">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t('lock.cancel')}
          </Button>
          <Button data-testid="account-save" onClick={() => void save()}>
            {t('accounts.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
