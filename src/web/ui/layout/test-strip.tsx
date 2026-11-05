import { FlaskConical } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * The Test mode band's markup, with no hooks and no Tailwind so a Worker can render it statically
 * (test-strip.css). `more` is the second sentence; it hides below sm.
 */
export function TestStrip({
  children,
  more,
  className,
}: {
  children: ReactNode;
  more?: ReactNode;
  className?: string;
}) {
  return (
    <div role="status" className={className ? `wl-test-strip ${className}` : 'wl-test-strip'}>
      <FlaskConical aria-hidden />
      {children}
      {more ? <span data-more="sm">{more}</span> : null}
    </div>
  );
}
