import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { z } from 'zod';

// The wizard is its own chunk: it loads only when someone sets up scanning.
const SetupWizard = lazy(() =>
  import('../../../../../admin/scanning/setup/setup-wizard.tsx').then((m) => ({
    default: m.SetupWizard,
  })),
);

function SetupRoute() {
  const { preset, fromTemplate } = Route.useSearch();
  return (
    <Suspense fallback={<p role="status">Loading setup…</p>}>
      <SetupWizard preset={preset} fromTemplate={fromTemplate} />
    </Suspense>
  );
}

export const Route = createFileRoute('/admin/o/$orgId/scanning/setup')({
  validateSearch: z.object({
    // Inline, not the contract's schema: the route's search stays in the initial chunk.
    preset: z.enum(['front_desk', 'event_night', 'venue']).optional().catch(undefined),
    fromTemplate: z.string().min(1).max(64).optional().catch(undefined),
  }),
  component: SetupRoute,
});
