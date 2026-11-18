import { useOrgScope, useResourceOrg } from '../../../lib/org-filter.tsx';
import {
  DetailNotFound,
  detailError,
  EmptyState,
  PageHeader,
  SkeletonDetail,
} from '../../../ui/index.ts';
import { useWebhookEndpoint } from './api.ts';
import { EndpointDetail } from './detail-content.tsx';

const crumbs = [
  { label: 'Connections', to: '/admin/connections', search: { tab: 'webhooks' } },
  { label: 'Webhook' },
];
const TO = '/admin/connections';

/** Loads the endpoint, then checks it belongs to the selected org before showing anything. */
export function EndpointDetailPage({ endpointId }: { endpointId: string }) {
  const { hasExplicitOrg, requestedOrgId } = useOrgScope();
  return (
    <Loader
      key={JSON.stringify([endpointId, hasExplicitOrg, requestedOrgId])}
      endpointId={endpointId}
    />
  );
}

function Loader({ endpointId }: { endpointId: string }) {
  const scope = useOrgScope();
  const canFetch = Boolean(
    !scope.isLoading &&
      !scope.isError &&
      scope.memberships.some((m) => m.capabilities.includes('integrations:read')),
  );
  const endpoint = useWebhookEndpoint(endpointId, canFetch);
  const verified = endpoint.isFetchedAfterMount && !endpoint.isError;
  const resourceScope = useResourceOrg(verified ? endpoint.data?.orgId : undefined);
  const header = <PageHeader title="Webhook" breadcrumbs={crumbs} />;

  if (
    (!scope.isLoading && !canFetch) ||
    resourceScope === 'not-found' ||
    (resourceScope === 'ready' &&
      endpoint.data?.orgId === scope.orgId &&
      !scope.membership?.capabilities.includes('integrations:read'))
  )
    return (
      <>
        {header}
        <DetailNotFound entity="connection" to={TO} />
      </>
    );
  if (!scope.isLoading && endpoint.isError && endpoint.isFetchedAfterMount)
    return detailError(endpoint, { entity: 'connection', to: TO, header });
  if (resourceScope === 'choose-org')
    return (
      <>
        {header}
        <EmptyState
          art="building"
          title="Choose an organization"
          description="Choose an organization in the top bar to continue."
        />
      </>
    );
  if (
    scope.isLoading ||
    resourceScope !== 'ready' ||
    !endpoint.data ||
    endpoint.data.orgId !== scope.orgId
  )
    return (
      <>
        {header}
        <SkeletonDetail label="Loading webhook" />
      </>
    );
  const canManage = Boolean(scope.membership?.capabilities.includes('integrations:manage'));
  return (
    <EndpointDetail
      key={canManage ? 'manage' : 'read'}
      endpoint={endpoint.data}
      canManage={canManage}
    />
  );
}
