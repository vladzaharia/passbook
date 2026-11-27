import { createFileRoute, redirect } from '@tanstack/react-router';

/** The old Add endpoint page: the Connections wizard's outbound path replaces it. */
export const Route = createFileRoute('/admin/o/$orgId/connections/webhooks/new')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/admin/o/$orgId/connections/new',
      params: { orgId: params.orgId },
      search: { source: 'outbound' },
      replace: true,
    });
  },
});
