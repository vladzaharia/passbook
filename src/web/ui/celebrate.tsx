import { type CSSProperties, useEffect, useState } from 'react';
import { prefersReducedMotion } from '../lib/motion.ts';

/**
 * Six foil sparks fly 14 px out from the parent's centre (640 ms, 40 ms apart), once per mount,
 * when `when` turns true: an org's first pass, a clean import, a first sync. Never on lists; one
 * per screen; nothing under reduced motion. The parent must be position: relative. `radius` starts
 * them that far from the centre (a circle's own radius), `delay` waits that many ms before they appear.
 */
export function Celebrate({
  when,
  radius = 0,
  delay = 0,
  size = 'sm',
  at = 'center',
}: {
  when: boolean;
  radius?: number;
  delay?: number;
  /** lg: 3 × 10 px marks that travel 22 px, for a larger target such as a 56 px circle. */
  size?: 'sm' | 'lg';
  /** buddy: from the top of a seated buddy centred on the parent's top edge, where it throws its pass. */
  at?: 'center' | 'buddy';
}) {
  const [phase, setPhase] = useState<'idle' | 'wait' | 'on' | 'done'>('idle');
  useEffect(() => {
    if (!when || phase !== 'idle') return;
    setPhase(prefersReducedMotion() ? 'done' : delay > 0 ? 'wait' : 'on');
  }, [when, phase, delay]);
  // Mounted only when the first spark should fly: a delayed animation would show them at rest first.
  // Its own effects: the timers must outlive the phase change that starts them.
  useEffect(() => {
    if (phase !== 'wait') return;
    const t = setTimeout(() => setPhase('on'), delay);
    return () => clearTimeout(t);
  }, [phase, delay]);
  useEffect(() => {
    if (phase !== 'on') return;
    const t = setTimeout(() => setPhase('done'), 900);
    return () => clearTimeout(t);
  }, [phase]);
  if (phase !== 'on') return null;
  return (
    <span
      aria-hidden
      className="wl-sparks"
      data-size={size}
      data-at={at === 'buddy' ? 'buddy' : undefined}
      style={{ '--wl-spark-r': `${radius}px` } as CSSProperties}
    >
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className="wl-spark"
          style={{ '--i': i, '--a': `${i * 60 + 30}deg` } as CSSProperties}
        />
      ))}
    </span>
  );
}
