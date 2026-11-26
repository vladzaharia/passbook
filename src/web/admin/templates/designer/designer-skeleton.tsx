import { Skeleton } from '../../../ui/index.ts';

/** The designer's three columns, so the page does not jump when it loads. */
export function DesignerSkeleton() {
  return (
    <div role="status" aria-busy className="dz-layout">
      <span className="sr-only">Loading template</span>
      <div className="dz-structure grid min-w-0 gap-2">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-11 w-full rounded-lg" />
        ))}
      </div>
      <div className="dz-stage min-w-0">
        <Skeleton className="mx-auto aspect-[320/420] w-full max-w-xs rounded-xl" />
      </div>
      <div className="dz-issues grid min-w-0 gap-2">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-9 w-full" />
      </div>
    </div>
  );
}

/** The Wallets mode's rail of wallets above the same columns. */
export function WalletsSkeleton() {
  return (
    <div className="grid gap-5">
      <div className="grid grid-cols-2 gap-3">
        <Skeleton className="h-[4.25rem] rounded-lg" />
        <Skeleton className="h-[4.25rem] rounded-lg" />
      </div>
      <DesignerSkeleton />
    </div>
  );
}

/** An opening section's panel while its code loads. */
export function SectionSkeleton() {
  return (
    <div role="status" aria-busy className="grid gap-3">
      <span className="sr-only">Loading section</span>
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}
