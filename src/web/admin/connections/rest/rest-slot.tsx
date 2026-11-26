import { lazy, Suspense } from 'react';
import { SkeletonRows } from '../../../ui/index.ts';
import type { RestConfigProps } from './rest-config.tsx';

const RestConfig = lazy(() => import('./rest-config.tsx'));

/** The explorer loads on its own: the admin's first load does not carry the tree. */
export function RestSlot(props: RestConfigProps) {
  return (
    <Suspense fallback={<SkeletonRows rows={3} label="Loading explorer" />}>
      <RestConfig {...props} />
    </Suspense>
  );
}
