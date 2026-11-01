import { type CSSProperties, useEffect, useState } from 'react';
import { prefersReducedMotion } from '../lib/motion.ts';

/**
 * Six foil sparks fly 14 px out from the parent's centre (640 ms, 40 ms apart), once per mount,
 * when `when` turns true: an org's first pass, a clean import, a first sync. Never on lists; one
 * per screen; nothing under reduced motion. The parent must be position: relative.
 */
export function Celebrate({ when }: { when: boolean }) {
  const [phase, setPhase] = useState<'idle' | 'on' | 'done'>('idle');
  useEffect(() => {
    if (!when || phase !== 'idle') return;
    if (prefersReducedMotion()) {
      setPhase('done');
      return;
    }
    setPhase('on');
    const t = setTimeout(() => setPhase('done'), 900);
    return () => clearTimeout(t);
  }, [when, phase]);
  if (phase !== 'on') return null;
  return (
    <span aria-hidden className="wl-sparks">
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
