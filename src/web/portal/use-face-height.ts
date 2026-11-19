import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '../lib/motion.ts';

type Side = 'email' | 'code';

/**
 * Sizes the flipper to the active face. Each face is measured (ResizeObserver) while the far face
 * stays out of flow, so a tall code face never leaves empty space under the email face. `turning`
 * is true while a flip runs; only then does the height transition (never under reduced motion).
 */
export function useFaceHeight(face: Side) {
  const email = useRef<HTMLElement | null>(null);
  const code = useRef<HTMLElement | null>(null);
  const [heights, setHeights] = useState<Partial<Record<Side, number>>>({});
  const [turning, setTurning] = useState(false);
  const last = useRef(face);

  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const read = (side: Side, el: HTMLElement | null) => {
      if (el)
        setHeights((h) => (h[side] === el.offsetHeight ? h : { ...h, [side]: el.offsetHeight }));
    };
    const ro = new ResizeObserver(() => {
      read('email', email.current);
      read('code', code.current);
    });
    for (const el of [email.current, code.current]) if (el) ro.observe(el);
    read('email', email.current);
    read('code', code.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (last.current === face) return;
    last.current = face;
    if (prefersReducedMotion()) return;
    setTurning(true);
    const t = setTimeout(() => setTurning(false), 800);
    return () => clearTimeout(t);
  }, [face]);

  return { email, code, height: heights[face], turning };
}
