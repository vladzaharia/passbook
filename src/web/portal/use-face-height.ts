import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '../lib/motion.ts';

type Side = 'email' | 'code';

/** The flip's duration (--wl-dur-flip) plus its 120 ms wait; matches login-card.css. */
function flipMs(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--wl-dur-flip');
  const ms = Number.parseFloat(raw);
  return (Number.isFinite(ms) ? ms : 640) + 120;
}

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
  const [last, setLast] = useState(face);

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

  // Set while rendering, so the flag lands in the same commit as the new height.
  if (last !== face) {
    setLast(face);
    if (!prefersReducedMotion()) setTurning(true);
  }

  useEffect(() => {
    if (!turning) return;
    const t = setTimeout(() => setTurning(false), flipMs() + 80);
    return () => clearTimeout(t);
  }, [turning]);

  return { email, code, height: heights[face], turning };
}
