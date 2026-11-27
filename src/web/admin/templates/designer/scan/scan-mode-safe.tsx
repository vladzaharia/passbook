import { type ComponentProps, lazy, Suspense } from 'react';
import { DesignerSkeleton } from '../designer-skeleton.tsx';
import { ScanBoundary } from './scan-boundary.tsx';
import type { ScanMode as ScanModeType } from './scan-mode.tsx';

/** The scan screen is a mode most visits never open: it loads when its mode does. */
const ScanMode = lazy(() => import('./scan-mode.tsx').then((m) => ({ default: m.ScanMode })));

/** The scan screen with its failures, a failed load included, kept inside it. */
export function ScanModeSafe({
  onBack,
  ...props
}: ComponentProps<typeof ScanModeType> & { onBack: () => void }) {
  return (
    <ScanBoundary onBack={onBack}>
      <Suspense fallback={<DesignerSkeleton />}>
        <ScanMode {...props} />
      </Suspense>
    </ScanBoundary>
  );
}
