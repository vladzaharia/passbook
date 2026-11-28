import type { ReactNode } from 'react';
import { cn } from '../../../lib/cn.ts';
import { Card, CardBody, CardHeader } from '../../../ui/index.ts';

/**
 * The shell of the shared pass tabs (trail, devices, versions). Admin draws each as a card with a
 * header. The Workbench's inspector already names the tab and is itself the surface, so `flat` draws
 * the same parts with no card around them: the actions on a line of their own, then the body.
 */
export function TabCard({
  flat,
  title,
  actions,
  rail,
  bodyless,
  heading,
  className,
  children,
}: {
  flat?: boolean | undefined;
  title: string;
  actions?: ReactNode;
  /** A loading rail drawn across the top edge. */
  rail?: ReactNode;
  /** The children bring their own padding (a list that fills the card). */
  bodyless?: boolean;
  /** Flat only: show the title as a heading (a tab with two sections). */
  heading?: boolean;
  className?: string;
  children: ReactNode;
}) {
  if (flat)
    return (
      <section aria-label={title} className={cn('relative flex min-w-0 flex-col gap-3', className)}>
        {rail}
        {heading ? <h3 className="text-sm font-semibold text-fg-strong">{title}</h3> : null}
        {actions ? (
          <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>
        ) : null}
        <div className="grid gap-4">{children}</div>
      </section>
    );
  return (
    <Card className={cn('min-w-0', className)}>
      {rail}
      <CardHeader title={title} actions={actions} />
      {bodyless ? children : <CardBody className="grid gap-4">{children}</CardBody>}
    </Card>
  );
}
