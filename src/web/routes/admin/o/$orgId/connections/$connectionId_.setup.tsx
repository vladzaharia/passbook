import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { ConnectionDetailPage } from '../../../../../admin/connections/detail-page.tsx';
import { LiveOnly } from '../../../../../admin/connections/live-only.tsx';

function ConnectionSetupRoute() {
  const { connectionId } = Route.useParams();
  const { step } = Route.useSearch();
  return (
    <LiveOnly>
      <ConnectionDetailPage connectionId={connectionId} search={{}} setup setupStep={step} />
    </LiveOnly>
  );
}

export const Route = createFileRoute('/admin/o/$orgId/connections/$connectionId_/setup')({
  validateSearch: z.object({ step: z.enum(['secret']).optional().catch(undefined) }),
  component: ConnectionSetupRoute,
});
