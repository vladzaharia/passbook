import { createFileRoute } from '@tanstack/react-router';
import { ScanningPage } from '../../../admin/scanning/scanning-page.tsx';
import { scanningSearchSchema } from '../../../admin/scanning/search.ts';

function ScanningRoute() {
  return <ScanningPage search={Route.useSearch()} />;
}

export const Route = createFileRoute('/admin/scanning/')({
  validateSearch: scanningSearchSchema,
  component: ScanningRoute,
});
