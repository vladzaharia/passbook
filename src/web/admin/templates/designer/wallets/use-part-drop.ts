import { useEffect, useRef } from 'react';
import { prefersReducedMotion } from '../../../../lib/motion.ts';

/**
 * A part that first shows up on the wallet card (a `data-wk` key) drops in: −14 px, scale 1.08 to
 * none, 320 ms spring; with reduced motion it fades. The first render only seeds the known keys,
 * and a new wallet or type re-seeds them (that change plays the deal instead).
 */
export function usePartDrop(signature: string, scope: string) {
  const host = useRef<HTMLDivElement>(null);
  const known = useRef<{ scope: string; keys: Set<string> } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the signature is the trigger
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const keys = new Set(
      [...el.querySelectorAll<HTMLElement>('[data-wk]')].map((n) => n.dataset.wk as string),
    );
    const before = known.current;
    known.current = { scope, keys };
    if (!before || before.scope !== scope) return;
    for (const key of keys) {
      if (before.keys.has(key)) continue;
      const part = el.querySelector<HTMLElement>(`[data-wk="${CSS.escape(key)}"]`);
      if (!part?.animate) continue;
      const calm = prefersReducedMotion();
      part.animate(
        calm
          ? [{ opacity: 0 }, { opacity: 1 }]
          : [
              { opacity: 0, transform: 'translateY(-14px) scale(1.08)' },
              { opacity: 1, transform: 'none' },
            ],
        {
          duration: calm ? 160 : 320,
          easing: calm ? 'linear' : 'cubic-bezier(0.34, 1.4, 0.64, 1)',
        },
      );
    }
  }, [signature, scope]);
  return host;
}
