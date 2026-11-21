import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import type { PassView } from '../../shared/pass-view/index.ts';
import { PassCard } from '../pass-card/PassCard.tsx';
import './pass-stack.css';

/** One pass behind the front one: its card's real top edge, clipped, as a link. */
export interface StackPeek {
  id: string;
  view: PassView;
  /** The link's name: what the pass is. */
  name: string;
  /** Where the peek goes without script: /passes/:id in the portal, the member's /p on /b. */
  href: string;
  /** Voided or expired: the card greys. */
  dim?: boolean;
  removed?: boolean;
}

export interface PassStackProps {
  /** The list's accessible name. */
  label: string;
  /** The front pass, full size, with its own row (the caller's: badge, Refresh, More). */
  front?: ReactNode;
  /** Every other pass, in order. The front card carries `pass-<id>` as its transition name. */
  peeks: readonly StackPeek[];
  /**
   * The portal: a plain click on a peek (no modifier keys) calls this instead of following
   * `href`, to bring it forward. Absent (SSR, /b): peeks are plain links.
   */
  onPick?: (id: string) => void;
  /** The front card rises in (no view transition ran: unsupported, or the first paint). */
  raise?: boolean;
  className?: string;
}

const plainClick = (e: MouseEvent) =>
  e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/**
 * Wallet's stack, one structure for My passes and the bundle page (SSR-safe, no hooks): the front
 * pass at full size, then the top 58 px of every other card, overlapping. Peeks are the real card
 * clipped, never a redrawn strip, so they truncate as Wallet's do. Each peek carries the card's
 * view-transition name, so bringing it forward morphs the strip into the front card.
 */
export function PassStack({ label, front, peeks, onPick, raise, className }: PassStackProps) {
  if (!front && peeks.length === 0) return null;
  return (
    <ul className={className ? `wl-stack ${className}` : 'wl-stack'} aria-label={label}>
      {front ? (
        <li className="wl-stack-front" data-raise={raise || undefined}>
          {front}
        </li>
      ) : null}
      {peeks.map((peek, i) => (
        <li key={peek.id} className="wl-stack-peek" style={{ '--i': i + 1 } as CSSProperties}>
          <a
            className="wl-peek"
            href={peek.href}
            data-dim={peek.dim || undefined}
            style={
              {
                viewTransitionName: `pass-${peek.id}`,
                viewTransitionClass: 'pass',
              } as CSSProperties
            }
            onClick={
              onPick
                ? (e) => {
                    if (!plainClick(e)) return;
                    e.preventDefault();
                    onPick(peek.id);
                  }
                : undefined
            }
          >
            <span className="wl-peek-name">{peek.name}</span>
            <span className="wl-peek-card" aria-hidden>
              <PassCard view={peek.view} face="front" removed={peek.removed} />
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
