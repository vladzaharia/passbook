import { Link } from '@tanstack/react-router';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { z } from 'zod';
import type { UserDetailSchema } from '@/shared/contracts/users.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DataTable,
  FormField,
  IconButton,
  Input,
  StatusPill,
} from '@/web/ui/index.ts';
import { formatDateTime } from '../overview/format.ts';
import { useIdpUrl } from '../settings/queries.ts';
import { amrLabel, roleLabel, VERIFIED_VIA_LABEL } from './labels.ts';
import { useUserMutations } from './queries.ts';

export type UserDetail = z.infer<typeof UserDetailSchema>;

export function EmailsCard({ user }: { user: UserDetail }) {
  const { addEmail, removeEmail } = useUserMutations(user.id);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string>();
  const [removing, setRemoving] = useState<string>();

  async function add() {
    setError(undefined);
    try {
      await addEmail.mutateAsync(email.trim());
      setEmail('');
      toast.success('Email added');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <Card>
      <CardHeader title="Emails" />
      <CardBody className="flex flex-col gap-4">
        <ul className="flex flex-col divide-y divide-border">
          {user.emails.map((e) => (
            <li key={e.email} className="flex items-center justify-between gap-3 py-2 first:pt-0">
              <div className="min-w-0">
                <p className="truncate text-sm text-fg-strong">
                  {e.email}
                  {e.email === user.primaryEmail ? (
                    <StatusPill status="primary" className="ml-2" />
                  ) : null}
                </p>
                <p className="text-xs text-fg-muted">
                  Verified by {VERIFIED_VIA_LABEL[e.verifiedVia] ?? e.verifiedVia},{' '}
                  {formatDateTime(e.verifiedAt)}
                </p>
              </div>
              {e.email === user.primaryEmail ? null : (
                <IconButton
                  label={`Remove ${e.email}`}
                  icon={<Trash2 aria-hidden />}
                  onClick={() => setRemoving(e.email)}
                />
              )}
            </li>
          ))}
        </ul>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (email.trim()) void add();
          }}
        >
          <FormField label="Add verified email" error={error} className="min-w-56 flex-1">
            {(p) => (
              <Input
                {...p}
                type="email"
                value={email}
                onChange={(ev) => setEmail(ev.target.value)}
              />
            )}
          </FormField>
          <Button
            type="submit"
            variant="outline"
            iconStart={<Plus aria-hidden />}
            loading={addEmail.isPending}
          >
            Add
          </Button>
        </form>
      </CardBody>
      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(o) => !o && setRemoving(undefined)}
        title={`Remove ${removing ?? 'email'}?`}
        description="The user can no longer sign in with this address."
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (removing) await removeEmail.mutateAsync(removing);
        }}
      />
    </Card>
  );
}

export function IdentitiesCard({ user }: { user: UserDetail }) {
  const idpUrl = useIdpUrl();
  return (
    <Card>
      <CardHeader
        title="Sign-in identities"
        actions={
          idpUrl ? (
            <a
              className="text-xs text-accent-fg underline"
              href={idpUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              Manage groups in Polaris ID
            </a>
          ) : null
        }
      />
      <CardBody className="p-0">
        <DataTable
          caption="Identities"
          bare
          stack={false}
          data={user.identities}
          getRowId={(i) => `${i.provider}:${i.subject}`}
          empty={<p className="p-4 text-sm text-fg-muted">No linked identities.</p>}
          columns={[
            {
              header: 'Provider',
              id: 'provider',
              cell: ({ row }) => amrLabel(row.original.provider),
            },
            {
              header: 'Email claim',
              id: 'claim',
              cell: ({ row }) => row.original.emailClaim ?? '—',
            },
            {
              header: 'Groups',
              id: 'groups',
              cell: ({ row }) => (
                <span className="flex flex-wrap gap-1">
                  {row.original.groups.map((g) => (
                    <Badge key={g}>{g}</Badge>
                  ))}
                </span>
              ),
            },
            {
              header: 'Last used',
              id: 'used',
              cell: ({ row }) => formatDateTime(row.original.lastUsedAt),
            },
          ]}
        />
      </CardBody>
    </Card>
  );
}

export function SessionsCard({ user, now }: { user: UserDetail; now: number }) {
  const { revokeSessions } = useUserMutations(user.id);
  const [confirm, setConfirm] = useState(false);
  const live = user.sessions.filter((s) => s.revokedAt === null && s.expiresAt > now);
  return (
    <Card>
      <CardHeader
        title="Sessions"
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={live.length === 0}
            onClick={() => setConfirm(true)}
          >
            Revoke all
          </Button>
        }
      />
      <CardBody className="p-0">
        <DataTable
          caption="Sessions"
          bare
          stack={false}
          data={user.sessions}
          getRowId={(s) => s.id}
          empty={<p className="p-4 text-sm text-fg-muted">No sessions.</p>}
          columns={[
            {
              header: 'State',
              id: 'state',
              cell: ({ row }) => {
                const s = row.original;
                const state =
                  s.revokedAt !== null ? 'Revoked' : s.expiresAt <= now ? 'Expired' : 'Active';
                return (
                  <StatusPill status={state} tone={state === 'Active' ? 'success' : 'neutral'}>
                    {state}
                  </StatusPill>
                );
              },
            },
            {
              header: 'Sign-in',
              id: 'amr',
              cell: ({ row }) => amrLabel(row.original.amr),
            },
            {
              header: 'Roles',
              id: 'roles',
              cell: ({ row }) => row.original.roles.map(roleLabel).join(', '),
            },
            {
              header: 'Last seen',
              id: 'seen',
              cell: ({ row }) => formatDateTime(row.original.lastSeenAt),
            },
            {
              header: 'Device',
              id: 'ua',
              cell: ({ row }) => (
                <span className="block max-w-56 truncate" title={row.original.userAgent ?? ''}>
                  {row.original.userAgent ?? '—'}
                </span>
              ),
            },
          ]}
        />
      </CardBody>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Revoke all sessions?"
        description="The user is signed out everywhere."
        confirmLabel="Revoke"
        destructive
        onConfirm={async () => {
          await revokeSessions.mutateAsync();
          toast.success('Sessions revoked');
        }}
      />
    </Card>
  );
}

export function PassesCard({ user }: { user: UserDetail }) {
  return (
    <Card>
      <CardHeader title={`Passes (${user.passCount})`} />
      {user.passes.length === 0 ? (
        <CardBody>
          <p className="text-sm text-fg-muted">No passes.</p>
        </CardBody>
      ) : (
        <ul className="divide-y divide-border">
          {user.passes.map(({ id, title, templateName, orgName, status }) => (
            <li
              key={id}
              className="flex flex-col items-start gap-1.5 px-4 py-2 md:flex-row md:items-center md:justify-between md:gap-3"
            >
              <div className="min-w-0 max-w-full">
                <Link
                  to="/admin/passes/$passId"
                  params={{ passId: id }}
                  className="block truncate text-sm font-medium text-accent-fg hover:underline"
                >
                  {title}
                </Link>
                <p className="truncate text-xs text-fg-muted">
                  {templateName} · {orgName}
                </p>
              </div>
              <StatusPill status={status} className="shrink-0" />
            </li>
          ))}
        </ul>
      )}
      {user.passCount > user.passes.length ? (
        <p className="border-t border-border px-4 py-3 text-xs text-fg-muted">
          Showing {user.passes.length} of {user.passCount}.
        </p>
      ) : null}
    </Card>
  );
}
