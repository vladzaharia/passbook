import { ArrowLeft } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { ORIGIN_COPY } from '@/shared/copy/workbench-shell.ts';
import { cn } from '../../lib/cn.ts';
import { useAnnounce } from './announcer.tsx';
import { type Origin, originLabel, QUIET_AFTER } from './origin.ts';

/**
 * The way back to where a launch link came from (design §2.4): "← Webhook endpoint", titled "Back
 * to admin". Below 640 the arrow alone, the name kept in its accessible name. After three
 * navigations away it is a quiet "Admin" or "Docs" link. The first stop after the skip links.
 */
export function OriginChip({ origin }: { origin: Origin }) {
  const announce = useAnnounce();
  const label = originLabel(origin);
  const copy = ORIGIN_COPY[origin.from];
  const said = useRef<string | null>(null);
  useEffect(() => {
    if (origin.hops !== 0 || said.current === origin.return) return;
    said.current = origin.return;
    announce(`${copy.back}: ${label}`);
  }, [origin.hops, origin.return, announce, copy.back, label]);
  // Another space is another document: admin adopts its own state on a full load.
  if (origin.hops >= QUIET_AFTER) {
    return (
      <a
        href={origin.return}
        className="inline-flex min-h-9 shrink-0 items-center rounded-md px-2 text-sm text-fg-muted wl-colors hover:text-fg-strong pointer-coarse:min-h-11"
      >
        {copy.quiet}
      </a>
    );
  }
  return (
    <a
      href={origin.return}
      title={copy.back}
      aria-label={`${label}, ${copy.back}`}
      className={cn(
        'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-border-strong bg-surface-raised px-2.5 text-sm font-medium text-fg-strong wl-colors hover:bg-state-hover-tint pointer-coarse:h-11',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus max-sm:px-2',
      )}
    >
      <ArrowLeft aria-hidden className="size-4 shrink-0" />
      <span className="truncate max-sm:sr-only">{label}</span>
    </a>
  );
}
