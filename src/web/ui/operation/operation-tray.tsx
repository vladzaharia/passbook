import { Check, Loader2 } from 'lucide-react';
import { type ReactNode, useCallback, useState } from 'react';
import { safeNextPath } from '../../../shared/next.ts';
import { cn } from '../../lib/cn.ts';
import { PHONE, useMediaQuery } from '../../lib/media.ts';
import { IconButton } from '../icon-button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../popover.tsx';
import { useNow } from '../rel-time.tsx';
import { Sheet, SheetContent } from '../sheet.tsx';
import { useOperationParam } from './op-param.ts';
import { OperationRow } from './operation-row.tsx';
import { OperationSheet } from './operation-sheet.tsx';
import type { Operation } from './types.ts';
import { useTray } from './use-tray.ts';

function TrayList({
  active,
  recent,
  now,
  onOpen,
}: {
  active: readonly Operation[];
  recent: readonly Operation[];
  now: number;
  onOpen: (op: Operation) => void;
}): ReactNode {
  return (
    <div className="flex flex-col">
      {active.map((op) => (
        <OperationRow key={op.id} operation={op} now={now} onOpen={onOpen} />
      ))}
      {recent.length > 0 && active.length > 0 ? (
        <p className="px-3 pt-3 pb-1 text-xs font-medium text-fg-muted">Earlier</p>
      ) : null}
      {recent.map((op) => (
        <OperationRow key={op.id} operation={op} now={now} onOpen={onOpen} />
      ))}
    </div>
  );
}

/** The tray's own live region says an end, never a count. */
function endedLine(recent: readonly Operation[]): string {
  const last = recent[0];
  if (!last) return '';
  return last.status === 'cancelled' ? 'Stopped' : last.text;
}

/**
 * The global indicator for the top bar's `controls` slot: hidden with nothing running and nothing
 * unseen; otherwise an Activity button with a pending ring and a count. A popover from 640 px, a
 * bottom sheet below it. A row opens the operation's sheet, or its page when it is done and has one.
 * Space-free: the host passes `onNavigate` for its router and mounts it inside an
 * `OperationsProvider` when it needs its own client.
 */
export function OperationTray({
  onNavigate = (href) => window.location.assign(href),
  zone,
  notify,
  className,
}: {
  onNavigate?: (href: string) => void;
  zone?: string;
  /** Completion toasts; off where the host has no toaster. */
  notify?: boolean;
  className?: string;
}) {
  const phone = useMediaQuery(PHONE);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useOperationParam();
  const closeDetail = useCallback(() => setDetail(null), [setDetail]);
  const openOp = (op: Operation) => {
    setOpen(false);
    // The server holds `result.href` to an app path; a client that is handed anything else opens the sheet.
    const href = op.status === 'succeeded' ? safeNextPath(op.result?.href) : null;
    if (href) onNavigate(href);
    else setDetail(op.id);
  };
  const { active, recent, unseen, markSeen } = useTray({ notify, onOpen: openOp });
  const now = useNow(1000, active.length > 0);
  const busy = active.length > 0;
  const visible = busy || unseen > 0 || open;
  const label = busy ? `Activity, ${active.length} running` : `Activity, ${unseen} finished`;
  const change = (next: boolean) => {
    setOpen(next);
    if (next) markSeen();
  };
  const button = (
    <IconButton
      label={label}
      icon={busy ? <Loader2 aria-hidden className="wl-spin wl-essential" /> : <Check aria-hidden />}
      onClick={phone ? () => change(true) : undefined}
      className={cn('wl-colors', busy && 'ring-2 ring-accent/40', className)}
    />
  );
  const list = <TrayList active={active} recent={recent} now={now} onOpen={openOp} />;
  return (
    <>
      {visible ? (
        <span
          data-operation-tray=""
          className="relative inline-flex motion-safe:animate-[wl-fade-in_120ms_var(--wl-ease-out)_backwards]"
        >
          {phone ? (
            <>
              {button}
              <Sheet open={open} onOpenChange={change}>
                <SheetContent title="Activity" side="bottom">
                  <div className="p-2">{list}</div>
                </SheetContent>
              </Sheet>
            </>
          ) : (
            <Popover open={open} onOpenChange={change}>
              <PopoverTrigger asChild>{button}</PopoverTrigger>
              <PopoverContent align="end" className="w-[22rem] max-w-[calc(100vw-2rem)] p-1">
                <p className="px-3 pt-2 pb-1 text-sm font-semibold text-fg-strong">Activity</p>
                {list}
              </PopoverContent>
            </Popover>
          )}
          <span
            aria-hidden
            className="pointer-events-none absolute -top-1 -right-1 grid min-w-4 place-items-center rounded-full bg-accent px-1 text-[0.625rem] leading-4 font-semibold tabular-nums text-accent-on"
          >
            {busy ? active.length : unseen}
          </span>
        </span>
      ) : null}
      <p role="status" aria-label="Activity" aria-live="polite" className="sr-only">
        {endedLine(recent)}
      </p>
      <OperationSheet id={detail} onClose={closeDetail} zone={zone} />
    </>
  );
}
