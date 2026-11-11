import { Link } from '@tanstack/react-router';
import { FlaskConical, Package, Plus } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { ENTITY } from '../../lib/entities.ts';
import { formatRelative } from '../../lib/format.ts';
import { setMode, useMode } from '../../lib/mode.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { useMemberships, useSession } from '../../lib/session.ts';
import {
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorState,
  ListRow,
  ListRows,
  LoadMore,
  PageHeader,
  RowLink,
  SkeletonRows,
} from '../../ui/index.ts';
import { useSettings } from '../settings/queries.ts';
import { EmailPreview } from './preview.tsx';
import { useCapturedEmails } from './queries.ts';
import type { InboxSearch } from './search.ts';

function PlatformRetention() {
  const kept = useSettings('platform').data?.items.find(
    (item) => item.key === 'sandbox.purgeDays',
  )?.value;
  return typeof kept === 'number' ? (
    <> Normally kept {kept} days; unresolved sends may be retained longer.</>
  ) : null;
}

/** Mail captured in Test mode instead of being delivered to its intended recipient. */
export function InboxPage({
  search,
  onSearch,
}: {
  search: InboxSearch;
  onSearch: (next: InboxSearch) => void;
}) {
  const mode = useMode();
  const scope = useOrgScope();
  const { orgId } = scope;
  const session = useSession();
  const memberships = useMemberships();
  const userId = session.authed?.user.id;
  const canRead = Boolean(
    !session.isError &&
      !session.isFetching &&
      userId &&
      !scope.isLoading &&
      !scope.isError &&
      !memberships.isFetching &&
      orgId &&
      scope.membership &&
      scope.membership.userId === userId &&
      scope.membership.capabilities.includes('passes:read'),
  );
  const canOperate = Boolean(canRead && scope.membership?.capabilities.includes('passes:operate'));
  const authority = useMemo(
    () => ({ orgId, mode, userId, canOperate, active: true, requests: new Set<AbortController>() }),
    [orgId, mode, userId, canOperate],
  );
  useEffect(() => {
    authority.active = true;
    return () => {
      authority.active = false;
      for (const request of authority.requests) request.abort();
      authority.requests.clear();
    };
  }, [authority]);
  const orgName = (id: string) =>
    scope.membership && id === scope.membership.orgId ? scope.membership.orgName : id;
  const list = useCapturedEmails(orgId);
  const rows = canRead && mode === 'test' ? (list.data?.pages.flatMap((p) => p.items) ?? []) : [];
  const now = Date.now();

  return (
    <>
      <PageHeader
        title="Test inbox"
        description={
          <>
            Test emails are captured here instead of being sent to their intended recipients.
            {canOperate ? ' You can send a copy to your verified account email.' : ''}
            {session.isAdmin && !session.isError && !session.isFetching ? (
              <PlatformRetention />
            ) : null}
          </>
        }
      />
      {mode !== 'test' ? (
        <EmptyState
          art="envelope"
          title="Test mode is off"
          description="Turn it on to see mail from test passes."
          action={
            <Button
              variant="outline"
              iconStart={<FlaskConical aria-hidden />}
              onClick={() => setMode('test')}
            >
              Turn on Test mode
            </Button>
          }
        />
      ) : !orgId ? (
        <EmptyState
          art="envelope"
          title="Choose an organization"
          description="Select an organization to view its test emails."
        />
      ) : !canRead ? (
        <SkeletonRows label="Loading test inbox" />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : list.isPending ? (
        <SkeletonRows label="Loading test inbox" />
      ) : rows.length === 0 ? (
        <EmptyState
          art="envelope"
          title="No test emails yet"
          action={
            canOperate ? (
              <Button asChild iconStart={<Plus aria-hidden />}>
                <Link to="/admin/passes/new" search={{ orgId }}>
                  New pass
                </Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <Card>
            <CardBody>
              <ListRows label="Test emails">
                {rows.map((m) => (
                  <ListRow
                    key={m.id}
                    rowId={m.id}
                    leading={
                      m.kind === 'bundle' ? (
                        <Package aria-hidden />
                      ) : (
                        <ENTITY.pass.icon aria-hidden />
                      )
                    }
                    title={
                      <RowLink
                        to="/admin/test-inbox"
                        search={{ email: m.id, orgId }}
                        aria-label={`Open ${m.subject}`}
                      >
                        {m.subject}
                      </RowLink>
                    }
                    meta={`To ${m.to} · ${orgName(m.orgId)} · ${formatRelative(m.createdAt, now)}`}
                  />
                ))}
              </ListRows>
            </CardBody>
          </Card>
          <LoadMore query={list} shown={rows.length} noun={['email', 'emails']} scoped />
        </>
      )}
      {search.email && orgId && userId && canRead ? (
        <EmailPreview
          key={search.email}
          id={search.email}
          orgId={orgId}
          userId={userId}
          mode={mode}
          canOperate={canOperate}
          sendScope={authority}
          orgName={(id) => orgName(id)}
          onClose={() => onSearch({})}
        />
      ) : null}
    </>
  );
}
