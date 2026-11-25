import type { ComponentProps } from 'react';
import { ScanBoundary } from './scan-boundary.tsx';
import { ScanMode } from './scan-mode.tsx';

/** The scan screen with its failures kept inside it. */
export function ScanModeSafe({
  onBack,
  ...props
}: ComponentProps<typeof ScanMode> & { onBack: () => void }) {
  return (
    <ScanBoundary onBack={onBack}>
      <ScanMode {...props} />
    </ScanBoundary>
  );
}
