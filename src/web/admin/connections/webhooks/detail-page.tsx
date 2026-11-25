import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { backTo, notFoundTitle } from '@/shared/copy/states.ts';
import { OrgChooser } from '@/web/ui/layout/org-chooser.tsx';
import { isApiError } from '../../../lib/errors.ts';
import { useOrgScope, useResourceOrg } from '../../../lib/org-filter.tsx';
import { Button, detailError, EmptyState, PageHeader, SkeletonDetail } from '../../../ui/index.ts';
import { useWebhookEndpoint } from './api.ts';
import { EndpointDetail } from './detail-content.tsx';

const crumbs = [
  { label: 'Connections', to: '/admin/connections', search: { tab: 'webhooks' } },
  { label: 'Webhook' },
];
const TO = '/admin/connections';

/** "Webhook not found" with the way back to the Webhooks tab. */
function NotFound() {
  return (
    <EmptyState
      art="torn"
      mood="sad"
      title={notFoundTitle('Webhook')}
      action={
        <Button asChild variant="outline">
          <Link to={TO} search={{ tab: 'webhooks' }}>
            <ArrowLeft aria-hidden />
            {backTo('webhooks')}
          </Link>
        </Button>
      }
    />
  );
}

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
        <NotFound />
      </>
    );
  if (!scope.isLoading && endpoint.isError && endpoint.isFetchedAfterMount)
    return isApiError(endpoint.error) && endpoint.error.isNotFound ? (
      <>
        {header}
        <NotFound />
      </>
    ) : (
      detailError(endpoint, { entity: 'connection', to: TO, header })
    );
  if (resourceScope === 'choose-org') return <OrgChooser />;
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
