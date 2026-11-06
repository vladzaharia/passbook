import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

const ScannerPage = lazy(() =>
  import('../../../admin/scanning/scanners/scanner-page.tsx').then((m) => ({
    default: m.ScannerPage,
  })),
);

function ScannerRoute() {
  return (
    <Suspense fallback={<p role="status">Loading scanning…</p>}>
      <ScannerPage scannerId={Route.useParams().scannerId} />
    </Suspense>
  );
}

export const Route = createFileRoute('/admin/scanning/scanners/$scannerId')({
  component: ScannerRoute,
});
