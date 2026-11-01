import { Link } from '@tanstack/react-router';
import { UserCheck } from 'lucide-react';
import { useState } from 'react';
import { ACTION_ICON } from '@/web/lib/action-icons.ts';
import { ENTITY } from '@/web/lib/entities.ts';
import { isApiError } from '@/web/lib/errors.ts';
import { useSession } from '@/web/lib/session.ts';
import {
  Button,
  ConfirmDialog,
  EntityAvatar,
  ErrorState,
  PageHeader,
  SkeletonDetail,
  StatusPill,
  TwoPane,
  toast,
} from '@/web/ui/index.ts';
import { useUser, useUserMutations } from './queries.ts';
import { AccountCard, EmailsCard, IdentitiesCard, SessionsCard } from './user-sections.tsx';

export function UserDetailPage({ userId }: { userId: string }) {
  const query = useUser(userId);
  const session = useSession();
  const { setStatus } = useUserMutations(userId);
  const [confirm, setConfirm] = useState(false);
  const crumbs = [
    { label: 'Users', to: '/admin/users' },
    { label: query.data?.name ?? query.data?.primaryEmail ?? 'User' },
  ];

  if (query.isPending) {
    return (
      <>
        <PageHeader title="User" breadcrumbs={crumbs} />
        <SkeletonDetail label="Loading user" />
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
  const self = session.data?.authenticated === true && session.data.user.id === user.id;
  const name = user.name ?? user.primaryEmail;
  return (
    <>
      <PageHeader
        title={name}
        breadcrumbs={crumbs}
        avatar={<EntityAvatar kind="user" id={user.id} name={name} size={40} />}
        meta={
          <>
            <StatusPill status={disabled ? 'disabled' : 'active'} />
            {user.lastRoles.map((r) => (
              <StatusPill key={r} status={r} />
            ))}
            <Link
              to="/admin/audit"
              search={{ targetType: 'user', targetId: user.id }}
              className="inline-flex min-h-6 items-center gap-1.5 rounded-sm text-fg-muted hover:text-fg-strong hover:underline"
            >
              <ENTITY.audit.icon aria-hidden className="size-4" />
              Audit log
            </Link>
          </>
        }
        actions={
          disabled ? (
            <Button iconStart={<UserCheck aria-hidden />} onClick={() => setConfirm(true)}>
              Enable
            </Button>
          ) : self ? null : (
            <Button
              variant="outline"
              iconStart={<ACTION_ICON.void aria-hidden />}
              onClick={() => setConfirm(true)}
            >
              Disable
            </Button>
          )
        }
      />
      <TwoPane aside={<AccountCard user={user} />}>
        <EmailsCard user={user} />
        <SessionsCard user={user} now={Date.now()} />
        <IdentitiesCard user={user} />
      </TwoPane>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={disabled ? `Enable ${name}?` : `Disable ${name}?`}
        description={
          disabled ? 'They can sign in again.' : 'They are signed out at their next request.'
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
