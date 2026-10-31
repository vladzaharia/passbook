import { Loader2 } from 'lucide-react';
import { cn } from '../lib/cn.ts';

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <span role={label ? 'status' : undefined} className="inline-flex">
      <Loader2
        aria-hidden
        className={cn('size-4 animate-spin motion-reduce:animate-none', className)}
      />
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
