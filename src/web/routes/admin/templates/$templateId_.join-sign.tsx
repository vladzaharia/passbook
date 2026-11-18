import { createFileRoute } from '@tanstack/react-router';
import { JoinSignPage } from '../../../admin/templates/join/join-sign.tsx';

function JoinSignRoute() {
  const { templateId } = Route.useParams();
  return <JoinSignPage templateId={templateId} />;
}

export const Route = createFileRoute('/admin/templates/$templateId_/join-sign')({
  component: JoinSignRoute,
});
