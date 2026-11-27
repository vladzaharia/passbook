import { createFileRoute, redirect } from '@tanstack/react-router';
import { allPath } from '../../../lib/scope.ts';

export const Route = createFileRoute('/admin/all/')({
  beforeLoad: () => {
    throw redirect({ to: allPath('/passes'), replace: true });
  },
});
