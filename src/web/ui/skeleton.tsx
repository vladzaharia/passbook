import { type HTMLAttributes, type ReactNode, useEffect, useState } from 'react';
import { cn } from '../lib/cn.ts';

/**
 * A placeholder in the final shape and height. It appears after 150 ms (pk-delay-skeleton), so
 * fast loads never flash, and pulses only without reduced motion.
 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn('wl-skeleton rounded-md bg-state-hover-tint', className)}
      {...props}
    />
  );
}

function Loading({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role="status" aria-busy className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

export function SkeletonRows({ rows = 5, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <Loading label={label} className="flex flex-col gap-2">
      {range(rows).map((i) => (
        <Skeleton key={i} className="h-11 w-full" />
      ))}
    </Loading>
  );
}

/** Label and value pairs (KeyValue). */
export function SkeletonKeyValue({
  rows = 4,
  label = 'Loading',
}: {
  rows?: number;
  label?: string;
}) {
  return (
    <Loading
      label={label}
      className="grid grid-cols-[minmax(7rem,max-content)_1fr] gap-x-6 gap-y-2"
    >
      {range(rows).map((i) => (
        <div key={i} className="contents">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-5 w-full max-w-64" />
        </div>
      ))}
    </Loading>
  );
}

/** Timeline entries: dot, title and meta line. */
export function SkeletonTimeline({
  rows = 4,
  label = 'Loading',
}: {
  rows?: number;
  label?: string;
}) {
  return (
    <Loading label={label} className="flex flex-col gap-4">
      {range(rows).map((i) => (
        <div key={i} className="flex gap-3">
          <Skeleton className="size-5 shrink-0 rounded-full" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-48 max-w-full" />
            <Skeleton className="h-3 w-32" />
          </div>
        </div>
      ))}
    </Loading>
  );
}

/** A chart at its final height (overview): title row, the 640:160 plot, the data disclosure. */
export function SkeletonChartCard({ label = 'Loading chart' }: { label?: string }) {
  return (
    <Loading label={label} className="flex flex-col gap-2">
      <Skeleton className="h-5 w-32" />
      <Skeleton className="aspect-[640/160] w-full" />
      <Skeleton className="h-4 w-28" />
    </Loading>
  );
}

/** A pass tile: the pass at its aspect, then the action row. */
export function SkeletonPassTile() {
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      <Skeleton className="aspect-[320/420] w-full rounded-xl" />
      <div className="flex gap-2">
        <Skeleton className="h-11 flex-1" />
        <Skeleton className="size-11" />
      </div>
    </div>
  );
}

/** Grids of tiles: passes (portal), templates, pickers. */
export function SkeletonTileGrid({
  tiles = 3,
  label = 'Loading',
  className,
}: {
  tiles?: number;
  label?: string;
  className?: string;
}) {
  return (
    <Loading label={label} className={cn('grid gap-6 sm:grid-cols-2 lg:grid-cols-3', className)}>
      {range(tiles).map((i) => (
        <SkeletonPassTile key={i} />
      ))}
    </Loading>
  );
}

/** A detail page with a pass preview: title, pills, the 3:4 pass in a 20rem column, tabs, fields. */
export function SkeletonDetail({ label = 'Loading' }: { label?: string }) {
  return (
    <Loading label={label} className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-64 max-w-full" />
        <div className="flex gap-2">
          <Skeleton className="h-6 w-20 rounded-full" />
          <Skeleton className="h-6 w-24 rounded-full" />
        </div>
      </div>
      <div className="grid gap-6 xl:grid-cols-[20rem_minmax(0,1fr)]">
        <Skeleton className="aspect-[3/4] w-full max-w-80 max-xl:hidden" />
        <div className="flex min-w-0 flex-col gap-4">
          <Skeleton className="h-9 w-full" />
          {range(3).map((i) => (
            <div key={i} className="flex flex-col gap-2">
              <Skeleton className="h-5 w-28" />
              <Skeleton className="h-9 w-full" />
            </div>
          ))}
        </div>
      </div>
    </Loading>
  );
}

/**
 * Skeleton-to-content handoff: both share one grid cell (no layout shift); the content rises 4 px
 * over 200 ms while the skeleton fades out in 120 ms, then unmounts.
 */
export function Handoff({
  loading,
  skeleton,
  children,
}: {
  loading: boolean;
  skeleton: ReactNode;
  children: ReactNode;
}) {
  const [leaving, setLeaving] = useState(false);
  const [waited] = useState(loading);
  useEffect(() => {
    if (loading || !waited) return;
    setLeaving(true);
    const t = setTimeout(() => setLeaving(false), 120);
    return () => clearTimeout(t);
  }, [loading, waited]);
  if (loading) return <>{skeleton}</>;
  if (!waited) return <>{children}</>;
  return (
    <div className="grid">
      <div className="wl-handoff [grid-area:1/1] min-w-0">{children}</div>
      {leaving ? (
        <div aria-hidden className="wl-skeleton-out pointer-events-none [grid-area:1/1]">
          {skeleton}
        </div>
      ) : null}
    </div>
  );
}
