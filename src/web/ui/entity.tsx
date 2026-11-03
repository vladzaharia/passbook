import { Link } from '@tanstack/react-router';
import type { LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import { cn } from '../lib/cn.ts';
import { ENTITY, type EntityKind } from '../lib/entities.ts';

/** A stable hue (0-359) from an id, so a user keeps one colour everywhere. */
export function hueOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

/** "Ada Lovelace" -> "AL"; "maya.chen@example.com" -> "MC". */
export function initialsOf(name: string): string {
  const words = name
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    .filter(Boolean);
  const first = words[0]?.[0] ?? '?';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

/** Black or white text for a hex background (WCAG relative luminance). */
export function onColor(hex: string): string {
  const m = /^#?([\da-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) return '#ffffff';
  const n = Number.parseInt(m[1], 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return l > 0.179 ? '#060912' : '#ffffff';
}

const SIZE = {
  24: 'size-6 text-[0.625rem]',
  40: 'size-10 text-sm',
  48: 'size-12 text-base',
} as const;

export interface EntityAvatarProps {
  kind: 'user' | 'org';
  id: string;
  name: string;
  /** Org accent (branding); slate when unset. */
  accent?: string | null;
  size?: keyof typeof SIZE;
  className?: string;
}

/**
 * Users: initials on a hue from their id. Orgs: a monogram on the org accent with a 1 px foil
 * edge. Decorative: the name sits next to it.
 */
export function EntityAvatar({ kind, id, name, accent, size = 24, className }: EntityAvatarProps) {
  if (kind === 'user') {
    return (
      <span
        aria-hidden
        data-initials={initialsOf(name)}
        style={{ background: `oklch(0.5 0.11 ${hueOf(id)})` } as CSSProperties}
        className={cn(
          'inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white after:content-[attr(data-initials)]',
          SIZE[size],
          className,
        )}
      />
    );
  }
  const own = accent && /^#[\da-f]{6}$/i.test(accent) ? accent : undefined;
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 rounded-md bg-(image:--wl-foil) p-px',
        SIZE[size],
        className,
      )}
    >
      <span
        data-initials={initialsOf(name).slice(0, size === 24 ? 1 : 2)}
        style={
          (own ? { background: own, color: onColor(own) } : undefined) as CSSProperties | undefined
        }
        className="inline-flex size-full select-none items-center justify-center rounded-[5px] bg-(--wl-org-fallback) font-semibold text-white after:content-[attr(data-initials)]"
      />
    </span>
  );
}

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
  /** Without a name the chip reads "<Label> <short id>" in mono. */
  name?: string | null;
  to?: string;
  className?: string;
}

/** Icon plus name, linked when `to` is set: actors and targets in audit and timelines. */
export function EntityChip({ kind, id, name, to, className }: EntityChipProps) {
  const { icon: Icon, label } = ENTITY[kind];
  const body = (
    <>
      <Icon aria-hidden className="size-3.5 shrink-0 text-fg-muted" />
      {name ? (
        <span className="truncate">{name}</span>
      ) : (
        <span className="truncate">
          {label} <span className="font-mono text-xs text-fg-muted">{id.slice(-6)}</span>
        </span>
      )}
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
