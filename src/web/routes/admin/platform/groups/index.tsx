import { createFileRoute } from '@tanstack/react-router';
import { GroupsPage } from '../../../../admin/platform/groups/groups-page.tsx';

export const Route = createFileRoute('/admin/platform/groups/')({
  component: GroupsPage,
});
