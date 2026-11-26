import type { ReactNode } from 'react';
import { Buddy, type BuddyScene } from '../art/index.ts';
import { ProgressBar } from '../progress-bar.tsx';

/**
 * The foil bar with the buddy riding it: a run's progress. The page polls; the bar moves to match.
 * With `text` it also heads the bar with the count (a polite live region, for pages that poll one
 * run); without it the caller owns the headline and the live region.
 */
export function RunBar({
  done,
  total,
  text,
  meta,
  aside,
  label = 'Passes handled',
  scene = 'count',
  buddy = true,
}: {
  done: number;
  total: number;
  text?: string;
  /** Muted, beside the count: time left. */
  meta?: ReactNode;
  /** Right of the count: "You can leave this page." */
  aside?: ReactNode;
  /** Names the bar for screen readers: what is counted. */
  label?: string;
  /** What the rider acts out; `busy` while an operation runs. */
  scene?: BuddyScene;
  /** No rider: the page has its own buddy. */
  buddy?: boolean;
}) {
  const share = total > 0 ? Math.min(1, done / total) : 0;
  return (
    <>
      {text ? (
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p aria-live="polite" className="text-base font-semibold tabular-nums text-fg-strong">
            {text}
            {meta ? <span className="font-normal text-fg-muted"> · {meta}</span> : null}
          </p>
          {aside}
        </div>
      ) : null}
      <div data-art-host="" className="wl-buddy-room relative [--wl-buddy-room:3.5rem]">
        <span
          aria-hidden
          className="absolute top-0 h-1.5 w-0 motion-safe:transition-[left] motion-safe:duration-(--wl-dur-enter) motion-safe:ease-(--wl-ease-move)"
          style={{ left: `${share * 100}%` }}
        >
          {buddy ? <Buddy scene={scene} size="sm" /> : null}
        </span>
        <ProgressBar
          label={label}
          value={done}
          max={Math.max(total, 1)}
          valueText={text}
          tone="foil"
        />
      </div>
    </>
  );
}
