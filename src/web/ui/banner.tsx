import type { LucideIcon } from 'lucide-react';
import {
  Ban,
  Clock,
  CreditCard,
  Eye,
  FlaskConical,
  OctagonX,
  RefreshCw,
  WifiOff,
} from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn.ts';

/** A state that holds while it is true (unify-screens spec 3.9). */
export type BannerTone =
  | 'offline'
  | 'read-only'
  | 'restricted'
  | 'suspended'
  | 'test'
  | 'past-due'
  | 'grace'
  | 'reconnect';

type Look = 'refused' | 'heads-up' | 'system';

const TONE: Record<BannerTone, { icon: LucideIcon; look: Look }> = {
  offline: { icon: WifiOff, look: 'system' },
  restricted: { icon: OctagonX, look: 'refused' },
  suspended: { icon: Ban, look: 'system' },
  'read-only': { icon: Eye, look: 'system' },
  test: { icon: FlaskConical, look: 'heads-up' },
  'past-due': { icon: CreditCard, look: 'heads-up' },
  grace: { icon: Clock, look: 'heads-up' },
  reconnect: { icon: RefreshCw, look: 'heads-up' },
};

const LOOK: Record<Look, string> = {
  refused: 'border-danger-border bg-danger-subtle text-danger',
  'heads-up': 'border-warning-border bg-warning-subtle text-warning',
  system: 'border-(--pk-slate-line) bg-(--pk-slate-bg) text-(--pk-slate-fg)',
};

export interface BannerProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  tone: BannerTone;
  /** One line. */
  children: ReactNode;
  /** At most one: a small button or link. */
  action?: ReactNode;
}

/**
 * A slim bar: the tone's tint and icon, one line, at most one action. Offline, read-only,
 * restricted, suspended, Test, past due, grace and reconnect; never a Callout at the top of a page.
 */
export function Banner({ tone, children, action, className, ...rest }: BannerProps) {
  const { icon: Icon, look } = TONE[tone];
  return (
    <div
      role={look === 'refused' ? 'alert' : 'status'}
      data-banner={tone}
      data-look={look}
      className={cn(
        'flex min-h-8 flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b px-safe py-1 text-xs font-medium',
        LOOK[look],
        className,
      )}
      {...rest}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span>{children}</span>
      {action}
    </div>
  );
}
