import { ChevronDown } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { cn } from '../../lib/cn.ts';
import { PHONE, useMediaQuery } from '../../lib/media.ts';

const WIDE = '(min-width: 1024px)';
const STICKY = 'sticky top-[calc(4.5rem+env(safe-area-inset-top))]';

export interface TwoSidedProps {
  /** The provider's side: the guide's steps. Prose stays under 40rem inside it. */
  guide: ReactNode;
  /** The provider's side named over the guide: "In Shopify". */
  guideLabel?: string;
  /** PassBook's side: the URL to copy, the topics, the live check. */
  panel: ReactNode;
  /** The panel's name for screen readers: "PassBook". */
  panelLabel?: string;
  /** Between 640 and 1023: one line that stays under the stepper ("URL [Copy] · Listening"). */
  strip: ReactNode;
  className?: string;
}

const HEAD = 'text-xs font-medium tracking-wide text-fg-muted uppercase';

/** The side's name in the rail's own style, so the page and the rail say the same. */
const Side = ({ label, children }: { label?: string | undefined; children: ReactNode }) => (
  <div className="flex min-w-0 flex-col gap-4">
    {label ? <p className={HEAD}>{label}</p> : null}
    {children}
  </div>
);

/** PassBook's side is one surface: the URL, the topics and the live check read as one block. */
const Surface = ({ children }: { children: ReactNode }) => (
  <div className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-surface-raised p-4">
    <p className={HEAD}>In PassBook</p>
    {children}
  </div>
);

/**
 * Both sides of the setup at once. At 1024 and up the guide has the column and the PassBook panel
 * sticks beside it (22rem). From 640 to 1023 the panel folds into a sticky strip that opens as a
 * disclosure. Under 640 they stack. The panel stays mounted in every shape: listening goes on.
 */
export function TwoSided({
  guide,
  guideLabel,
  panel,
  panelLabel = 'PassBook',
  strip,
  className,
}: TwoSidedProps) {
  const wide = useMediaQuery(WIDE);
  const phone = useMediaQuery(PHONE);
  const [open, setOpen] = useState(false);
  const id = useId();
  if (wide)
    return (
      <div className={cn('grid grid-cols-[minmax(0,1fr)_22rem] items-start gap-8', className)}>
        <Side label={guideLabel}>{guide}</Side>
        <aside aria-label={panelLabel} className={cn(STICKY, 'min-w-0')}>
          <Surface>{panel}</Surface>
        </aside>
      </div>
    );
  if (phone)
    return (
      <div className={cn('flex min-w-0 flex-col gap-6', className)}>
        <Side label={guideLabel}>{guide}</Side>
        <aside aria-label={panelLabel} className="min-w-0">
          <Surface>{panel}</Surface>
        </aside>
      </div>
    );
  return (
    <div className={cn('flex min-w-0 flex-col gap-5', className)}>
      <aside aria-label={panelLabel} className={cn(STICKY, 'z-10 min-w-0')}>
        <div className="flex min-h-11 items-center gap-3 rounded-lg border border-border bg-surface-overlay px-3 py-1.5 shadow-elevation-2">
          <div className="min-w-0 flex-1">{strip}</div>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen((o) => !o)}
            className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-md px-2 text-sm text-fg-muted hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:min-h-11"
          >
            {open ? 'Hide' : 'Details'}
            <ChevronDown
              aria-hidden
              className={cn(
                'size-4 transition-transform duration-(--wl-dur-hover) motion-reduce:transition-none',
                open && 'rotate-180',
              )}
            />
          </button>
        </div>
        <div id={id} hidden={!open} className="mt-3">
          <Surface>{panel}</Surface>
        </div>
      </aside>
      <Side label={guideLabel}>{guide}</Side>
    </div>
  );
}
