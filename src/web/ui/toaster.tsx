import { lazy, Suspense } from 'react';
import { later } from './toaster-queue.ts';

/**
 * Sonner and the buddy toast icons load as their own chunk when a Toaster mounts, so the entry
 * carries only this facade. A toast fired before then waits in a queue and shows once the
 * Toaster is mounted.
 */
const ToasterImpl = lazy(() =>
  import('./toaster-impl.tsx').then((m) => ({ default: m.ToasterImpl })),
);

export function Toaster({ belowTopBar = false }: { belowTopBar?: boolean }) {
  return (
    <Suspense fallback={null}>
      <ToasterImpl belowTopBar={belowTopBar} />
    </Suspense>
  );
}

let ids = 0;

export const toast = {
  success: (message: string) => later((t) => t.success(message)),
  /** A holder emailed: the buddy posts its pass like a letter. */
  sent: (message: string) => later((t) => t.sent(message)),
  /** `id` (given or returned) lets the page that shows the outcome take the toast down. */
  info: (message: string, id = `info-${++ids}`) => {
    later((t) => t.info(message, id));
    return id;
  },
  warning: (message: string) => later((t) => t.warning(message)),
  /**
   * Errors stay until dismissed. `title` names what failed ("Could not save"); `action` offers one
   * way on ("Retry").
   */
  error: (error: unknown, title: string, action?: { label: string; onClick: () => void }) =>
    later((t) => t.error(error, title, action)),
  /** A success with one follow-up ("View run"). */
  action: (message: string, action: { label: string; onClick: () => void }) =>
    later((t) => t.action(message, action)),
  /** A reversible change with Undo; returns the id `dismiss` takes. */
  undo: (message: string, onUndo: () => unknown) => {
    const id = `undo-${++ids}`;
    later((t) => t.undo(message, onUndo, id));
    return id;
  },
  /** Takes a toast down early (its offer no longer applies). No id, no-op. */
  dismiss: (id: string | number | undefined) => {
    if (id !== undefined) later((t) => t.dismiss(id));
  },
};
