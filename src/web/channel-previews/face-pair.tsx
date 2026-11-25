import { lazy, type ReactNode, Suspense, useState } from 'react';
import { cn } from '../lib/cn.ts';
import './face-pair.css';

/** Only a narrow container shows the toggle, so the control (and its tooltip) loads after the faces. */
const SegmentedControl = lazy(() =>
  import('../ui/segmented-control.tsx').then((m) => ({ default: m.SegmentedControl })),
);

export type PreviewFace = 'front' | 'back';

const SIDES = [
  { value: 'front', label: 'Front' },
  { value: 'back', label: 'Back' },
] as const;

/**
 * A card's two faces: side by side when the container has room for both (face-pair.css, a
 * container query, so a narrow pane decides the same as a phone), else one face with a
 * Front / Back toggle. Both faces are always in the markup; the stylesheet shows one or both.
 * Controlled with `face` and `onFace`, or self-managed when omitted.
 */
export function FacePair({
  front,
  back,
  face,
  onFace,
  className,
}: {
  front: ReactNode;
  back: ReactNode;
  face?: PreviewFace | undefined;
  onFace?: ((face: PreviewFace) => void) | undefined;
  className?: string | undefined;
}) {
  const [own, setOwn] = useState<PreviewFace>('front');
  const shown = face ?? own;
  const pick = (next: PreviewFace) => {
    setOwn(next);
    onFace?.(next);
  };
  return (
    <div className={cn('fp', className)} data-face={shown}>
      <div className="fp-faces">
        <div className="fp-face" data-side="front">
          {front}
        </div>
        <div className="fp-face" data-side="back">
          {back}
        </div>
      </div>
      <Suspense fallback={null}>
        <SegmentedControl
          label="Side"
          options={SIDES}
          value={shown}
          onValueChange={(v) => pick(v as PreviewFace)}
          className="fp-toggle"
        />
      </Suspense>
    </div>
  );
}
