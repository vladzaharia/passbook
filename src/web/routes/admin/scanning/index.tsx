import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

const ScanningPage = lazy(() =>
  import('../../../admin/scanning/scanning-page.tsx').then((m) => ({ default: m.ScanningPage })),
);

import { scanningSearchSchema } from '../../../admin/scanning/search.ts';

function ScanningRoute() {
  return (
    <Suspense fallback={<p role="status">Loading scanning…</p>}>
      <ScanningPage search={Route.useSearch()} />
    </Suspense>
  );
}

export const Route = createFileRoute('/admin/scanning/')({
  validateSearch: scanningSearchSchema,
  component: ScanningRoute,
});
