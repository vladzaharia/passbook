import { ArrowRight } from 'lucide-react';
import type { CSSProperties } from 'react';
import { actionOf } from '@/web/lib/actions.ts';
import { cn } from '@/web/lib/cn.ts';
import type { Tone } from '@/web/lib/status.ts';
import { formatDateTime } from '../../lib/format.ts';
import type { AuditEntry } from './entry-drawer.tsx';
import { actorRef, targetRef } from './labels.ts';
import { RefChip } from './ref-chip.tsx';

export const TONE_TEXT: Record<Tone, string> = {
  success: 'text-success',
  info: 'text-info',
  warning: 'text-warning',
  danger: 'text-danger',
  accent: 'text-accent-fg',
  neutral: 'text-fg-muted',
};

/**
 * The Action cell, the row's title: its glyph in its tone, the label as the button that opens the
 * entry, styled like a RowLink (strong; teal and underlined on hover).
 */
export function ActionButton({
  entry,
  onOpen,
  className,
}: {
  entry: AuditEntry;
  onOpen: () => void;
  className?: string;
}) {
  const a = actionOf(entry.action);
  return (
    <button
      type="button"
      title={a.label}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      className={cn(
        'inline-flex max-w-full min-w-0 items-center gap-2 rounded-sm text-left text-sm font-medium text-fg-strong wl-colors hover:text-accent-fg hover:underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus pointer-coarse:min-h-11',
        className,
      )}
    >
      <a.icon aria-hidden className={cn('size-4 shrink-0', TONE_TEXT[a.tone])} />
      <span className="truncate">{a.label}</span>
    </button>
  );
}

/** Below 768: icon and action, then actor to target; the time sits right of the action. */
export function AuditRows({
  rows,
  onOpen,
  enter,
  orgName,
  showOrganization,
}: {
  rows: readonly AuditEntry[];
  onOpen: (id: number) => void;
  enter: boolean;
  orgName: (id: string | null) => string | undefined;
  showOrganization: boolean;
}) {
  return (
    <ul
      aria-label="Audit log"
      className={cn('wl-dim divide-y divide-border', enter && 'wl-stagger [--wl-rise:4px]')}
    >
      {rows.map((r, i) => {
        const target = targetRef(r);
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: pointer shortcut; the action button is the control
          <li
            key={r.id}
            data-row-id={r.id}
            style={enter ? ({ '--i': i } as CSSProperties) : undefined}
            onClick={() => onOpen(r.id)}
            className="flex min-w-0 cursor-pointer flex-col gap-1 px-4 py-3 active:bg-state-hover-tint"
          >
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <ActionButton entry={r} onOpen={() => onOpen(r.id)} />
              <time
                dateTime={new Date(r.at).toISOString()}
                className="shrink-0 text-xs whitespace-nowrap text-fg-muted"
              >
                {formatDateTime(r.at)}
              </time>
            </div>
            <div className="flex min-w-0 items-center gap-1.5 pl-6 text-xs text-fg">
              <RefChip value={actorRef(r)} className="max-w-[45%]" />
              {target ? (
                <>
                  <ArrowRight aria-hidden className="size-3 shrink-0 text-fg-muted" />
                  <span className="sr-only">to</span>
                  <RefChip value={target} className="min-w-0" />
                </>
              ) : null}
            </div>
            {showOrganization ? (
              <p className="min-w-0 break-words pl-6 text-xs text-fg-muted">
                Organization: {r.orgId ? (orgName(r.orgId) ?? r.orgId) : 'Not recorded'}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
