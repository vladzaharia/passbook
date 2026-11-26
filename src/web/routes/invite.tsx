import { createFileRoute } from '@tanstack/react-router';
import { InvitePage } from '../invite/invite-page.tsx';

export const Route = createFileRoute('/invite')({
  component: InvitePage,
});
