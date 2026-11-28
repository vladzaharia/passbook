import { useEffect, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { prefersReducedMotion } from '../lib/motion.ts';
import { useOnline } from '../lib/online.ts';
import { Banner } from './banner.tsx';

/**
 * A Banner (offline tone) while the browser is offline. AppShell puts it under the top bar, in the same
 * sticky block, so it stays with the bar and pushes the page down instead of covering it.
 */
export function OfflineBanner({ className }: { className?: string | undefined }) {
  const online = useOnline();
  const [phase, setPhase] = useState<'hidden' | 'shown' | 'closing'>(online ? 'hidden' : 'shown');
  useEffect(() => {
    if (!online) setPhase('shown');
    else setPhase((p) => (p === 'shown' && !prefersReducedMotion() ? 'closing' : 'hidden'));
  }, [online]);
  if (phase === 'hidden') return null;
  return (
    <Banner
      tone="offline"
      role="status"
      data-closing={phase === 'closing' || undefined}
      onAnimationEnd={() => setPhase((p) => (p === 'closing' ? 'hidden' : p))}
      className={cn('wl-offline h-8 flex-nowrap', className)}
    >
      Offline
    </Banner>
  );
}
