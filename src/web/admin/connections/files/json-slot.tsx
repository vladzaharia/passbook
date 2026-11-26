import { lazy, Suspense } from 'react';
import { SkeletonRows } from '../../../ui/index.ts';

const JsonRecords = lazy(() => import('./json-records.tsx'));

type Props = Parameters<typeof JsonRecords>[0];

/** Loads with the explorer's tree, not with the admin's first load. */
export function JsonSlot(props: Props) {
  return (
    <Suspense fallback={<SkeletonRows rows={3} label="Loading tree" />}>
      <JsonRecords {...props} />
    </Suspense>
  );
}
