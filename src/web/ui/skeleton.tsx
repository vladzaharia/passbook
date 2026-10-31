import type { HTMLAttributes } from 'react';
import { cn } from '../lib/cn.ts';

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn(
        'animate-[wallet-pulse_1s_ease-in-out_infinite_alternate] rounded-md bg-state-hover-tint',
        className,
      )}
      {...props}
    />
  );
}

export function SkeletonRows({ rows = 5, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-busy className="flex flex-col gap-2">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}
