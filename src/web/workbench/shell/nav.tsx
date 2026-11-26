import { Link } from '@tanstack/react-router';
import { LoaderCircle } from 'lucide-react';
import { Fragment } from 'react';
import { WB_SHELL_COPY } from '@/shared/copy/workbench-shell.ts';
import { type WbTool, wbPath } from '@/shared/workbench.ts';
import { cn } from '../../lib/cn.ts';
import { ActiveIndicator } from '../../ui/active-indicator.tsx';
import { CountUp } from '../../ui/count-up.tsx';
import { type Attention, type AttentionMap, useArrive } from './attention.ts';
import { GO_CHORD } from './keys.ts';
import { contextFreePath, type NavGroup, PUBLIC_AREAS } from './nav-model.ts';

const LINK =
  'wb-nav-link relative flex min-h-8 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium pointer-coarse:min-h-11 transition-[color,background-color] duration-(--wl-dur-hover)';

/** The meta beside an item: a count, a ring, a dot. Its words are part of the link's name. */
function Meta({ attention, known }: { attention: Attention | undefined; known: boolean }) {
  const value = attention && 'value' in attention ? attention.value : 0;
  // A rise from what was shown plays the arrive once; the first load and a fall never do.
  const arrivals = useArrive(known ? value : undefined);
  if (!attention) return null;
  switch (attention.kind) {
    case 'progress':
      return (
        <span aria-hidden className="wb-meta">
          {attention.done}/{attention.total}
        </span>
      );
    case 'danger':
      return (
        <span
          key={arrivals}
          aria-hidden
          data-kind="danger"
          className={cn('wb-meta', arrivals > 0 && 'wb-arrive')}
        >
          <CountUp value={attention.value} />
        </span>
      );
    case 'count':
      return (
        <span key={arrivals} aria-hidden className={cn('wb-meta', arrivals > 0 && 'wb-arrive')}>
          <CountUp value={attention.value} />
        </span>
      );
    case 'running':
      return (
        <span aria-hidden className="wb-meta">
          <LoaderCircle className="size-3 animate-spin" />
          {attention.value}
        </span>
      );
    case 'live':
      return (
        <span aria-hidden className="wb-meta">
          <span className="wb-live" />
        </span>
      );
    case 'warn':
      return (
        <span aria-hidden className="wb-meta">
          <span className="size-2 rounded-full bg-warning" />
        </span>
      );
  }
}

export interface WorkbenchNavProps {
  groups: readonly NavGroup[];
  /** The context's org; none in the chooser or signed out (areas then open the context-free path). */
  orgId: string | null;
  /** Signed out: only the public areas link; the rest are plain items (design §6). */
  signedOut: boolean;
  current: WbTool | null;
  attention: AttentionMap;
  /** The summary has answered once: a later rise is an arrival. */
  known: boolean;
  singleKeys: boolean;
  onNavigate?: () => void;
}

/** The grouped nav (design §1.4): one markup in the sidebar and the phone sheet. */
export function WorkbenchNav({
  groups,
  orgId,
  signedOut,
  current,
  attention,
  known,
  singleKeys,
  onNavigate,
}: WorkbenchNavProps) {
  return (
    <nav aria-label={WB_SHELL_COPY.nav} className="wb-nav relative flex flex-col px-3 pt-1 pb-3">
      <ActiveIndicator />
      {groups.map((group) => (
        <Fragment key={group.id}>
          {group.label ? (
            <p aria-hidden className="wb-group-label mt-3.5">
              {group.label}
            </p>
          ) : null}
          {group.items.map(({ tool, label, icon: Icon }) => {
            const active = tool === current;
            const meta = attention[tool];
            // The meta reads as part of the name ("Logs, 3 new errors"); its glyph is hidden.
            const body = (
              <>
                <Icon
                  aria-hidden
                  className={cn(
                    'wb-nav-icon size-4 shrink-0',
                    active ? 'text-accent-fg' : 'text-fg-muted',
                  )}
                />
                <span className="truncate">
                  {label}
                  {meta ? <span className="sr-only">, {meta.label}</span> : null}
                </span>
                <Meta attention={meta} known={known} />
              </>
            );
            const style = cn(
              LINK,
              active ? 'text-fg-strong' : 'text-fg hover:bg-state-hover-tint hover:text-fg-strong',
            );
            // Signed out, only the public areas are links; a deep link to the rest shows the one sign-in state.
            if (signedOut && !PUBLIC_AREAS.has(tool))
              return (
                <span key={tool} data-plain className={cn(LINK, 'text-fg-muted')}>
                  {body}
                </span>
              );
            const to = orgId ? wbPath(orgId, tool) : contextFreePath(tool);
            return (
              <Link
                key={tool}
                to={to}
                onClick={onNavigate}
                // The current area is the shell's call (wbToolOf): the router's prefix match
                // would mark Home current on every page too.
                activeOptions={{ exact: true }}
                aria-current={active ? 'page' : undefined}
                aria-keyshortcuts={singleKeys ? GO_CHORD[tool] : undefined}
                className={style}
              >
                {body}
              </Link>
            );
          })}
        </Fragment>
      ))}
    </nav>
  );
}
