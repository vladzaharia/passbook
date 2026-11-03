import { X } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Callout, IconButton } from '../../ui/index.ts';

const marks = new Map<string, unknown>();

/**
 * A create flow marks what it made just before it opens the new page (replacing itself in
 * history), so that page leads with "Created" and the next steps, once. `detail` is what the page
 * needs to word them.
 */
export function markCreated(key: string, detail: unknown = true): void {
  marks.set(key, detail);
}

/** The mark left for `key`, read once on mount: it never survives a reload or a second visit. */
export function useCreated<T = true>(
  key: string,
): { mark: T | undefined; shown: boolean; dismiss: () => void } {
  const [mark] = useState(() => marks.get(key) as T | undefined);
  const [shown, setShown] = useState(mark !== undefined);
  useEffect(() => {
    marks.delete(key);
  }, [key]);
  return { mark, shown, dismiss: () => setShown(false) };
}

/** "Pass created" with its next steps as small buttons, until dismissed. */
export function CreatedCallout({
  title,
  actions,
  onDismiss,
}: {
  title: ReactNode;
  actions?: ReactNode;
  onDismiss: () => void;
}) {
  return (
    <div className="relative">
      <Callout tone="success" title={title} actions={actions} className="pr-12" />
      <IconButton
        label="Dismiss"
        size="sm"
        icon={<X aria-hidden />}
        onClick={onDismiss}
        className="absolute top-2 right-2"
      />
    </div>
  );
}
