import { createFileRoute } from '@tanstack/react-router';
import { broadcastQuery } from '../../../admin/messages/api.ts';
import { MessageDetailPage } from '../../../admin/messages/detail-page.tsx';

function MessageRoute() {
  const { broadcastId } = Route.useParams();
  return <MessageDetailPage broadcastId={broadcastId} />;
}

export const Route = createFileRoute('/admin/messages/$broadcastId')({
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(broadcastQuery(params.broadcastId));
  },
  component: MessageRoute,
});
