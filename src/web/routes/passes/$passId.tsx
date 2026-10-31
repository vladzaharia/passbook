import { createFileRoute } from '@tanstack/react-router';
import { PassDetailPage } from '../../portal/pass-detail-page.tsx';

export const Route = createFileRoute('/passes/$passId')({
  component: function PassRoute() {
    const { passId } = Route.useParams();
    return <PassDetailPage passId={passId} />;
  },
});
