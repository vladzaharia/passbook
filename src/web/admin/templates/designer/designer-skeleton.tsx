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
