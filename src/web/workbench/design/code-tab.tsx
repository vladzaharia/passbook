import { lazy, Suspense } from 'react';
import { Skeleton } from '../../ui/skeleton.tsx';

const CodePanels = lazy(() => import('./code-panels.tsx'));

/**
 * The Code tab (design §1.8): the template's input schema, `passbook types <id>`, and `POST
 * /passes` for the sample on screen in TypeScript, curl, Python and Go. The key is never in it.
 * The snippet writers load when the tab first renders, behind a card of its size.
 */
export function CodeTab() {
  return (
    <Suspense
      fallback={
        <div
          role="status"
          aria-busy
          className="mt-4 grid gap-3 rounded-lg border border-border bg-surface p-3"
        >
          <span className="sr-only">Loading code</span>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      }
    >
      <CodePanels />
    </Suspense>
  );
}
