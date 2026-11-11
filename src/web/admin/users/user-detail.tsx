import { Link } from '@tanstack/react-router';
import { UserCheck, UserRound } from 'lucide-react';
import { ACTION_ICON } from '@/web/lib/action-icons.ts';
import { ENTITY } from '@/web/lib/entities.ts';
import { useSession } from '@/web/lib/session.ts';
import {
  Badge,
  Button,
  Callout,
  detailError,
  EntityAvatar,
  MetaLink,
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
  const { authed } = useSession();
  const { setStatus } = useUserMutations(userId);
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
    return detailError(query, {
      entity: 'user',
      to: '/admin/users',
      header: <PageHeader title="User" breadcrumbs={crumbs} />,
    });
  }

  const user = query.data;
  const disabled = user.status === 'disabled';
  const self = authed?.user.id === user.id;
  const name = user.name ?? user.primaryEmail;
  // Disable is undone from its toast (it also ends their sessions); Enable just runs.
  const toggle = async () => {
    try {
      if (disabled) {
        await setStatus.mutateAsync('active');
        toast.success('User enabled');
      } else {
        await setStatus.mutateAsync('disabled');
        toast.undo('User disabled', () => setStatus.mutateAsync('active'));
      }
    } catch (cause) {
      toast.error(cause, disabled ? 'Could not enable' : 'Could not disable');
    }
  };
  return (
    <>
      <PageHeader
        title={name}
        breadcrumbs={crumbs}
        description={user.primaryEmail}
        avatar={<EntityAvatar kind="user" id={user.id} name={name} size={40} />}
        meta={
          <>
            <Badge>Platform-wide</Badge>
            <span>All modes</span>
            <StatusPill status={disabled ? 'disabled' : 'active'} />
            <MetaLink
              to="/admin/audit"
              search={{ targetType: 'user', targetId: user.id }}
              icon={ENTITY.audit.icon}
            >
              Audit log
            </MetaLink>
          </>
        }
        actions={
          // Your own account is not disabled from here (the server refuses it too).
          self ? null : disabled ? (
            <Button
              loading={setStatus.isPending}
              iconStart={<UserCheck aria-hidden />}
              onClick={() => void toggle()}
            >
              Enable
            </Button>
          ) : (
            <Button
              variant="outline"
              loading={setStatus.isPending}
              iconStart={<ACTION_ICON.void aria-hidden />}
              onClick={() => void toggle()}
            >
              Disable
            </Button>
          )
        }
      />
      <TwoPane aside={<AccountCard user={user} />}>
        {self ? (
          <Callout
            icon={UserRound}
            actions={
              <Button asChild variant="outline" size="sm">
                <Link to="/admin/account">Open Account</Link>
              </Button>
            }
          >
            This is you. Manage your own sign-in and sessions in Account.
          </Callout>
        ) : null}
        <EmailsCard user={user} self={self} />
        <SessionsCard user={user} self={self} now={Date.now()} />
        <IdentitiesCard user={user} />
      </TwoPane>
    </>
  );
}
