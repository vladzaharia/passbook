import { createFileRoute } from '@tanstack/react-router';
import { MessageDetailPage } from '../../../admin/messages/detail-page.tsx';

function MessageRoute() {
  const { broadcastId } = Route.useParams();
  return <MessageDetailPage broadcastId={broadcastId} />;
}

export const Route = createFileRoute('/admin/messages/$broadcastId')({ component: MessageRoute });
