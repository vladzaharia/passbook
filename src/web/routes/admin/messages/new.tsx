import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { ComposerPage } from '../../../admin/messages/composer-page.tsx';

function ComposeRoute() {
  const { kind, from } = Route.useSearch();
  return <ComposerPage kind={kind} from={from} />;
}

export const Route = createFileRoute('/admin/messages/new')({
  validateSearch: z.object({
    kind: z.enum(['message', 'change']).optional().catch(undefined),
    /** A saved draft to edit. */
    from: z.string().optional().catch(undefined),
  }),
  component: ComposeRoute,
});
