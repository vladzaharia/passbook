import type { ReactNode } from 'react';
import { DEFAULT_TIME_ZONE } from '@/shared/time-zone.ts';
import { formatTime } from '../lib/format.ts';
import './art/scenes/common.css';
import './art/scenes/peek.css';
import './hosted-card.css';

/** `hosted` (/login, SSR pages, 24 rem), `stage` (a device screen, 32 rem), `sheet` and `dialog` (inside an overlay). */
export type HostedSize = 'hosted' | 'stage' | 'sheet' | 'dialog';

export interface HostedLock {
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

export interface HostedCardProps {
  /** `main` on a page of its own (SSR); `div` inside the app shell. */
  as?: 'main' | 'div';
  /** Width and type step; `hosted` by default. `sheet` and `dialog` sit inside an overlay. */
  size?: HostedSize;
  /** Same as `size="stage"`: a wider card (32 rem) for a page that shows a code. */
  wide?: boolean;
  /** Inside a page that already has a header (the console): no viewport-tall centring. */
  inline?: boolean;
  brand?: ReactNode;
  /** The art seated on the card's top edge. */
  scene?: ReactNode;
  /** Names the state on the card (`data-state`). */
  state: string;
  title: ReactNode;
  /** One short line under the title. */
  lede?: ReactNode;
  /** A callout above the body. */
  error?: ReactNode;
  /** Replaces the lede in place and shakes the code field (no banner, no shift). */
  lineError?: string | undefined;
  /** While active: the title and line say when to retry; the body is disabled and dimmed. */
  lock?: HostedLock | undefined;
  /** Card body after the title: the one action. */
  children?: ReactNode;
  /** The line under the card body, split off by a divider. */
  footer?: ReactNode;
  /** After the card, inside the page column. */
  after?: ReactNode;
}

/**
 * The hosted card, one markup for the SPA's not-found and the worker's SSR pages
 * (worker/ssr/hosted.ts renders it to static markup): the band with the brand and the art, then
 * the card with its h1. Metrics: hosted-card.css, the same as /login.
 */
export function HostedCard({
  as: Root = 'div',
  size: sizeProp,
  wide,
  inline,
  brand,
  scene,
  state,
  title,
  lede,
  error,
  lineError,
  lock,
  children,
  footer,
  after,
}: HostedCardProps) {
  const size = sizeProp ?? (wide ? 'stage' : 'hosted');
  const locked = lock !== undefined && lock.until > lock.now;
  const overlay = size === 'sheet' || size === 'dialog';
  const Heading = overlay ? 'h2' : 'h1';
  const line = locked ? lockoutLine(lock.until, lock.now, lock.timeZone) : lineError;
  return (
    <Root
      className={['hosted', size === 'stage' && 'wide', (inline || overlay) && 'inline']
        .filter(Boolean)
        .join(' ')}
      data-size={size === 'hosted' ? undefined : size}
      data-locked={locked ? '' : undefined}
    >
      {brand || scene ? (
        <div className="band">
          <div className="brand">{brand}</div>
          <div className="scene" aria-hidden="true">
            {scene}
          </div>
        </div>
      ) : null}
      <section className="card" data-state={state}>
        <div className="body">
          <div>
            <Heading tabIndex={Root === 'div' ? -1 : undefined}>
              {locked ? 'Too many tries' : title}
            </Heading>
            {line ? (
              <p
                // Remounts per message, so a new error replays the shake.
                key={line}
                role={locked ? 'status' : 'alert'}
                className="lede"
                data-error={locked ? undefined : ''}
              >
                {line}
              </p>
            ) : lede ? (
              <p className="lede">{lede}</p>
            ) : null}
          </div>
          {error}
          {locked ? (
            <fieldset disabled className="field">
              {children}
            </fieldset>
          ) : (
            children
          )}
        </div>
        {footer}
      </section>
      {after}
    </Root>
  );
}
