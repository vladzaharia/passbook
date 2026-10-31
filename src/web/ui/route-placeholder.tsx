import { Construction } from 'lucide-react';
import { EmptyState } from './empty-state.tsx';
import { type Crumb, PageHeader } from './page-header.tsx';

/** Stand-in for pages that are not built yet. Page owners replace the route component. */
export function RoutePlaceholder({
  title,
  breadcrumbs,
}: {
  title: string;
  breadcrumbs?: readonly Crumb[];
}) {
  return (
    <>
      <PageHeader title={title} breadcrumbs={breadcrumbs} />
      <EmptyState icon={Construction} title="Not built yet" />
    </>
  );
}
