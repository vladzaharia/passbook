import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import { isApiError } from '@/web/lib/errors.ts';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  ErrorState,
  KeyValue,
  PageHeader,
  SkeletonRows,
  StatusPill,
} from '@/web/ui/index.ts';
import { formatDateTime } from '../overview/format.ts';
import { useIdpUrl } from '../settings/queries.ts';
import { useUser, useUserMutations } from './queries.ts';
import { EmailsCard, IdentitiesCard, PassesCard, SessionsCard } from './user-sections.tsx';

export function UserDetailPage({ userId }: { userId: string }) {
  const query = useUser(userId);
  const { setStatus } = useUserMutations(userId);
  const [confirm, setConfirm] = useState(false);
  const idpUrl = useIdpUrl();
  const crumbs = [
    { label: 'Users', to: '/admin/users' },
    { label: query.data?.name ?? query.data?.primaryEmail ?? 'User' },
  ];

  if (query.isPending) {
    return (
      <>
        <PageHeader title="User" breadcrumbs={crumbs} />
        <SkeletonRows label="Loading user" />
      </>
    );
  }
  if (query.isError) {
    return (
      <>
        <PageHeader title="User" breadcrumbs={crumbs} />
        <ErrorState
          error={query.error}
          title={isApiError(query.error) && query.error.isNotFound ? 'User not found' : undefined}
          onRetry={() => query.refetch()}
        />
      </>
    );
  }

  const user = query.data;
  const disabled = user.status === 'disabled';
  return (
    <>
      <PageHeader
        width="detail"
        title={user.name ?? user.primaryEmail}
        breadcrumbs={crumbs}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/admin/audit" search={{ targetType: 'user', targetId: user.id }}>
                Audit log
              </Link>
            </Button>
            <Button variant={disabled ? 'primary' : 'danger'} onClick={() => setConfirm(true)}>
              {disabled ? 'Enable' : 'Disable'}
            </Button>
          </>
        }
      />
      <div className="flex max-w-3xl flex-col gap-6">
        <Card>
          <CardHeader
            title="Account"
            actions={
              <StatusPill status={user.status} tone={disabled ? 'neutral' : 'success'}>
                {disabled ? 'Disabled' : 'Active'}
              </StatusPill>
            }
          />
          <CardBody>
            <KeyValue
              items={[
                { label: 'Email', value: user.primaryEmail },
                { label: 'ID', value: user.id, mono: true },
                {
                  label: 'Roles',
                  value: (
                    <span className="flex flex-wrap items-center gap-1">
                      {user.lastRoles.map((r) => (
                        <Badge key={r}>{r}</Badge>
                      ))}
                      {idpUrl ? (
                        <a
                          className="ml-2 text-xs text-accent-fg underline"
                          href={idpUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          Managed in Polaris ID
                        </a>
                      ) : null}
                    </span>
                  ),
                },
                { label: 'Created', value: formatDateTime(user.createdAt) },
                { label: 'Last sign-in', value: formatDateTime(user.lastLoginAt) },
              ]}
            />
          </CardBody>
        </Card>
        <EmailsCard user={user} />
        <IdentitiesCard user={user} />
        <SessionsCard user={user} now={Date.now()} />
        <PassesCard user={user} />
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={disabled ? 'Enable this user?' : 'Disable this user?'}
        description={
          disabled
            ? 'The user can sign in again.'
            : 'The user is refused at their next request. Sessions stay listed until they expire.'
        }
        confirmLabel={disabled ? 'Enable' : 'Disable'}
        destructive={!disabled}
        onConfirm={async () => {
          await setStatus.mutateAsync(disabled ? 'active' : 'disabled');
          toast.success(disabled ? 'User enabled' : 'User disabled');
        }}
      />
    </>
  );
}
