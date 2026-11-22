import { type CSSProperties, useEffect, useState } from 'react';
import { prefersReducedMotion } from '../lib/motion.ts';

/**
 * Six foil sparks fly 14 px out from the parent's centre (640 ms, 40 ms apart), once per mount,
 * when `when` turns true: an org's first pass, a clean import, a first sync. Never on lists; one
 * per screen; nothing under reduced motion. The parent must be position: relative. `radius` starts
 * them that far from the centre (a circle's own radius), `delay` waits that many ms first.
 */
export function Celebrate({
  when,
  radius = 0,
  delay = 0,
  size = 'sm',
}: {
  when: boolean;
  radius?: number;
  delay?: number;
  /** lg: 3 × 10 px marks that travel 22 px, for a larger target such as a 56 px circle. */
  size?: 'sm' | 'lg';
}) {
  const [phase, setPhase] = useState<'idle' | 'on' | 'done'>('idle');
  useEffect(() => {
    if (!when || phase !== 'idle') return;
    if (prefersReducedMotion()) {
      setPhase('done');
      return;
    }
    setPhase('on');
  }, [when, phase]);
  // Its own effect: the timer must outlive the phase change that starts it.
  useEffect(() => {
    if (phase !== 'on') return;
    const t = setTimeout(() => setPhase('done'), 900 + delay);
    return () => clearTimeout(t);
  }, [phase, delay]);
  if (phase !== 'on') return null;
  return (
    <span
      aria-hidden
      className="wl-sparks"
      data-size={size}
      style={{ '--wl-spark-r': `${radius}px`, '--wl-spark-delay': `${delay}ms` } as CSSProperties}
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
