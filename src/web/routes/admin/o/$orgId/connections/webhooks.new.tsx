import { createFileRoute } from '@tanstack/react-router';
import { NewWebhookPage } from '../../../../../admin/connections/webhooks/new-page.tsx';

export const Route = createFileRoute('/admin/o/$orgId/connections/webhooks/new')({
  component: NewWebhookPage,
});
