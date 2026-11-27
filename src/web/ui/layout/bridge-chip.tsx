import { ArrowLeft } from 'lucide-react';
import { BRIDGE_COPY } from '@/shared/copy/workbench-bridge.ts';
import { bridgeLabel, QUIET_AFTER, useBridgeOrigin } from '../../lib/workbench-bridge.ts';

/**
 * The way back to the Workbench tool a launch link came from: "← Events", titled "Back to
 * Workbench". Below 640 the arrow alone, the name kept in its accessible name. After three
 * navigations away it is a quiet "Workbench" link.
 */
export function BridgeChip() {
  const origin = useBridgeOrigin();
  if (!origin) return null;
  if (origin.hops >= QUIET_AFTER) {
    return (
      <a
        href={origin.return}
        className="inline-flex min-h-9 shrink-0 items-center rounded-md px-2 text-sm text-fg-muted hover:text-fg-strong pointer-coarse:min-h-11"
      >
        {BRIDGE_COPY.quiet}
      </a>
    );
  }
  const label = bridgeLabel(origin.return);
  return (
    <a
      href={origin.return}
      title={BRIDGE_COPY.back}
      aria-label={`${label}, ${BRIDGE_COPY.back}`}
      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-border-strong bg-surface-raised px-2.5 text-sm font-medium text-fg-strong hover:bg-state-hover-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus max-sm:border-transparent max-sm:bg-transparent max-sm:px-1 pointer-coarse:h-11"
    >
      <ArrowLeft aria-hidden className="size-4 shrink-0" />
      <span className="truncate max-sm:sr-only">{label}</span>
    </a>
  );
}
