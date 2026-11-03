import { createLink } from '@tanstack/react-router';
import type { LucideIcon } from 'lucide-react';
import type { AnchorHTMLAttributes, Ref } from 'react';
import { cn } from '../lib/cn.ts';
import { formatCount } from '../lib/format.ts';
import { TOUCH_HIT } from './button.tsx';

type AnchorProps = AnchorHTMLAttributes<HTMLAnchorElement> & { ref?: Ref<HTMLAnchorElement> };

/**
 * A list row's title. Strong text, teal and underlined on hover: the name is content, the row is
 * the target, and teal stays for actions (ui-consistency.md "Tables").
 */
const ROW_LINK =
  'block min-w-0 truncate rounded-sm font-medium text-fg-strong underline-offset-2 wl-colors hover:text-accent-fg hover:underline';
/** Voided or archived records: muted and struck through, also on hover. */
const ROW_LINK_INACTIVE =
  'text-fg-muted line-through decoration-fg-subtle hover:text-fg-strong hover:line-through';

/** A count that opens the filtered list: teal, because following it is an action. */
const COUNT_LINK = cn(
  'relative inline-flex items-center gap-1.5 rounded-sm font-medium text-accent-fg tabular-nums underline-offset-2 hover:underline [&_svg]:size-4',
  TOUCH_HIT,
);

/** A link in a meta line (page header meta, card meta): muted like its neighbours. */
const META_LINK = cn(
  'relative inline-flex min-h-6 items-center gap-1.5 rounded-sm text-fg-muted underline-offset-2 wl-colors hover:text-fg-strong hover:underline [&_svg]:size-4',
  TOUCH_HIT,
);

function RowAnchor({
  inactive,
  className,
  ref,
  ...props
}: AnchorProps & {
  /** Voided, archived or revoked. */
  inactive?: boolean;
}) {
  return (
    <a ref={ref} className={cn(ROW_LINK, inactive && ROW_LINK_INACTIVE, className)} {...props} />
  );
}

function CountAnchor({
  count,
  noun,
  icon: Icon,
  className,
  ref,
  children: _children,
  ...props
}: AnchorProps & {
  count: number;
  /** Singular and plural: "12 passes". Without it the number stands alone (table cells). */
  noun?: readonly [string, string];
  icon?: LucideIcon;
}) {
  if (count === 0) {
    return (
      <span className={cn('text-fg-muted tabular-nums', className)}>{noun ? 'None' : '0'}</span>
    );
  }
  return (
    <a ref={ref} className={cn(COUNT_LINK, className)} {...props}>
      {Icon ? <Icon aria-hidden /> : null}
      {formatCount(count)}
      {noun ? ` ${count === 1 ? noun[0] : noun[1]}` : null}
    </a>
  );
}

function MetaAnchor({
  icon: Icon,
  className,
  ref,
  children,
  ...props
}: AnchorProps & { icon?: LucideIcon }) {
  return (
    <a ref={ref} className={cn(META_LINK, className)} {...props}>
      {Icon ? <Icon aria-hidden /> : null}
      {children}
    </a>
  );
}

/** The title cell of a list row: `<RowLink to="/admin/users/$userId" params={…}>Maya</RowLink>`. */
export const RowLink = createLink(RowAnchor);
/** A count that opens a filtered list; zero renders as muted text, not a link. */
export const CountLink = createLink(CountAnchor);
/** "Audit log" and other links in a meta row, with an optional leading icon. */
export const MetaLink = createLink(MetaAnchor);
