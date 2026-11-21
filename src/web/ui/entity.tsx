import { Link } from '@tanstack/react-router';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../lib/cn.ts';
import { ENTITY, type EntityKind } from '../lib/entities.ts';

export { EntityAvatar, initialsOf, onColor } from './avatar.tsx';

/** The one icon tile: 32 px holding a 16 px icon (Overview tiles, Status rows). */
export function EntityIcon({
  kind,
  icon,
  className,
}: {
  kind?: EntityKind;
  icon?: LucideIcon;
  className?: string;
}) {
  const Icon = icon ?? (kind ? ENTITY[kind].icon : ENTITY.search.icon);
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-sunken text-fg-muted',
        className,
      )}
    >
      <Icon className="size-4" />
    </span>
  );
}

export interface EntityChipProps {
  kind: EntityKind;
  id: string;
  /** Without a name the chip reads the kind alone ("User"), never a slice of the id. */
  name?: string | null;
  to?: string;
  className?: string;
}

/** Icon plus name, linked when `to` is set: actors and targets in audit and timelines. */
export function EntityChip({ kind, name, to, className }: EntityChipProps) {
  const { icon: Icon, label } = ENTITY[kind];
  const body = (
    <>
      <Icon aria-hidden className="size-3.5 shrink-0 text-fg-muted" />
      {name ? <span className="truncate">{name}</span> : <span className="truncate">{label}</span>}
    </>
  );
  const classes = cn('inline-flex max-w-full min-w-0 items-center gap-1 align-bottom', className);
  if (!to) return <span className={classes}>{body}</span>;
  return (
    <Link
      to={to}
      className={cn(
        classes,
        'rounded-sm text-fg hover:text-fg-strong hover:underline underline-offset-2',
      )}
    >
      {body}
    </Link>
  );
}
