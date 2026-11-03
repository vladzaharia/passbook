import { useState } from 'react';
import type { z } from 'zod';
import type { UserDetailSchema } from '@/shared/contracts/users.ts';
import { ACTION_ICON } from '@/web/lib/action-icons.ts';
import { removeEmailConfirm, revokeSessionsConfirm } from '@/web/lib/confirms.ts';
import { ENTITY } from '@/web/lib/entities.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import { removeWithTransition } from '@/web/lib/motion.ts';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardLink,
  ConfirmDialog,
  CountLink,
  EmailList,
  EmptyState,
  KeyValue,
  ListRow,
  ListRows,
  SessionList,
  toast,
} from '@/web/ui/index.ts';
import { useIdpUrl } from '../settings/queries.ts';
import { isPolaris, methodsLabel, providerLabel } from './labels.ts';
import { useUserMutations } from './queries.ts';

export type UserDetail = z.infer<typeof UserDetailSchema>;

export function EmailsCard({ user, self }: { user: UserDetail; self: boolean }) {
  const { addEmail, removeEmail, makePrimary } = useUserMutations(user.id);
  const [addError, setAddError] = useState<string>();
  const [removing, setRemoving] = useState<string>();
  const [promoting, setPromoting] = useState<string>();
  const busyEmail = addEmail.isPending
    ? addEmail.variables
    : makePrimary.isPending
      ? makePrimary.variables
      : undefined;

  async function add(email: string) {
    setAddError(undefined);
    try {
      await addEmail.mutateAsync(email);
      toast.success('Email added');
    } catch (cause) {
      setAddError(errorMessage(cause));
    }
  }

  return (
    <Card>
      <CardHeader title="Emails" />
      <CardBody>
        <EmailList
          addLabel="Add verified email"
          items={user.emails.map((e) => ({
            email: e.email,
            primary: e.email === user.primaryEmail,
            verified: true,
            pending: false,
          }))}
          busyEmail={busyEmail}
          addError={addError}
          onAdd={(email) => void add(email)}
          onRemove={setRemoving}
          onMakePrimary={setPromoting}
          onResend={() => undefined}
          onCancelPending={() => undefined}
        />
      </CardBody>
      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(o) => !o && setRemoving(undefined)}
        {...removeEmailConfirm(removing ?? 'email', self)}
        destructive
        onConfirm={async () => {
          if (!removing) return;
          await removeEmail.mutateAsync(removing);
          toast.success('Email removed');
        }}
      />
      <ConfirmDialog
        open={promoting !== undefined}
        onOpenChange={(o) => !o && setPromoting(undefined)}
        title="Make primary?"
        description={`Sign-in emails go to ${promoting ?? ''}.`}
        confirmLabel="Make primary"
        onConfirm={async () => {
          if (!promoting) return;
          await makePrimary.mutateAsync(promoting);
          toast.success('Primary email changed');
        }}
      />
    </Card>
  );
}

/** `self`: your own sessions; Revoke all would end this one too, so Account owns that. */
export function SessionsCard({
  user,
  self,
  now,
}: {
  user: UserDetail;
  self: boolean;
  now: number;
}) {
  const { revokeSessions, revokeSession } = useUserMutations(user.id);
  const [confirm, setConfirm] = useState(false);
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const live = user.sessions.filter(
    (s) => s.revokedAt === null && s.expiresAt > now && !gone.has(s.id),
  );
  const others = live.filter((s) => !s.current);

  async function revoke(id: string) {
    try {
      await revokeSession.mutateAsync(id);
      removeWithTransition(() => setGone((g) => new Set(g).add(id)));
      toast.success('Session revoked');
    } catch (cause) {
      toast.error(cause, 'Could not revoke');
    }
  }

  return (
    <Card>
      <CardHeader
        title="Sessions"
        actions={
          others.length > 0 && !self ? (
            <Button
              variant="ghost"
              size="sm"
              iconStart={<ACTION_ICON.signOut aria-hidden />}
              onClick={() => setConfirm(true)}
            >
              Revoke all
            </Button>
          ) : null
        }
      />
      {live.length === 0 ? (
        <EmptyState inline art={ENTITY.device.art} title="No sessions" />
      ) : (
        <CardBody>
          <SessionList
            items={live}
            revoking={revokeSession.isPending ? revokeSession.variables : undefined}
            onRevoke={(id) => void revoke(id)}
          />
        </CardBody>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        {...revokeSessionsConfirm(user.name ?? user.primaryEmail)}
        destructive
        onConfirm={async () => {
          await revokeSessions.mutateAsync();
          toast.success('Sessions revoked');
        }}
      />
    </Card>
  );
}

export function IdentitiesCard({ user }: { user: UserDetail }) {
  const idpUrl = useIdpUrl();
  const polaris = user.identities.some((i) => isPolaris(i.provider));
  return (
    <Card>
      <CardHeader
        title="Sign-in identities"
        actions={polaris && idpUrl ? <CardLink href={idpUrl}>Manage in Polaris ID</CardLink> : null}
      />
      {user.identities.length === 0 ? (
        <EmptyState inline art={ENTITY.user.art} title="No linked identities" />
      ) : (
        <CardBody>
          <ListRows label="Sign-in identities">
            {user.identities.map((i) => (
              <ListRow
                key={`${i.provider}:${i.subject}`}
                leading={<ENTITY.identity.icon aria-hidden />}
                title={providerLabel(i.provider)}
                meta={[i.emailClaim, `Last used ${formatDateTime(i.lastUsedAt, '—')}`]
                  .filter(Boolean)
                  .join(' · ')}
                trailing={
                  i.groups.length ? (
                    <span className="flex max-w-48 flex-wrap justify-end gap-1">
                      {i.groups.map((g) => (
                        <Badge key={g}>{g}</Badge>
                      ))}
                    </span>
                  ) : null
                }
              />
            ))}
          </ListRows>
        </CardBody>
      )}
    </Card>
  );
}

/** The aside: what the account is, at a glance. */
export function AccountCard({ user }: { user: UserDetail }) {
  return (
    <Card>
      <CardHeader title="Account" />
      <CardBody>
        <KeyValue
          items={[
            { label: 'Signs in with', value: methodsLabel(user.signInMethods) },
            {
              label: 'Passes',
              value: (
                <CountLink
                  count={user.passCount}
                  noun={['pass', 'passes']}
                  icon={ENTITY.pass.icon}
                  to="/admin/passes"
                  search={{ q: user.primaryEmail }}
                />
              ),
            },
            { label: 'Created', value: formatDateTime(user.createdAt) },
            { label: 'Last sign-in', value: formatDateTime(user.lastLoginAt, '—') },
            { label: 'ID', value: user.id, mono: true },
          ]}
        />
      </CardBody>
    </Card>
  );
}
