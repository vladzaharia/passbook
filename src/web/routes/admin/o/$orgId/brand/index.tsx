import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { useOrgScope } from '../../../../../lib/org-filter.tsx';
import { SkeletonDetail } from '../../../../../ui/index.ts';

const BrandPage = lazy(() =>
  import('../../../../../admin/brand/brand-page.tsx').then((m) => ({ default: m.BrandPage })),
);

function BrandRoute() {
  const { orgId } = Route.useParams();
  const { membership } = useOrgScope();
  if (!membership) return <SkeletonDetail label="Loading brand and channels" />;
  return (
    <Suspense fallback={<SkeletonDetail label="Loading brand and channels" />}>
      <BrandPage orgId={orgId} membership={membership} />
    </Suspense>
  );
}

export const Route = createFileRoute('/admin/o/$orgId/brand/')({ component: BrandRoute });
