import { useMediaQuery } from '../../../lib/media.ts';
import { Buddy } from '../../../ui/art/buddy.tsx';
import type { ScanBuddyView } from '../../machine/present.ts';

/**
 * The buddy seated on the record's top edge, at the end. A scan's answer gives it this device's
 * beat; a person opened from a list gets a glance. Under reduced motion it rests, still.
 */
export function RecordBuddy({ view, id }: { view: ScanBuddyView | null; id: string }) {
  const still = useMediaQuery('(prefers-reduced-motion: reduce)');
  const mood = !view || view.mood === 'neutral' ? 'flat' : view.mood;
  return (
    <Buddy
      key={view?.key || id}
      className="op-buddy"
      scene="scan"
      size="lg"
      at="end"
      mood={mood}
      pose={view?.pose ?? 'rest'}
      beat={still ? undefined : (view?.beat ?? 'glance')}
      still={still}
      immediate
    />
  );
}
