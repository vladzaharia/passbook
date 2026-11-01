import { Loader2 } from 'lucide-react';
import { cn } from '../lib/cn.ts';

/** Only inside buttons and polling rows (spinner-lint.test.ts). Spins under reduced motion too. */
export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <span role={label ? 'status' : undefined} className="inline-flex">
      <Loader2 aria-hidden className={cn('wl-spin wl-essential size-4', className)} />
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
