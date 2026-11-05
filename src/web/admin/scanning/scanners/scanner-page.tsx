import { PageHeader } from '@/web/ui/index.ts';

/** The scanner page opens with AD.2. */
export function ScannerPage({ scannerId }: { scannerId: string }) {
  return (
    <PageHeader
      title="Scanner"
      breadcrumbs={[{ label: 'Scanning', to: '/admin/scanning' }, { label: scannerId }]}
    />
  );
}
