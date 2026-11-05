import { createFileRoute } from '@tanstack/react-router';
import { ScannerPage } from '../../../admin/scanning/scanners/scanner-page.tsx';

function ScannerRoute() {
  return <ScannerPage scannerId={Route.useParams().scannerId} />;
}

export const Route = createFileRoute('/admin/scanning/scanners/$scannerId')({
  component: ScannerRoute,
});
