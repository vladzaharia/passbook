import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { z } from 'zod';
import { SCAN_SETUP_PRESET_IDS } from '@/shared/scan-setup-preset-ids.ts';
import { SkeletonDetail } from '../../../../../ui/index.ts';

// The wizard is its own chunk: it loads only when someone sets up scanning.
const SetupWizard = lazy(() =>
  import('../../../../../admin/scanning/setup/setup-wizard.tsx').then((m) => ({
    default: m.SetupWizard,
  })),
);

function SetupRoute() {
  const { preset, fromTemplate } = Route.useSearch();
  return (
    <Suspense fallback={<SkeletonDetail label="Loading setup" />}>
      <SetupWizard preset={preset} fromTemplate={fromTemplate} />
    </Suspense>
  );
}

export const Route = createFileRoute('/admin/o/$orgId/scanning/setup')({
  validateSearch: z.object({
    // The id list, not the contract's schema: the route's search stays in the initial chunk.
    preset: z.enum(SCAN_SETUP_PRESET_IDS).optional().catch(undefined),
    fromTemplate: z.string().min(1).max(64).optional().catch(undefined),
  }),
  component: SetupRoute,
});
