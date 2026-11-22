import { cn } from '../../../lib/cn.ts';
import { formatCount } from '../../../lib/format.ts';

export interface RolloutSegment {
  key: string;
  label: string;
  count: number;
  /** Segment and legend dot colour, as a background class. */
  fill: string;
}

/** Colours of the versions still on their way, in order; the release is green and the left behind amber. */
export const OLD_VERSION_FILLS = ['bg-fg-muted', 'bg-info', 'bg-accent'] as const;

/**
 * One bar split by version: a labelled segment for the release, one for each version still moving and
 * one for the passes left behind, with a legend of the same colours. The bar is the progress bar:
 * its value is the passes on the release.
 */
export function RolloutBar({
  segments,
  value,
  total,
}: {
  segments: readonly RolloutSegment[];
  value: number;
  total: number;
}) {
  const shown = segments.filter((s) => s.count > 0);
  return (
    <div className="grid gap-2">
      <div
        role="progressbar"
        aria-label="Passes on the release"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={value}
        aria-valuetext={`${formatCount(value)} of ${formatCount(total)} passes`}
        className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-surface-sunken"
      >
        {shown.map((s) => (
          <span
            key={s.key}
            data-segment={s.key}
            title={`${s.label} · ${formatCount(s.count)}`}
            className={cn(
              'h-full min-w-1 motion-safe:transition-[flex-grow] motion-safe:duration-(--wl-dur-enter)',
              s.fill,
            )}
            style={{ flexGrow: s.count, flexBasis: 0 }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
        {shown.map((s) => (
          <li key={s.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={cn('size-2 rounded-full', s.fill)} />
            {s.label} · <b className="font-medium text-fg-strong">{formatCount(s.count)}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}
