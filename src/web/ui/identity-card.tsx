import { LogIn } from 'lucide-react';
import type { ReactNode } from 'react';
import { DEFAULT_TIME_ZONE } from '@/shared/time-zone.ts';
import { cn } from '../lib/cn.ts';
import { formatTime } from '../lib/format.ts';
import { Button } from './button.tsx';
import './identity-card.css';

export type IdentitySize = 'hosted' | 'stage' | 'sheet' | 'dialog';

export interface IdentityLock {
  /** When the lock ends, in ms. */
  until: number;
  /** The current time, in ms (from `useNow`). */
  now: number;
  /** The org zone; default America/Los_Angeles. */
  timeZone?: string;
}

/** `Try again in 4:32.` under an hour, else `Try again at 2:00 PM.` in the org zone. */
export function lockoutLine(until: number, now: number, timeZone = DEFAULT_TIME_ZONE): string {
  const left = Math.max(0, Math.ceil((until - now) / 1000));
  if (left >= 3600) return `Try again at ${formatTime(until, timeZone)}.`;
  return `Try again in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.`;
}

export interface IdentityCardProps {
  size?: IdentitySize;
  title: string;
  /** One line under the title. */
  line?: ReactNode;
  /** Replaces the line in place. */
  error?: string | undefined;
  /** While active: the title and line say when to retry and the children are disabled and dimmed. */
  lock?: IdentityLock | undefined;
  /** The field. */
  children?: ReactNode;
  /** The full-width primary. */
  action?: ReactNode;
  /** One optional link. */
  link?: ReactNode;
  className?: string;
}

/**
 * The identity card: a brand band, a task title, the field, a full-width primary and one optional
 * link. `hosted` (/login, SSR pages), `stage` (a device screen), `sheet` and `dialog` differ in
 * width and type step only.
 */
export function IdentityCard({
  size = 'hosted',
  title,
  line,
  error,
  lock,
  children,
  action,
  link,
  className,
}: IdentityCardProps) {
  const locked = lock !== undefined && lock.until > lock.now;
  const Heading = size === 'sheet' || size === 'dialog' ? 'h2' : 'h1';
  const text = locked ? lockoutLine(lock.until, lock.now, lock.timeZone) : error;
  return (
    <section
      className={cn('wl-identity', className)}
      data-size={size}
      data-locked={locked ? '' : undefined}
    >
      <div aria-hidden className="wl-identity-band" />
      <div className="wl-identity-body">
        <Heading className="wl-identity-title">{locked ? 'Too many tries' : title}</Heading>
        {text ? (
          <p
            // Remounts per message, so a new error replays the shake.
            key={text}
            role={locked ? 'status' : 'alert'}
            className="wl-identity-line"
            data-error={locked ? undefined : ''}
          >
            {text}
          </p>
        ) : line ? (
          <p className="wl-identity-line">{line}</p>
        ) : null}
        {children ? (
          <fieldset disabled={locked} className="wl-identity-field">
            {children}
          </fieldset>
        ) : null}
        {action}
        {link}
      </div>
    </section>
  );
}

/** The `Signed out` hosted card: one action. */
export function SignedOutCard({
  onSignIn,
  leaving,
  size = 'dialog',
}: {
  onSignIn: () => void;
  leaving?: boolean;
  size?: 'hosted' | 'stage' | 'sheet' | 'dialog';
}) {
  return (
    <IdentityCard
      size={size}
      title="Signed out"
      action={
        <Button
          loading={leaving ?? false}
          iconStart={<LogIn aria-hidden />}
          className="w-full"
          onClick={onSignIn}
        >
          Sign in again
        </Button>
      }
    />
  );
}
