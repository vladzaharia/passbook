import type { ReactNode } from 'react';
import { cn } from '../lib/cn.ts';

export interface DependentSettingsProps {
  /** The parent is on. Closed, the children stay mounted (drafts and saved values keep) but hidden. */
  open: boolean;
  /**
   * The parent cannot work at all (say why, with the fix link). Shows this one line instead of the
   * children; the caller also disables the parent switch.
   */
  unsupported?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * Settings that only matter while a parent switch is on. Hidden and inert while off, shown with a
 * short height and opacity transition (none under reduced motion). The saved values are not touched.
 * Every parent-child group uses this, never a page conditional.
 */
export function DependentSettings({
  open,
  unsupported,
  children,
  className,
}: DependentSettingsProps) {
  if (unsupported)
    return (
      <p data-testid="dependent-unsupported" className="text-sm text-fg-muted">
        {unsupported}
      </p>
    );
  return (
    <div className="wl-dependent" data-open={open ? '' : undefined} inert={!open}>
      <div className={cn('wl-dependent-body flex flex-col gap-4', className)} aria-hidden={!open}>
        {children}
      </div>
    </div>
  );
}
