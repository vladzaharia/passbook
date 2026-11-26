import { Pause, ShieldCheck, ShieldOff, UserMinus, UserPlus } from 'lucide-react';
import { useState } from 'react';
import type { AccessView } from '@/shared/contracts/idp-access.ts';
import { IDP_COPY, idpPlural } from '@/shared/copy/idp.ts';
import {
  removeExternalConfirm,
  restoreRoleConfirm,
  revokeRoleConfirm,
} from '@/web/lib/confirms-idp.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  KeyValue,
  ListRow,
  ListRows,
  type RowAction,
  RowActions,
  toast,
} from '@/web/ui/index.ts';
import { useAccessActions } from './queries.ts';

type Role = AccessView['roles'][number];
type Act = { kind: 'restore' | 'revoke' | 'remove'; role: Role['role'] };

/** Why the role is on: the sources PassBook counted, or what Polaris ID showed. */
function why(r: Role): string {
  if (r.held) return IDP_COPY.paused;
  const orgs = (list: Role['memberships']) => list.map((m) => m.org.name).join(', ');
  if (r.role === 'console' && r.wanted)
    return `From ${idpPlural(r.memberships.length, 'membership')}`;
  if (r.sponsorships.length) return `Sponsored by ${orgs(r.sponsorships)}`;
  if (r.grantedAt) return `Granted ${formatDateTime(r.grantedAt, '')}`;
  if (r.presence === 'external') return IDP_COPY.account.external;
  return 'Not given';
}

function state(r: Role) {
  if (r.held) return <Badge tone="warning">{IDP_COPY.accessPaused}</Badge>;
  if (r.error) return <Badge tone="danger">Failed</Badge>;
  if (r.present === true || (r.wanted && r.present === null))
    return <Badge tone="success">On</Badge>;
  return <Badge>Off</Badge>;
}

/**
 * Per role: what PassBook wants and why, what Polaris ID showed, and the one action that fits.
 * Console follows memberships and is never granted here; Restore, Revoke and Remove ask first.
 */
export function AccessCard({
  access,
  person,
  userId,
  onStarted,
}: {
  access: AccessView;
  person: string;
  userId: string;
  onStarted: (id: string) => void;
}) {
  const actions = useAccessActions(userId, onStarted);
  const [asking, setAsking] = useState<Act | null>(null);
  const copy = asking
    ? asking.kind === 'restore'
      ? restoreRoleConfirm(asking.role, person)
      : asking.kind === 'revoke'
        ? revokeRoleConfirm(asking.role, person)
        : removeExternalConfirm(asking.role, person)
    : null;

  const grant = async (role: 'developer' | 'support') => {
    try {
      await actions.grant.mutateAsync({ role, grant: true });
      toast.success(`${IDP_COPY.role[role]} access granted`);
    } catch (cause) {
      toast.error(cause, 'Could not grant');
    }
  };
  const rowActions = (r: Role): RowAction[] => {
    const busy = actions.grant.isPending || actions.restore.isPending;
    if (r.held)
      return [
        {
          label: 'Restore',
          icon: ShieldCheck,
          loading: busy,
          onSelect: () => setAsking({ kind: 'restore', role: r.role }),
        },
      ];
    const out: RowAction[] = [];
    if (r.role !== 'console' && r.grantedAt)
      out.push({
        label: 'Revoke',
        icon: UserMinus,
        destructive: true,
        onSelect: () => setAsking({ kind: 'revoke', role: r.role }),
      });
    else if (r.role !== 'console' && !r.wanted && r.presence !== 'external')
      out.push({
        label: 'Grant',
        icon: UserPlus,
        loading: busy,
        onSelect: () => void grant(r.role as 'developer' | 'support'),
      });
    if (r.presence === 'external' && !r.wanted)
      out.push({
        label: 'Remove',
        icon: ShieldOff,
        destructive: true,
        onSelect: () => setAsking({ kind: 'remove', role: r.role }),
      });
    return out;
  };

  const run = async () => {
    if (!asking) return;
    if (asking.kind === 'restore') {
      await actions.restore.mutateAsync(asking.role);
    } else if (asking.kind === 'revoke') {
      await actions.grant.mutateAsync({
        role: asking.role as 'developer' | 'support',
        grant: false,
      });
      toast.success('Access revoked');
    } else {
      await actions.removeExternal.mutateAsync(asking.role);
      toast.success('Role removed in Polaris ID');
    }
  };

  const account = access.account;
  const accountLabel = !access.linked
    ? IDP_COPY.account.none
    : account.disabledInIdp
      ? IDP_COPY.account.disabled
      : account.class
        ? IDP_COPY.account[account.class]
        : 'Linked';

  return (
    <Card>
      <CardHeader title="Polaris ID access" />
      <CardBody>
        <div className="flex flex-col gap-4">
          <KeyValue
            items={[
              { label: 'Account', value: accountLabel },
              ...(access.platformAdmin
                ? [{ label: 'Platform admin', value: 'Set in Polaris ID' }]
                : []),
            ]}
          />
          <ListRows label="Roles">
            {access.roles.map((r) => (
              <ListRow
                key={r.role}
                leading={r.held ? <Pause aria-hidden /> : <ShieldCheck aria-hidden />}
                title={IDP_COPY.role[r.role]}
                pills={state(r)}
                meta={r.error ? `Last change failed (${r.error}). It retries on its own.` : why(r)}
                trailing={
                  <RowActions label={`${IDP_COPY.role[r.role]} actions`} actions={rowActions(r)} />
                }
              />
            ))}
          </ListRows>
        </div>
      </CardBody>
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => !open && setAsking(null)}
        {...(copy ?? { title: '', confirmLabel: '', description: '' })}
        destructive={asking?.kind !== 'restore'}
        onConfirm={run}
      />
    </Card>
  );
}
