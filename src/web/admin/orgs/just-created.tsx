import { X } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Callout, IconButton } from '@/web/ui/index.ts';

const created = new Set<string>();

/** A create dialog marks the new entity before opening its page, which then shows CreatedCallout. */
export const markCreated = (id: string) => void created.add(id);

/** True once, on the first visit after markCreated(id), until dismissed. */
export function useJustCreated(id: string): { shown: boolean; dismiss: () => void } {
  const [shown, setShown] = useState(() => created.has(id));
  useEffect(() => {
    created.delete(id);
  }, [id]);
  return { shown, dismiss: () => setShown(false) };
}

/**
 * The page a create lands on says so once, with the next steps in one line (ux-principles rule 1);
 * it stands in for a success toast.
 */
export function CreatedCallout({
  title,
  children,
  actions,
  onDismiss,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  onDismiss: () => void;
}) {
  return (
    <div className="relative">
      <Callout tone="success" title={title} actions={actions} className="pr-12">
        {children}
      </Callout>
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
