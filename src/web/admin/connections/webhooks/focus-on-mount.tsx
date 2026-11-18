import { type ReactNode, useEffect, useRef } from 'react';

/** Takes focus when it mounts: a form that swaps for a secret drops the button that had it. */
export function FocusOnMount({ children, label }: { children: ReactNode; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focus target for the swap, named for screen readers
    <div ref={ref} role="group" aria-label={label} tabIndex={-1} className="outline-none">
      {children}
    </div>
  );
}
