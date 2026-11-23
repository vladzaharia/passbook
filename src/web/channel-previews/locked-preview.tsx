import { ToggleLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import '../styles/hatch.css';

/** Where an author turns a channel off. A channel stopped above them (PassBook, plan, org) has no tab at all. */
export type OffLevel = 'template' | 'pass';

/**
 * A channel the template or pass turns off: the card greyed under a hatched veil (the off tab's
 * hatch), the channel, why, and where the viewer can, the way back on. Every preview switcher draws
 * this one pane.
 */
export function LockedPreview({
  channel,
  reason,
  level,
  card,
  children,
}: {
  /** "Google Wallet". */
  channel: string;
  /** "Off for this template". */
  reason: string;
  level: OffLevel;
  /** The card, drawn greyed behind the veil. */
  card: ReactNode;
  /** The way back on: the channels tab of this level, or of the template. */
  children?: ReactNode;
}) {
  return (
    <div
      data-locked={level}
      className="relative mx-auto flex w-full max-w-60 flex-col items-center"
    >
      <div aria-hidden className="pointer-events-none w-full opacity-40 grayscale">
        {card}
      </div>
      <div className="absolute inset-0 isolate flex flex-col items-center justify-center gap-1 overflow-hidden rounded-xl bg-surface-raised/85 p-4 text-center backdrop-blur-sm">
        <span aria-hidden className="wl-hatch absolute inset-0 -z-10 opacity-60" />
        <ToggleLeft aria-hidden className="mb-1 size-5 text-fg-muted" />
        <p className="text-sm font-medium text-fg-strong">{channel}</p>
        <p className="text-xs text-fg-muted">{reason}</p>
        {children ? <div className="mt-2">{children}</div> : null}
      </div>
    </div>
  );
}
