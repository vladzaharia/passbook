import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { prefersReducedMotion } from '../../lib/motion.ts';
import './scenes/rest.css';

/** Entrances end by 680 ms (80 ms start, 600 ms ceiling); a scene follows. */
const LANDED_MS = 700;

/** Restarts the scene under [data-run]: off, a style flush, on; no frame paints between. */
export function runScene(el: Element | null): void {
  if (!el || prefersReducedMotion()) return;
  el.removeAttribute('data-run');
  el.getBoundingClientRect();
  el.setAttribute('data-run', '');
}

/**
 * A scene on `ref` (data-replay, data-scene; scenes/*.css). With `auto` it runs once, 60% in view
 * and landed. A click on a painted part replays it and stops there (no parent link or card action
 * sees it); so does a change of `again`. Reduced motion: never runs, a click does nothing.
 * `immediate`: layout effect, on mount if `auto` and on every `again`; no observer, wait or click.
 */
export function useScene<T extends Element>(
  auto: boolean,
  again?: unknown,
  { immediate = false }: { immediate?: boolean } = {},
) {
  const ref = useRef<T>(null);
  const replay = useCallback(() => runScene(ref.current), []);
  const seen = useRef(again);
  useEffect(() => {
    if (immediate || Object.is(seen.current, again)) return;
    seen.current = again;
    replay();
  }, [again, replay, immediate]);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    if (!immediate) return;
    const first = !mounted.current;
    mounted.current = true;
    if (first ? auto : !Object.is(seen.current, again)) replay();
    seen.current = again;
  }, [immediate, auto, again, replay]);
  useEffect(() => {
    const el = ref.current;
    if (!el || immediate) return;
    const click = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
      runScene(el);
    };
    el.addEventListener('click', click);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let io: IntersectionObserver | undefined;
    if (auto && !prefersReducedMotion() && typeof IntersectionObserver === 'function') {
      const born = performance.now();
      io = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          io?.disconnect();
          const wait = LANDED_MS - (performance.now() - born);
          timer = setTimeout(() => runScene(el), Math.max(0, wait));
        },
        { threshold: 0.6 },
      );
      io.observe(el);
    }
    return () => {
      el.removeEventListener('click', click);
      io?.disconnect();
      clearTimeout(timer);
    };
  }, [auto, immediate]);
  return { ref, replay };
}
