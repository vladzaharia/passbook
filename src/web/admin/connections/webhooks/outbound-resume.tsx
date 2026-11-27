import { OrgChooser } from '@/web/ui/layout/org-chooser.tsx';
import { isApiError } from '../../../lib/errors.ts';
import { useOrgScope } from '../../../lib/org-filter.tsx';
import { detailError, PageHeader, SkeletonDetail } from '../../../ui/index.ts';
import { useWebhookEndpoint } from './api.ts';
import { OutboundFlow } from './outbound-flow.tsx';

const TO = '/admin/connections';

/** `/connections/webhooks/$id/setup`: your server's side of an endpoint that exists, read from the server. */
export function OutboundResume({ endpointId }: { endpointId: string }) {
  const scope = useOrgScope();
  const canRead = Boolean(scope.membership?.capabilities.includes('integrations:read'));
  const endpoint = useWebhookEndpoint(endpointId, canRead);
  const header = (
    <PageHeader
      title="Set up your server"
      breadcrumbs={[
        { label: 'Connections', to: TO, search: { tab: 'webhooks' } },
        { label: 'Setup' },
      ]}
    />
  );
  if (!scope.orgId) return <OrgChooser />;
  if (endpoint.isError) return detailError(endpoint, { entity: 'connection', to: TO, header });
  if (!endpoint.data || endpoint.data.orgId !== scope.orgId || isApiError(endpoint.error))
    return (
      <>
        {header}
        <SkeletonDetail label="Loading setup" />
      </>
    );
  const manage = Boolean(scope.membership?.capabilities.includes('integrations:manage'));
  return <OutboundFlow orgId={scope.orgId} canManage={manage} resume={endpoint.data} />;
}
