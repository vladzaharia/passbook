import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/admin/o/$orgId/visitors/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/admin/o/$orgId/passes', params, replace: true });
  },
});
