/**
 * Settings, Team (prompt 42): who is in the organisation and with what role, invitations (by e-mail or
 * phone, with the accountant preset), the organisation's own roles, each member's devices and sign-ins,
 * and the approval rule. Everything here is the cloud API's; the buttons a role cannot use are not shown,
 * and the server refuses them anyway.
 */
import {
  INVITE_ROLES,
  MODULES,
  MODULE_ACTIONS,
  can,
  type Module,
  type Permissions,
} from '@gst/domain';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  toast,
} from '@gst/ui';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { fromCloud } from './permissions';
import { browserStore } from './source';

import { useConfirm } from '@/app/components/confirm';
import { useAppDb } from '@/app/db';
import {
  CloudClient,
  CloudError,
  readSession,
  type CloudMe,
  type CustomRole,
  type MyInvite,
  type RoleChoice,
  type SignIn,
  type Team,
} from '@/features/cloud/client';
import { dyn } from '@/lib/dyn-key';

const errText = (e: unknown) =>
  e instanceof CloudError ? e.message : e instanceof Error ? e.message : String(e);

/** `role:<builtin>` or `custom:<id>` in one select. */
const choiceOf = (v: string): RoleChoice =>
  v.startsWith('custom:') ? { roleId: v.slice(7) } : { role: v.slice(5) };

export function TeamTab() {
  const { t } = useTranslation();
  const { ctx } = useAppDb();
  const confirm = useConfirm();
  const session = readSession(browserStore.get);
  const client = useCallback(
    () => new CloudClient(session?.baseUrl ?? '', session?.token ?? null),
    [session?.baseUrl, session?.token],
  );
  const [me, setMe] = useState<CloudMe | null>(null);
  const [orgId, setOrgId] = useState('');
  const [perms, setPerms] = useState<Permissions | null>(null);
  const [team, setTeam] = useState<Team | null>(null);
  const [mine, setMine] = useState<MyInvite[]>([]);
  const [busy, setBusy] = useState(false);
  const [to, setTo] = useState('');
  const [inviteRole, setInviteRole] = useState('role:sales');
  const [editing, setEditing] = useState<Partial<CustomRole> | null>(null);
  const [signIns, setSignIns] = useState<{ name: string; rows: SignIn[] } | null>(null);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast.success(t(dyn(ok)));
      await reload();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const reload = useCallback(async () => {
    if (!session) return;
    const c = client();
    const m = await c.me();
    setMe(m);
    setMine(await c.myInvites());
    const id =
      orgId || m.organisations.find((o) => o.id === ctx?.orgId)?.id || m.organisations[0]?.id || '';
    if (id !== orgId) setOrgId(id);
    if (!id) return;
    const p = fromCloud(await c.permissions(id)).perms;
    setPerms(p);
    setTeam(can(p, 'team', 'view') ? await c.team(id) : null);
  }, [session, client, orgId, ctx?.orgId]);

  useEffect(() => {
    reload().catch((e: unknown) => toast.error(errText(e)));
  }, [reload]);

  if (!session)
    return (
      <Card className="max-w-3xl p-4" data-testid="team-signin">
        <p className="text-sm">{t('team.signInFirst')}</p>
      </Card>
    );

  const may = (m: Module, a: Parameters<typeof can>[2]) => !!perms && can(perms, m, a);
  const roleOptions = [
    ...INVITE_ROLES.map((r) => ({ value: `role:${r}`, label: t(dyn(`team.roles.${r}`)) })),
    ...(team?.roles ?? []).map((r) => ({ value: `custom:${r.id}`, label: r.name })),
  ];
  const isOwner = perms?.role === 'owner';

  const invite = (role: string) => {
    const value = to.trim();
    const target = value.startsWith('+') ? { phone: value } : { email: value };
    return run(async () => {
      await client().invite(orgId, target, choiceOf(role));
      setTo('');
    }, 'team.invited');
  };

  return (
    <div className="flex max-w-4xl flex-col gap-4" data-testid="team-tab">
      {mine.length > 0 && (
        <Card className="p-4" data-testid="team-my-invites">
          <h2 className="pb-2 font-medium">{t('team.forYou')}</h2>
          <ul className="divide-y divide-border text-sm">
            {mine.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="grow">
                  {t('team.invitedTo', { org: i.orgName, role: i.roleName, by: i.invitedBy })}
                </span>
                <Button
                  data-testid="team-accept"
                  disabled={busy}
                  onClick={() => void run(() => client().answerInvite(i.id, true), 'team.joined')}
                >
                  {t('team.accept')}
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void run(() => client().answerInvite(i.id, false))}
                >
                  {t('team.decline')}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {me && me.organisations.length > 1 && (
        <Select value={orgId} onValueChange={(v) => setOrgId(v)}>
          <SelectTrigger className="w-72" data-testid="team-org" aria-label={t('team.org')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {me.organisations.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {perms && (
        <p className="text-sm" data-testid="team-my-role">
          {t('team.yourRole', { role: perms.roleName ?? t(dyn(`team.roles.${perms.role}`)) })}
        </p>
      )}

      {team && (
        <Card className="p-4">
          <h2 className="pb-2 font-medium">{t('team.members')}</h2>
          <ul className="divide-y divide-border text-sm" data-testid="team-members">
            {team.members.map((m) => (
              <li key={m.memberId} className="flex flex-col gap-2 py-2" data-testid="team-member">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="grow">
                    <span className="font-medium">{m.name}</span>{' '}
                    <span className="text-fg-muted">{m.email ?? m.phone ?? ''}</span>
                  </span>
                  {may('team', 'edit') && m.role !== 'owner' ? (
                    <Select
                      value={m.roleId ? `custom:${m.roleId}` : `role:${m.role}`}
                      onValueChange={(v) =>
                        void run(
                          () => client().changeRole(orgId, m.memberId, choiceOf(v)),
                          'team.changed',
                        )
                      }
                    >
                      <SelectTrigger
                        className="w-44"
                        data-testid="team-member-role"
                        aria-label={t('team.role')}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {roleOptions.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Badge tone="neutral">
                      {m.roleId ? m.roleName : t(dyn(`team.roles.${m.role}`))}
                    </Badge>
                  )}
                  <Button
                    variant="ghost"
                    data-testid="team-sign-ins"
                    onClick={() =>
                      void client()
                        .signIns(orgId, m.memberId)
                        .then((rows) => setSignIns({ name: m.name, rows }))
                        .catch((e: unknown) => toast.error(errText(e)))
                    }
                  >
                    {t('team.signIns')}
                  </Button>
                  {may('team', 'edit') && m.role !== 'owner' && (
                    <Button
                      variant="ghost"
                      data-testid="team-remove"
                      disabled={busy}
                      onClick={async () => {
                        if (await confirm({ title: t('team.removeConfirm', { name: m.name }) }))
                          void run(() => client().removeMember(orgId, m.memberId), 'team.removed');
                      }}
                    >
                      {t('team.remove')}
                    </Button>
                  )}
                </div>
                {m.devices.length > 0 && (
                  <ul className="pl-4 text-xs text-fg-muted" data-testid="team-devices">
                    {m.devices.map((d) => (
                      <li key={d.id} className="flex items-center gap-2">
                        <span className="grow">
                          {d.name}
                          {d.lastSeenAt
                            ? ` · ${t('team.seen', { when: new Date(d.lastSeenAt).toLocaleString('en-IN') })}`
                            : ''}
                        </span>
                        {d.revokedAt ? (
                          <Badge tone="neutral">{t('team.revoked')}</Badge>
                        ) : (
                          may('team', 'edit') && (
                            <Button
                              variant="ghost"
                              data-testid="team-revoke"
                              disabled={busy}
                              onClick={() =>
                                void run(
                                  () => client().revokeDevice(orgId, d.id),
                                  'team.deviceRevoked',
                                )
                              }
                            >
                              {t('team.revoke')}
                            </Button>
                          )
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {team && may('team', 'create') && (
        <Card className="p-4" data-testid="team-invite">
          <h2 className="pb-2 font-medium">{t('team.invite')}</h2>
          <div className="flex flex-wrap items-end gap-2">
            <Input
              className="w-72"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder={t('team.toPlaceholder')}
              aria-label={t('team.to')}
              data-testid="team-invite-to"
            />
            <Select value={inviteRole} onValueChange={setInviteRole}>
              <SelectTrigger
                className="w-44"
                data-testid="team-invite-role"
                aria-label={t('team.role')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roleOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              data-testid="team-invite-send"
              disabled={busy || !to.trim()}
              onClick={() => void invite(inviteRole)}
            >
              {t('team.send')}
            </Button>
            <Button
              variant="secondary"
              data-testid="team-invite-accountant"
              disabled={busy || !to.trim()}
              onClick={() => void invite('role:accountant')}
            >
              {t('team.inviteAccountant')}
            </Button>
          </div>
          {team.invites.length > 0 && (
            <ul className="divide-y divide-border pt-3 text-sm" data-testid="team-pending">
              {team.invites.map((i) => (
                <li key={i.id} className="flex items-center gap-2 py-1">
                  <span className="grow">
                    {i.email ?? i.phone} · {i.roleId ? i.roleName : t(dyn(`team.roles.${i.role}`))}
                  </span>
                  <Button
                    variant="ghost"
                    data-testid="team-withdraw"
                    disabled={busy}
                    onClick={() =>
                      void run(() => client().withdrawInvite(orgId, i.id), 'team.withdrawn')
                    }
                  >
                    {t('team.withdraw')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {team && may('team', 'edit') && (
        <Card className="p-4" data-testid="team-roles">
          <div className="flex items-center pb-2">
            <h2 className="grow font-medium">{t('team.customRoles')}</h2>
            <Button
              variant="secondary"
              data-testid="team-role-new"
              onClick={() => setEditing({ name: '', grants: {} })}
            >
              {t('team.newRole')}
            </Button>
          </div>
          {team.roles.length === 0 ? (
            <p className="text-sm text-fg-muted">{t('team.noRoles')}</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {team.roles.map((r) => (
                <li key={r.id} className="flex items-center gap-2 py-1">
                  <span className="grow">
                    {r.name}{' '}
                    <span className="text-fg-muted">{t('team.holders', { count: r.members })}</span>
                  </span>
                  <Button variant="ghost" onClick={() => setEditing(r)}>
                    {t('team.edit')}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy || r.members > 0}
                    onClick={() =>
                      void run(() => client().deleteRole(orgId, r.id), 'team.roleDeleted')
                    }
                  >
                    {t('team.delete')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {team && isOwner && (
        <Card className="p-4">
          <label className="flex items-center gap-2 text-sm" htmlFor="team-approvals">
            <Switch
              id="team-approvals"
              data-testid="team-approvals"
              checked={team.policy.approvals}
              disabled={busy}
              onCheckedChange={(v) =>
                void run(() => client().setPolicy(orgId, v), 'team.policySaved')
              }
            />
            {t('team.approvals')}
          </label>
          <p className="pt-1 text-xs text-fg-muted">{t('team.approvalsHelp')}</p>
        </Card>
      )}

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-3xl" data-testid="team-role-editor">
          <DialogTitle>{editing?.id ? t('team.editRole') : t('team.newRole')}</DialogTitle>
          {editing && (
            <RoleEditor
              value={editing}
              limit={perms}
              onChange={setEditing}
              onSave={() =>
                void run(async () => {
                  await client().saveRole(orgId, {
                    ...(editing.id ? { id: editing.id } : {}),
                    name: editing.name ?? '',
                    grants: editing.grants ?? {},
                  });
                  setEditing(null);
                }, 'team.roleSaved')
              }
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!signIns} onOpenChange={(o) => !o && setSignIns(null)}>
        <DialogContent data-testid="team-sign-in-list">
          <DialogTitle>{t('team.signInsOf', { name: signIns?.name ?? '' })}</DialogTitle>
          <ul className="max-h-80 overflow-auto text-sm">
            {(signIns?.rows ?? []).map((s) => (
              <li key={s.at} className="border-b border-border py-1">
                {new Date(s.at).toLocaleString('en-IN')}
                {s.current ? ` · ${t('team.thisSession')}` : ''}
                <span className="block text-xs text-fg-muted">
                  {[s.ip, s.userAgent].filter(Boolean).join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The grid of a custom role: a row per module, a box per action that module has. */
function RoleEditor(props: {
  value: Partial<CustomRole>;
  limit: Permissions | null;
  onChange: (v: Partial<CustomRole>) => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  const grants = props.value.grants ?? {};
  const toggle = (m: Module, a: string, on: boolean) => {
    const cur = new Set(grants[m] ?? []);
    if (on) cur.add(a);
    else cur.delete(a);
    props.onChange({ ...props.value, grants: { ...grants, [m]: [...cur] } });
  };
  return (
    <div className="flex flex-col gap-3">
      <Input
        value={props.value.name ?? ''}
        onChange={(e) => props.onChange({ ...props.value, name: e.target.value })}
        placeholder={t('team.roleName')}
        aria-label={t('team.roleName')}
        data-testid="team-role-name"
      />
      <table className="text-sm" data-testid="team-role-grid">
        <tbody>
          {MODULES.map((m) => (
            <tr key={m} className="border-b border-border">
              <td className="py-1 pr-3">{t(dyn(`team.modules.${m}`))}</td>
              <td className="flex flex-wrap gap-3 py-1">
                {MODULE_ACTIONS[m].map((a) => (
                  <label key={a} className="flex items-center gap-1">
                    <Checkbox
                      data-testid={`grant-${m}-${a}`}
                      checked={(grants[m] ?? []).includes(a)}
                      // nobody can give more than they hold
                      disabled={!props.limit || !can(props.limit, m, a)}
                      onCheckedChange={(v) => toggle(m, a, v === true)}
                    />
                    {t(dyn(`team.actions.${a}`))}
                  </label>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex justify-end">
        <Button
          data-testid="team-role-save"
          disabled={!props.value.name?.trim()}
          onClick={props.onSave}
        >
          {t('team.save')}
        </Button>
      </div>
    </div>
  );
}
