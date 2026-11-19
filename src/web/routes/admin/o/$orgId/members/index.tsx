import { createFileRoute } from '@tanstack/react-router';
import { MembersPage } from '../../../../../admin/orgs/members-page.tsx';

export const Route = createFileRoute('/admin/o/$orgId/members/')({
  component: MembersPage,
});
