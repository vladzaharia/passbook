import { useMemo } from 'react';
import type { PassJson } from '@/passkit/types.ts';
import { facesDiffer, normalize } from '@/shared/pass-view/index.ts';
import { SegmentedControl } from './segmented-control.tsx';

export type PassSide = 'front' | 'back';
export type PassTarget = '27' | 'legacy';

const SIDES = [
  { value: 'front', label: 'Front' },
  { value: 'back', label: 'Details' },
] as const;
const TARGETS = [
  { value: '27', label: 'iOS 27' },
  { value: 'legacy', label: 'iOS 26-', title: 'iOS 26 and earlier' },
] as const;

/** Front / Details: the face a PassCardStage shows. */
export function PassSideToggle({
  value,
  onChange,
}: {
  value: PassSide;
  onChange: (side: PassSide) => void;
}) {
  return <SegmentedControl label="Side" options={SIDES} value={value} onValueChange={onChange} />;
}

/** True when iOS 27 and iOS 26 and earlier draw different faces for this pass.json. */
export function usePassFacesDiffer(passJson: Record<string, unknown>): boolean {
  return useMemo(() => {
    try {
      return facesDiffer(normalize(passJson as unknown as PassJson, { assets: {} }));
    } catch {
      // A malformed pass.json has no second layout to compare; the preview shows its own error.
      return false;
    }
  }, [passJson]);
}

/** iOS 27 / iOS 26 and earlier. Render it only when the faces differ (usePassFacesDiffer). */
export function PassTargetToggle({
  value,
  onChange,
}: {
  value: PassTarget;
  onChange: (target: PassTarget) => void;
}) {
  return (
    <SegmentedControl
      label="iOS version"
      options={TARGETS}
      value={value}
      onValueChange={onChange}
    />
  );
}
