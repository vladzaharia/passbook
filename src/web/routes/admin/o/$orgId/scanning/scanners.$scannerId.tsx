import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { SkeletonDetail } from '../../../../../ui/index.ts';

const ScannerPage = lazy(() =>
  import('../../../../../admin/scanning/scanners/scanner-page.tsx').then((m) => ({
    default: m.ScannerPage,
  })),
);

function ScannerRoute() {
  return (
    <Suspense fallback={<SkeletonDetail label="Loading scanning" />}>
      <ScannerPage scannerId={Route.useParams().scannerId} />
    </Suspense>
  );
}

export const Route = createFileRoute('/admin/o/$orgId/scanning/scanners/$scannerId')({
  component: ScannerRoute,
});
