import type { LucideIcon } from 'lucide-react';
import { MoreHorizontal, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn.ts';
import { Button } from './button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu.tsx';
import { IconButton } from './icon-button.tsx';

/** The list a ListRow sits in: rows divided by hairlines. */
export function ListRows({
  className,
  children,
  label,
}: {
  className?: string;
  children: ReactNode;
  label?: string;
}) {
  return (
    <ul aria-label={label} className={cn('@container divide-y divide-border', className)}>
      {children}
    </ul>
  );
}

export interface ListRowProps {
  /** A 16 px icon or a 24 px EntityAvatar. */
  leading?: ReactNode;
  title: ReactNode;
  /** Pills next to the title; they never shrink, the title truncates first. */
  pills?: ReactNode;
  /** xs muted text under the title; wraps, up to three lines. */
  meta?: ReactNode;
  /** A pill or the row actions, right-aligned and vertically centred; never wraps. */
  trailing?: ReactNode;
  /** data-row-id, for removeWithTransition. */
  rowId?: string;
  /** Highlights a row that arrived since the last render. */
  isNew?: boolean;
  className?: string;
}

/** One row pattern for every row list: emails, sessions, devices, images, mappings, health. */
export function ListRow({
  leading,
  title,
  pills,
  meta,
  trailing,
  rowId,
  isNew,
  className,
}: ListRowProps) {
  return (
    <li
      data-row-id={rowId}
      data-new={isNew ? '' : undefined}
      className={cn(
        // Very narrow (200 % zoom on a phone): the trailing control drops under the body.
        'flex min-h-11 items-center gap-3 py-3 first:pt-0 last:pb-0 @max-[16rem]:flex-wrap',
        className,
      )}
    >
      {leading ? (
        <span className="flex size-6 shrink-0 items-center justify-center text-fg-muted [&>svg]:size-4">
          {leading}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        {/* Narrow rows (phones): a pill that does not fit drops under the title, so the title
            (an email) shows in full. The meta wraps, up to three lines. */}
        <div className="flex min-w-0 items-center gap-x-2 gap-y-1 @max-[24rem]:flex-wrap">
          <span className="min-w-0 truncate text-sm text-fg-strong">{title}</span>
          {pills ? <span className="flex shrink-0 items-center gap-1.5">{pills}</span> : null}
        </div>
        {meta ? <p className="line-clamp-3 text-xs text-fg-muted">{meta}</p> : null}
      </div>
      {trailing ? (
        <div className="ml-auto flex shrink-0 items-center justify-end gap-1">{trailing}</div>
      ) : null}
    </li>
  );
}

export interface RowAction {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
  loading?: boolean;
}

/**
 * Row actions by count: one safe action is a ghost sm button with its icon, one destructive
 * action a ghost Trash2 icon button, two or more a ghost "…" menu (destructive last).
 */
export function RowActions({ actions, label }: { actions: readonly RowAction[]; label: string }) {
  const [only] = actions;
  if (actions.length === 0 || !only) return null;
  if (actions.length === 1) {
    if (only.destructive) {
      return (
        <IconButton
          label={only.label}
          size="sm"
          disabled={only.disabled}
          icon={<Trash2 aria-hidden />}
          onClick={only.onSelect}
        />
      );
    }
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled={only.disabled}
        loading={only.loading}
        iconStart={<only.icon aria-hidden />}
        onClick={only.onSelect}
      >
        {only.label}
      </Button>
    );
  }
  const ordered = [...actions].sort((a, b) => Number(!!a.destructive) - Number(!!b.destructive));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={label} size="sm" icon={<MoreHorizontal aria-hidden />} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {ordered.map((a) => (
          <DropdownMenuItem
            key={a.label}
            destructive={a.destructive}
            disabled={a.disabled}
            onSelect={a.onSelect}
          >
            <a.icon aria-hidden />
            {a.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
