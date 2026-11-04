import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { ComposerPage } from '../../../admin/messages/composer-page.tsx';

function ComposeRoute() {
  const { kind } = Route.useSearch();
  return <ComposerPage kind={kind} />;
}

export const Route = createFileRoute('/admin/messages/new')({
  validateSearch: z.object({ kind: z.enum(['message', 'change']).optional().catch(undefined) }),
  component: ComposeRoute,
});
