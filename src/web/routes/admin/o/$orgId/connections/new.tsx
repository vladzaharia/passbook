import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { CreateConnectionWizard } from '../../../../../admin/connections/create-wizard.tsx';
import { LiveOnly } from '../../../../../admin/connections/live-only.tsx';
import { OutboundPage } from '../../../../../admin/connections/webhooks/outbound-page.tsx';

function NewConnectionRoute() {
  const { source, return: returnTo } = Route.useSearch();
  const navigate = useNavigate();
  // Sending out is not a stored connection, so it runs in Test as well as Live.
  if (source === 'outbound')
    return (
      <OutboundPage
        returnTo={returnTo}
        onBackToPicker={() => void navigate({ to: '/admin/connections/new', replace: true })}
      />
    );
  return (
    <LiveOnly>
      <CreateConnectionWizard source={source} />
    </LiveOnly>
  );
}

export const Route = createFileRoute('/admin/o/$orgId/connections/new')({
  validateSearch: z.object({
    source: z.string().max(60).optional().catch(undefined),
    return: z.string().max(300).optional().catch(undefined),
  }),
  component: NewConnectionRoute,
});
