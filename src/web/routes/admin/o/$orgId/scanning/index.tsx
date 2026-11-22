import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { SkeletonDetail } from '../../../../../ui/index.ts';

const ScanningPage = lazy(() =>
  import('../../../../../admin/scanning/scanning-page.tsx').then((m) => ({
    default: m.ScanningPage,
  })),
);

import { scanningSearchSchema } from '../../../../../admin/scanning/search.ts';

function ScanningRoute() {
  return (
    <Suspense fallback={<SkeletonDetail label="Loading scanning" />}>
      <ScanningPage search={Route.useSearch()} />
    </Suspense>
  );
}

export const Route = createFileRoute('/admin/o/$orgId/scanning/')({
  validateSearch: scanningSearchSchema,
  component: ScanningRoute,
});
