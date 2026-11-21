import { createFileRoute } from '@tanstack/react-router';
import { useMediaQuery } from '../../lib/media.ts';
import { MyPassesPage, STACK_WIDE } from '../../portal/my-passes-page.tsx';
import { PassDetailPage } from '../../portal/pass-detail-page.tsx';

// From 768 px the pass's page is My passes' master-detail with this pass in front.
export const Route = createFileRoute('/passes/$passId')({
  component: function PassRoute() {
    const { passId } = Route.useParams();
    const wide = useMediaQuery(STACK_WIDE);
    return wide ? <MyPassesPage selectedId={passId} /> : <PassDetailPage passId={passId} />;
  },
});
