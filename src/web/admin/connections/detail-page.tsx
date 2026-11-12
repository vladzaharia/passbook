import { useQuery } from '@tanstack/react-query';
import { useOrgScope, useResourceOrg } from '../../lib/org-filter.tsx';
import {
  DetailNotFound,
  detailError,
  EmptyState,
  PageHeader,
  SkeletonDetail,
} from '../../ui/index.ts';
import { connectionDetailQuery } from './api.ts';
import { ConnectionDetail } from './detail-content.tsx';
import type { ConnectionDetailSearch } from './search.ts';

export function ConnectionDetailPage({
  connectionId,
  search,
}: {
  connectionId: string;
  search: ConnectionDetailSearch;
}) {
  const { hasExplicitOrg, requestedOrgId } = useOrgScope();
  return (
    <ConnectionDetailLoader
      key={JSON.stringify([connectionId, hasExplicitOrg, requestedOrgId])}
      connectionId={connectionId}
      search={search}
    />
  );
}

function ConnectionDetailLoader({
  connectionId,
  search,
}: {
  connectionId: string;
  search: ConnectionDetailSearch;
}) {
  const scope = useOrgScope();
  const canFetch = Boolean(
    !scope.isLoading &&
      !scope.isError &&
      scope.memberships.some((membership) => membership.capabilities.includes('integrations:read')),
  );
  const connection = useQuery({
    ...connectionDetailQuery(connectionId),
    staleTime: 0,
    refetchOnMount: 'always',
    enabled: canFetch,
  });
  const verified = connection.isFetchedAfterMount && !connection.isError;
  const resourceScope = useResourceOrg(verified ? connection.data?.orgId : undefined);
  const crumbs = [{ label: 'Connections', to: '/admin/connections' }, { label: 'Connection' }];

  if (
    (!scope.isLoading && !canFetch) ||
    resourceScope === 'not-found' ||
    (resourceScope === 'ready' &&
      connection.data?.orgId === scope.orgId &&
      !scope.membership?.capabilities.includes('integrations:read'))
  ) {
    return (
      <>
        <PageHeader title="Connection" breadcrumbs={crumbs} />
        <DetailNotFound entity="connection" to="/admin/connections" />
      </>
    );
  }

  if (!scope.isLoading && connection.isError && connection.isFetchedAfterMount) {
    return detailError(connection, {
      entity: 'connection',
      to: '/admin/connections',
      header: <PageHeader title="Connection" breadcrumbs={crumbs} />,
    });
  }
  if (resourceScope === 'choose-org') {
    return (
      <>
        <PageHeader title="Connection" breadcrumbs={crumbs} />
        <EmptyState
          art="building"
          title="Choose an organization"
          description="Choose an organization in the top bar to continue."
        />
      </>
    );
  }
  if (
    scope.isLoading ||
    resourceScope !== 'ready' ||
    !connection.data ||
    connection.data.orgId !== scope.orgId
  ) {
    return (
      <>
        <PageHeader title="Connection" breadcrumbs={crumbs} />
        <SkeletonDetail label="Loading connection" />
      </>
    );
  }
  const canManage = Boolean(scope.membership?.capabilities.includes('integrations:manage'));
  return (
    <ConnectionDetail
      key={JSON.stringify([scope.orgId, connectionId, canManage])}
      c={connection.data}
      connectionId={connectionId}
      canManage={canManage}
      search={search}
    />
  );
}
