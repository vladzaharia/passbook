import { WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { prefersReducedMotion } from '../lib/motion.ts';
import { useOnline } from '../lib/online.ts';

/** A slim warning bar under the top bar while the browser is offline. The page stays put. */
export function OfflineBanner({ className }: { className?: string }) {
  const online = useOnline();
  const [phase, setPhase] = useState<'hidden' | 'shown' | 'closing'>(online ? 'hidden' : 'shown');
  useEffect(() => {
    if (!online) setPhase('shown');
    else setPhase((p) => (p === 'shown' && !prefersReducedMotion() ? 'closing' : 'hidden'));
  }, [online]);
  if (phase === 'hidden') return null;
  return (
    <div
      role="status"
      data-closing={phase === 'closing' || undefined}
      onAnimationEnd={() => setPhase((p) => (p === 'closing' ? 'hidden' : p))}
      className={cn(
        'wl-offline fixed inset-x-0 top-[calc(3.5rem+env(safe-area-inset-top))] z-10 flex h-8 items-center justify-center gap-2 border-b border-warning-border bg-warning-subtle px-safe text-xs font-medium text-warning',
        className,
      )}
    >
      <WifiOff aria-hidden className="size-3.5" />
      Offline
    </div>
  );
}
